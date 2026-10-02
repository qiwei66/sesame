import { readdir, stat, readFile, writeFile, mkdir, chmod, rename, open, unlink } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { tmpPathFor } from './fsutil.ts';
import { classify, htmlTitle, mergeHit, readLinesFrom, scrubText } from './indexer.ts';
import { claudeSource } from './sources/claude.ts';
import { groupCounts, isServiceNoise, refineTitle } from './title-quality.ts';
import type { Group } from './title-quality.ts';
import type { IndexSource } from './sources/types.ts';
import type { FileState, Hit, SavedItem } from './indexer.ts';

export interface IndexPaths {
  indexDir: string;
  /** Claude Code projects dir (shorthand for sources: [claude]) */
  projectsDir?: string;
  /** Transcript sources to scan (src/sources); default = claude at projectsDir */
  sources?: Array<{ source: IndexSource; dir: string }>;
}

interface FileMark { mtimeMs: number; size: number; offset: number; ino?: number }
interface State { version: 1; files: Record<string, FileMark>; lastRun?: string }

export interface IndexStats {
  scannedFiles: number;
  changedFiles: number;
  newBytes: number;
  items: number;
  byKind: Record<string, number>;
  durationMs: number;
  titledLocal: number;
}

/** 文档类产物才收（代码文件不收，避免噪声）；SendUserFile 发过的一律收 */
const DOC_EXT = new Set(['.html', '.htm', '.md', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.mov', '.mp3', '.wav', '.m4a', '.docx', '.xlsx', '.pptx', '.csv', '.stl', '.3mf', '.step', '.svg', '.key', '.numbers', '.pages', '.zip', '.txt']);

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** 先把内容写进 pid 临时文件（不动正式文件），返回提交函数；提交 = rename（原子） */
async function stagePrivate(path: string, data: unknown): Promise<{ commit: () => Promise<void>; discard: () => Promise<void> }> {
  const tmp = tmpPathFor(path);
  await writeFile(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  await chmod(tmp, 0o600);
  return {
    commit: async () => { await rename(tmp, path); await chmod(path, 0o600); },
    discard: async () => { await unlink(tmp).catch(() => {}); },
  };
}

/** 被调用方放弃（按需刷新超时）：不写任何正式文件，相当于回滚 */
export class IndexAborted extends Error {}

export async function fetchTitle(url: string, timeoutMs = 2000): Promise<string | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    const reader = r.body?.getReader();
    if (!reader) return null;
    let buf = '';
    while (buf.length < 64_000) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      if (/<\/title>/i.test(buf)) break;
    }
    await reader.cancel().catch(() => {});
    return htmlTitle(buf);
  } catch {
    return null;
  }
}

async function acquireLock(lockPath: string): Promise<boolean> {
  try {
    const fh = await open(lockPath, 'wx');
    await fh.write(String(process.pid));
    await fh.close();
    return true;
  } catch {
    const pid = Number((await readFile(lockPath, 'utf8').catch(() => '')).trim());
    let alive = false;
    try {
      if (pid) { process.kill(pid, 0); alive = true; }
    } catch {
      alive = false;
    }
    if (alive) return false;
    await unlink(lockPath).catch(() => {});
    return acquireLock(lockPath);
  }
}

/**
 * 跑一次索引。并发安全：
 *  - 同一索引目录同一时刻只有一个 runIndex（index/lock，按 pid 判活回收）；items/titles/state 只有它写
 *  - 中途 signal 被 abort（按需刷新超时）→ 抛 IndexAborted，正式文件一个字节都不动
 *  - 提交阶段：三个文件先全部写成 pid 临时文件，再依次 rename；state.json（记 offset）最后提交——
 *    万一在两次 rename 之间被杀，下次只会把同一段字节重读一遍（mergeHit 按 key 合并），不会丢条目
 */
/** Progress while indexing: files read so far of the total, items found so far (for "正在整理… 1,204 条") */
export interface IndexProgress { phase: 'scan' | 'titles' | 'commit'; filesDone: number; filesTotal: number; items: number; groups?: Record<Group, number> }

