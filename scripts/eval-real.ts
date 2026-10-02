/**
 * `npm run eval:real`: retrieval eval on YOUR real index (nothing personal lives in the repo).
 *
 *  - answers: <config dir>/eval-real.json (VA_EVAL_FILE overrides), hand-labelled:
 *      { "now": "2026-10-03T10:00:00+08:00",
 *        "queries": [ { "q": "<a sentence you would say>", "expect": "<item key>" | null, "accept": ["<other key>"], "set": "wo041", "why": "…" } ] }
 *    expect null = the right answer is "nothing found" (the index really has no such thing).
 *  - index: the one your config points at (resolvePaths: VA_INDEX_DIR > config index_dir > data dir). It is COPIED to a
 *    temp dir first (items first seen after `now` are dropped); the original is only read.
 *  - the core runs as `serve --stdio`, every sentence goes through `handle` with dryRun; the model key points at an
 *    empty env var, so only the local path runs (no paid model, no network). The clock is shifted to `now`.
 *
 * A query is correct when the core opens the expected item (or one in `accept`), or, for expect null, opens nothing
 * and offers no candidates.
 *
 * usage: node scripts/eval-real.ts [--core <repo root>] [--json <out.json>] [--label <name>]
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir, loadConfig, resolvePaths } from '../src/config.ts';

interface Query { q: string; expect: string | null; accept?: string[]; set?: string; why?: string }
interface Answers { now: string; queries: Query[] }
interface Opened { key?: string; title: string; kind: string }
interface HandleResult { opened: Opened | null; candidates: Array<Opened & { key: string }>; result: string; layer: string }

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const arg = (name: string): string | undefined => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const core = resolve(arg('--core') ?? REPO);
const label = arg('--label') ?? (core === REPO ? 'current' : core);

const cfgDir = configDir();
const answersPath = process.env.VA_EVAL_FILE || join(cfgDir, 'eval-real.json');
if (!existsSync(answersPath)) {
  process.stderr.write(`no answers file: ${answersPath}\n(create it: see the header of scripts/eval-real.ts)\n`);
  process.exit(2);
}
const answers = JSON.parse(readFileSync(answersPath, 'utf8')) as Answers;
const cfg = loadConfig(cfgDir);
const { indexDir } = resolvePaths(cfg, REPO, process.env, homedir());
const nowMs = Date.parse(answers.now);
if (!Number.isFinite(nowMs)) { process.stderr.write(`answers.now is not a date: ${answers.now}\n`); process.exit(2); }

// ── sandbox: copied index, config without the model key, temp logs / cache ──
const work = mkdtempSync(join(tmpdir(), 'sesame-eval-'));
const idx = join(work, 'index');
mkdirSync(idx, { recursive: true });
const items = JSON.parse(readFileSync(join(indexDir, 'items.json'), 'utf8')) as Array<{ key: string; title: string; firstSeen: string; kind: string }>;
const snapshot = items.filter((i) => !(Date.parse(i.firstSeen) > nowMs));
writeFileSync(join(idx, 'items.json'), JSON.stringify(snapshot));
for (const f of ['aliases.json', 'titles.json']) if (existsSync(join(indexDir, f))) copyFileSync(join(indexDir, f), join(idx, f));
const byKey = new Map(items.map((i) => [i.key, i]));

/** The user's config with the model block replaced (key → an env var that is never set) and paths removed */
function sandboxConfig(src: string): string {
  const drop = new Set(['provider', 'providers', 'index_dir', 'log_dir', 'data_dir']);
  const out: string[] = [];
  let skipping = false;
  for (const line of src.split('\n')) {
    const top = /^([A-Za-z_][\w-]*)\s*:/.exec(line);
    if (top) skipping = drop.has(top[1]);
    else if (/^\S/.test(line)) skipping = false;
    if (!skipping) out.push(line);
  }
  out.push('provider: deepseek', 'providers:', '  deepseek:', '    key:', '      - env: SESAME_EVAL_NO_KEY', '');
  return out.join('\n');
}
const cfgOut = join(work, 'config');
mkdirSync(cfgOut, { recursive: true });
const userCfg = join(cfgDir, 'config.yaml');
writeFileSync(join(cfgOut, 'config.yaml'), sandboxConfig(existsSync(userCfg) ? readFileSync(userCfg, 'utf8') : ''));
if (existsSync(join(cfgDir, 'commands.yaml'))) copyFileSync(join(cfgDir, 'commands.yaml'), join(cfgOut, 'commands.yaml'));

const env: NodeJS.ProcessEnv = { ...process.env };
for (const k of Object.keys(env)) if (/API_KEY$|^VA_KEY_FILE$|^VA_PROVIDER$|^VA_BASE_URL$|^VA_MODEL$|^VA_INDEX_DIR$|^VA_LOG_DIR$/.test(k)) delete env[k];
Object.assign(env, {
  VA_CONFIG_DIR: cfgOut, VA_INDEX_DIR: idx, VA_LOG_DIR: join(work, 'logs'), VA_CACHE_FILE: join(work, 'cache.json'),
  VA_REFRESH_TIMEOUT_MS: '1', SESAME_EVAL_NOW: answers.now, SESAME_EVAL_NO_KEY: '',
});