export async function runIndex(paths: IndexPaths, opts: { full?: boolean; fetchTitles?: boolean; log?: (s: string) => void; signal?: AbortSignal; onProgress?: (p: IndexProgress) => void } = {}): Promise<IndexStats | null> {
  const checkAbort = () => { if (opts.signal?.aborted) throw new IndexAborted('index run aborted'); };
  const t0 = Date.now();
  const log = opts.log ?? (() => {});
  await mkdir(paths.indexDir, { recursive: true, mode: 0o700 });
  const lockPath = join(paths.indexDir, 'lock');
  if (!(await acquireLock(lockPath))) {
    log('another va-index is running; skip');
    return null;
  }
  try {
    const statePath = join(paths.indexDir, 'state.json');
    const itemsPath = join(paths.indexDir, 'items.json');
    const titlesPath = join(paths.indexDir, 'titles.json');
    const state: State = opts.full ? { version: 1, files: {} } : await readJson<State>(statePath, { version: 1, files: {} });
    const itemArr: SavedItem[] = opts.full ? [] : await readJson<SavedItem[]>(itemsPath, []);
    const items = new Map(itemArr.map((i) => [i.key, i]));
    const titles: Record<string, string> = opts.full ? {} : await readJson<Record<string, string>>(titlesPath, {});

    const sources = paths.sources ?? (paths.projectsDir ? [{ source: claudeSource, dir: paths.projectsDir }] : []);
    const files: string[] = [];
    const sourceOf = new Map<string, IndexSource>();
    for (const { source, dir } of sources) {
      const found: string[] = [];
      await walk(dir, found);
      for (const f of found) {
        if (source.accept && !source.accept(f)) continue;
        if (sourceOf.has(f)) continue;
        sourceOf.set(f, source);
        files.push(f);
      }
    }
    let changed = 0;
    let newBytes = 0;
    const fileHits: Array<{ path: string; ts: string; context: string; caption?: string; sent: boolean; session: string }> = [];
    const progress = (phase: IndexProgress['phase'], filesDone: number) => opts.onProgress?.({ phase, filesDone, filesTotal: files.length, items: items.size, groups: groupCounts(items.values()) });
    let lastTick = 0;
    for (const [fi, f] of files.entries()) {
      checkAbort();
      if (opts.onProgress && Date.now() - lastTick >= 250) { lastTick = Date.now(); progress('scan', fi); }
      let s;
      try {
        s = await stat(f);
      } catch {
        continue;
      }
      const mark = state.files[f];
      if (mark && mark.mtimeMs === s.mtimeMs && mark.size === s.size && (mark.ino === undefined || mark.ino === s.ino)) continue;
      // jsonl 只追加：只读 offset 之后新追加的字节。inode 变了（被替换）或变小了（被截断）→ 从头重读
      const replaced = mark !== undefined && ((mark.ino !== undefined && mark.ino !== s.ino) || s.size < mark.offset);
      const start = mark && !replaced ? mark.offset : 0;
      if (start === s.size) {
        state.files[f] = { mtimeMs: s.mtimeMs, size: s.size, offset: start, ino: s.ino };
        continue;
      }
      changed += 1;
      const st: FileState = { toolInputs: new Map() };
      const src = sourceOf.get(f) ?? claudeSource;
      const session = src.sessionIdOf(f);
      const end = await readLinesFrom(f, start, (line) => {
        const r = src.processLine(line, st);
        for (const h of r.hits) mergeHit(items, { ...h, session });
        for (const [p, t] of r.titles) titles[p] = t;
        for (const fh of r.files) fileHits.push({ ...fh, sent: fh.caption !== undefined, session });
      });
      // 末行可能未写完：offset 只推进到最后一个完整换行（readLinesFrom 按行累计）
      const offset = Math.min(end, s.size);
      newBytes += offset - start;
      state.files[f] = { mtimeMs: s.mtimeMs, size: s.size, offset, ino: s.ino };
    }

    // 文件类：只收仍存在的文档
    for (const fh of fileHits) {
      if (!fh.path.startsWith('/')) continue;
      const ext = extname(fh.path).toLowerCase();
      if (!fh.sent && !DOC_EXT.has(ext)) continue;
      if (!existsSync(fh.path)) continue;
      try {
        if (!statSync(fh.path).isFile()) continue;
      } catch {
        continue;
      }
      const hit: Hit = {
        kind: 'file', url: fh.path, key: `file:${fh.path}`, ts: fh.ts, context: fh.context, session: fh.session,
        title: titles[fh.path] ?? (fh.caption || basename(fh.path)), titleSource: titles[fh.path] ? 'html' : fh.caption ? 'description' : 'filename',
      };
      mergeHit(items, hit);
    }
    // 已消失的文件剔除
    for (const [k, it] of items) if (it.kind === 'file' && !existsSync(it.url)) items.delete(k);

    // Artifact 标题：发布源文件的 <title>（转录里写/读过，或文件仍在盘上）；否则用发布描述
    for (const it of items.values()) {
      if (it.kind !== 'artifact' || it.titleSource === 'html' || it.titleSource === 'publish') continue;
      const p = it.sourcePath;
      let t = p ? titles[p] : undefined;
      if (!t && p && existsSync(p)) {
        try {
          t = htmlTitle((await readFile(p, 'utf8')).slice(0, 20_000)) ?? undefined;
        } catch {
          t = undefined;
        }
      }
      if (t) {
        it.title = t;
        it.titleSource = 'html';
        delete it.fullTitle;
      } else if (!it.title && it.contexts[0]) {
        it.title = it.contexts[0].slice(0, 30);
        it.titleSource = 'description';
      }
    }

    progress('titles', files.length);
    // 本机/内网服务：curl 取 <title>，2 秒超时（只给还没有 fetch 标题的取）
    let titledLocal = 0;
    if (opts.fetchTitles !== false) {
      // 每个服务一天最多试一次（死掉的端口要等满 2 秒超时，别每轮都等）
      const dayAgo = Date.now() - 86_400_000;
      const todo = [...items.values()].filter((i) => i.kind === 'local' && i.titleSource !== 'fetch' && !(i.fetchTriedAt && Date.parse(i.fetchTriedAt) > dayAgo));
      const pool = 16;
      for (let i = 0; i < todo.length; i += pool) {
        await Promise.all(todo.slice(i, i + pool).map(async (it) => {
          it.fetchTriedAt = new Date().toISOString();
          const t = await fetchTitle(it.url);
          if (t) {
            it.title = t;
            it.titleSource = 'fetch';
            delete it.fullTitle;
            titledLocal += 1;
          }
        }));
      }
    }

    // URLs indexed before full-width punctuation ended a link ("…/pull/628（OPEN"): cut the tail, merge into the clean one
    for (const [k, it] of [...items]) {
      if (it.kind !== 'web' || !/%EF%BC%(?:88|89|9A|8C)/i.test(it.url)) continue;
      const c = classify(it.url.replace(/%EF%BC%(?:88|89|9A|8C).*$/i, ''));
      items.delete(k);
      if (!c) continue;
      const cur = items.get(c.key);
      if (cur) {
        cur.count += it.count;
        if (it.lastSeen > cur.lastSeen) cur.lastSeen = it.lastSeen;
        if (it.firstSeen && it.firstSeen < cur.firstSeen) cur.firstSeen = it.firstSeen;
      } else {
        items.set(c.key, { ...it, key: c.key, url: c.url, variants: [c.url] });
      }
    }
    for (const [k, it] of items) {
      // indexes built before the noise rules: drop proxies / debug ports / API endpoints on every run
      if (it.kind === 'local') {
        let noise = false;
        try { noise = isServiceNoise(new URL(it.url)); } catch { noise = false; }
        if (noise) { items.delete(k); continue; }
      }
      it.title = scrubText(it.title);
      it.contexts = it.contexts.map(scrubText);
      // generic labels ("PR", "链接") get a real name; sentences are cut to their main part (idempotent)
      // a title cut earlier keeps its original in fullTitle: refine from the original so repeated runs agree
      const r = refineTitle(it.fullTitle ? { ...it, title: it.fullTitle } : it);
      it.title = r.title;
      if (r.full) it.fullTitle = r.full;
      else delete it.fullTitle;
      if (r.weak) it.weakTitle = true;
      else delete it.weakTitle;
    }
    computeSessionKeywords([...items.values()]);

    const out = [...items.values()].sort((a, b) => (b.lastSeen > a.lastSeen ? 1 : -1));
    state.lastRun = new Date().toISOString();
    progress('commit', files.length);
    checkAbort();
    const staged = [await stagePrivate(itemsPath, out), await stagePrivate(titlesPath, titles), await stagePrivate(statePath, state)];
    if (opts.signal?.aborted) {
      for (const st of staged) await st.discard();
      throw new IndexAborted('index run aborted before commit');
    }
    // 提交点：此后不再响应 abort（三次 rename 是毫秒级）
    for (const st of staged) await st.commit();
    const byKind: Record<string, number> = {};
    for (const it of out) byKind[it.kind] = (byKind[it.kind] ?? 0) + 1;
    return { scannedFiles: files.length, changedFiles: changed, newBytes, items: out.length, byKind, durationMs: Date.now() - t0, titledLocal };
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}

/**
 * 每条记录的「同会话主题词」：同一会话里、首次出现时间相差 ≤3 小时的其它记录标题，按时间远近排，≤200 字。
 * 长寿主会话里话题很多，只取时间上挨着的，避免把不相干的主题拼进来。文件名类标题不算。
 */
export function computeSessionKeywords(all: SavedItem[]): void {
  const bySession = new Map<string, SavedItem[]>();
  for (const it of all) {
    for (const s of it.sessions ?? []) {
      const arr = bySession.get(s) ?? [];
      arr.push(it);
      bySession.set(s, arr);
    }
  }
  const WINDOW = 3 * 3600_000;
  const COMMON_DIRS = new Set(['Users', basename(homedir()), 'dev', 'private', 'tmp', 'scratchpad', 'launch', 'docs', 'src', 'out', 'dist', 'build', 'public', 'Desktop', 'Documents', 'Downloads', 'claude-501', 'subagents']);
  const dirTitles = new Map<string, string[]>();
  for (const f of all) {
    if (f.kind !== 'file' || !f.title || f.titleSource === 'filename') continue;
    for (const seg of f.url.split('/').slice(0, -1)) {
      if (seg.length < 4 || COMMON_DIRS.has(seg) || seg.startsWith('-')) continue;
      const arr = dirTitles.get(seg) ?? [];
      if (arr.length < 8 && !arr.includes(f.title)) arr.push(f.title);
      dirTitles.set(seg, arr);
    }
  }
  for (const it of all) {
    const t0 = Date.parse(it.firstSeen);
    const near: Array<{ d: number; title: string }> = [];
    for (const s of it.sessions ?? []) {
      for (const o of bySession.get(s) ?? []) {
        if (o === it || !o.title || o.titleSource === 'filename' || o.title === it.title) continue;
        const d = Math.abs(Date.parse(o.firstSeen) - t0);
        if (Number.isFinite(d) && d <= WINDOW) near.push({ d, title: o.title });
      }
    }
    near.sort((x, y) => x.d - y.d);
    const words: string[] = [];
    let len = 0;
    for (const n of near) {
      if (words.includes(n.title)) continue;
      if (len + n.title.length > 200) break;
      words.push(n.title);
      len += n.title.length + 1;
    }
    // 项目目录关联：上下文里提到某个项目目录名（如 d2-local），就带上该目录下文档的标题（如「门店预约与 AI 客服 · 价目」）
    const proj: string[] = [];
    if (it.kind !== 'file') {
      const ctx = it.contexts.join(' ');
      for (const tok of ctx.match(/[A-Za-z0-9][A-Za-z0-9_-]{3,}/g) ?? []) {
        for (const t of dirTitles.get(tok) ?? []) if (!proj.includes(t) && t !== it.title) proj.push(t);
      }
    }
    const kw = scrubText([...proj.slice(0, 4), ...words].join(' ')).slice(0, 260);
    if (kw) it.sessionKeywords = kw;
    else delete it.sessionKeywords;
  }
}

export { scrubText };