// ── run every query through handle (dryRun), one at a time ──
const child = spawn(process.execPath, ['--no-warnings', '--import', join(HERE, 'eval', 'fixed-clock.ts'), join(core, 'src', 'cli.ts'), 'serve', '--stdio'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', (d) => { stderr += String(d); });
const waiting = new Map<number, (r: HandleResult) => void>();
let buf = '';
child.stdout.on('data', (d) => {
  buf += String(d);
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const m = JSON.parse(line) as { id: number; result?: HandleResult; error?: { message: string } };
    const cb = waiting.get(m.id);
    waiting.delete(m.id);
    cb?.(m.result ?? { opened: null, candidates: [], result: `error: ${m.error?.message}`, layer: 'error' });
  }
});
let nextId = 0;
const handle = (text: string): Promise<HandleResult> => new Promise((res) => {
  const id = ++nextId;
  waiting.set(id, res);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'handle', params: { text, dryRun: true } })}\n`);
});

const name = (key: string | null | undefined): string => {
  if (!key) return '没找到';
  const it = byKey.get(key);
  return it ? `${it.title || '(无标题)'} [${it.kind}]` : key;
};
const cut = (s: string, n = 26): string => (s.length > n ? `${s.slice(0, n)}…` : s);

interface Row { n: number; q: string; set?: string; expect: string; actual: string; ok: boolean; how: string }
const rows: Row[] = [];
for (const [k, q] of answers.queries.entries()) {
  const r = await handle(q.q);
  const okKeys = new Set([q.expect, ...(q.accept ?? [])].filter(Boolean) as string[]);
  const openedKey = r.opened?.key ?? null;
  let ok: boolean;
  let actual: string;
  let how: string;
  if (r.opened) { actual = `打开 ${name(openedKey) === openedKey ? r.opened.title : name(openedKey)}`; how = 'open'; ok = q.expect !== null && openedKey !== null && okKeys.has(openedKey); }
  else if (r.candidates.length) { actual = `候选 ${r.candidates.length}：${r.candidates.slice(0, 3).map((c) => cut(c.title, 14)).join(' / ')}`; how = 'candidates'; ok = false; }
  else { actual = '没找到'; how = 'none'; ok = q.expect === null; }
  rows.push({ n: k + 1, q: q.q, set: q.set, expect: q.expect === null ? '应回答没找到' : name(q.expect) + (q.accept?.length ? ` (或 ${q.accept.map(name).join('、')})` : ''), actual, ok, how });
}
child.stdin.end();
await new Promise((r) => child.on('close', r));
rmSync(work, { recursive: true, force: true });

// ── report ──
const pad = (s: string, w: number): string => { let len = 0; for (const ch of s) len += /[ᄀ-￿]/.test(ch) ? 2 : 1; return s + ' '.repeat(Math.max(1, w - len)); };
console.log(`eval:real · core=${label} · answers=${answersPath} · now=${answers.now} · index items=${snapshot.length}`);
console.log(`${pad('#', 4)}${pad('查询', 34)}${pad('期望', 40)}${pad('实际', 44)}结果`);
for (const r of rows) console.log(`${pad(String(r.n), 4)}${pad(cut(r.q, 30), 34)}${pad(cut(r.expect, 36), 40)}${pad(cut(r.actual, 40), 44)}${r.ok ? '✓' : '✗'}`);
const score = (f: (r: Row) => boolean) => { const s = rows.filter(f); return `${s.filter((r) => r.ok).length}/${s.length}`; };
const orig = rows.filter((r) => r.set === 'wo041');
console.log(`\n正确：${score(() => true)}（直接打开正确项或正确回答没找到）`);
if (orig.length) console.log(`原 14 条（WO-034/041）：正确 ${score((r) => r.set === 'wo041')}，其中直接打开正确项 ${orig.filter((r) => r.ok && r.how === 'open').length}/${orig.length}`);
console.log(`直接打开正确项：${rows.filter((r) => r.ok && r.how === 'open').length} · 正确回答没找到：${rows.filter((r) => r.ok && r.how === 'none').length} · 打开了错的：${rows.filter((r) => !r.ok && r.how === 'open').length} · 只给了候选：${rows.filter((r) => r.how === 'candidates').length} · 该找到却说没找到：${rows.filter((r) => !r.ok && r.how === 'none').length}`);
const out = arg('--json');
if (out) writeFileSync(out, JSON.stringify({ core: label, now: answers.now, rows }, null, 1));
if (/Error|未捕获/.test(stderr)) process.stderr.write(stderr.split('\n').filter((l) => /Error|未捕获/.test(l)).slice(0, 5).join('\n') + '\n');
