/**
 * Index title clean-up and grouping (WO-20261002-041, audit P1-2).
 *  - refineTitle: generic labels ("PR", "链接", "Source", ".md") get a real name from the URL or the surrounding
 *    words; a whole sentence used as a title is cut to its main part. Titles that cannot be fixed are marked
 *    `weakTitle` and ranked lower by retrieval (src/saved.ts).
 *  - isServiceNoise: this machine's proxies, debug ports and model APIs are not artifacts the user made.
 *  - groupOf / groupCounts: the first-run panel's six counts (dashboards, reports, decks, sites, PRs, files).
 *  - pickSample: the first-run "try: open …" example, picked from the user's own recent items.
 * Pure functions, no I/O.
 */
import { homedir, tmpdir } from 'node:os';
import type { SavedItem } from './indexer.ts';

// ───────────────────────── service noise ─────────────────────────

/** Local ports that are infrastructure, not something the user built: proxies, debug ports, model and control APIs */
export const NOISE_PORTS = new Set([
  1080, 1087, 6152, 6153, 7890, 7891, 7892, 7893, 7897, 7898, 7899, 8118, 9090, 9097, // proxies and their controllers
  17890, 17891, 17892, 17893, 17897, // second proxy instances
  9222, 9223, 9229, // Chrome DevTools / node inspector
  11434, 1234, // Ollama / LM Studio model APIs
]);

/** Paths on a local service that are an API endpoint, not a page */
const LOCAL_API_PATH = /^\/(?:v\d+(?:\/|$)|api\/|functions\/v\d|json(?:\/|$)|proxies(?:\/|$)|rpc(?:\/|$)|graphql(?:\/|$)|health(?:z)?(?:\/|$))/i;

/** A local / tailnet URL that should not be in the index at all */
export function isServiceNoise(u: URL): boolean {
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (NOISE_PORTS.has(port)) return true;
  if (port < 1024 && port !== 80 && port !== 443) return true; // 127.0.0.1:1 and the like: test strings, not services
  return LOCAL_API_PATH.test(u.pathname);
}

// ───────────────────────── titles ─────────────────────────

/** Labels that say what kind of thing it is, not which one ("PR", "链接", "Source") */
const GENERIC_TITLES = new Set([
  'pr', 'prs', 'link', 'links', 'url', 'source', 'sources', 'src', 'here', 'this', 'page', 'site', 'repo', 'docs', 'doc', 'issue', 'commit',
  'from', 'default', 'open', 'click', 'demo', 'preview', 'md', 'html', 'file', 'image', 'screenshot', 'result', 'results', 'note', 'notes',
  '链接', '来源', '原文', '出处', '入口', '打开', '仓库', '源', '页面', '网页', '地址', '这里', '点这里', '文档', '截图', '预览', '结果', '详情',
  '评论', '做了什么', '另外', '然后', '左', '右', '上', '下', '注', '备注', '参考', '见', '如下', '本机', '线上', '链接如下',
]);

/** Leading words that announce a title rather than being part of it ("另外：", "来源：知乎") */
const LABEL_PREFIX = /^(?:另外|然后|注|备注|参考|来源|出处|原文|链接|入口|地址|做了什么|左|右|见|source|link|url|from|see)\s*[:：]\s*/i;

const PAIRS: Array<[string, string]> = [['「', '」'], ['『', '』'], ['（', '）'], ['(', ')'], ['【', '】'], ['[', ']'], ['“', '”']];

/** Brackets whose partner was cut off: drop a stray closer, and an opener left at either end ("我的」页" → "我的页", "（来源" → "来源") */
const unpaired = (s: string): string => {
  let t = s;
  for (const [o, c] of PAIRS) {
    const n = (x: string) => t.split(x).length - 1;
    if (n(c) > n(o)) t = t.split(c).join('');
    if (n(o) > n(c)) {
      if (t.startsWith(o)) t = t.slice(o.length);
      else if (t.endsWith(o)) t = t.slice(0, -o.length);
    }
  }
  return t;
};

const EDGE_START = /^[\s·•\-–—*_`#>|:：,，。；;"']+/u;
const EDGE_END = /[\s·•\-–—*_`#>|:：,，。；;"'✅✓]+$/u;

const strip = (s: string): string => {
  let t = s.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, ' ').replace(/\s{2,}/g, ' ');
  for (let k = 0; k < 3; k++) t = unpaired(t.replace(EDGE_START, '').replace(EDGE_END, '')).trim();
  return t;
};

/** "PR", "（来源", "default(", ".md", "打开 👉": no name in it */
export function isGenericTitle(t: string): boolean {
  const s = strip(t).toLowerCase().replace(/^\.+/, '').replace(/\($/, '').trim();
  if (!s) return true;
  if (GENERIC_TITLES.has(s)) return true;
  // only digits / punctuation, or a single letter/character
  return (s.match(/[\p{Script=Han}\p{L}]/gu) ?? []).length < 2;
}

/** Name for a GitHub pull request / issue / commit URL: "my-app PR #12" */
export function githubName(url: string): string | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/[^/]+\/([^/]+)\/(pull|issues|commit)\/([0-9a-f]+)/i.exec(url);
  if (!m) return null;
  const kind = m[2] === 'pull' ? 'PR' : m[2] === 'issues' ? 'issue' : 'commit';
  const id = m[2] === 'commit' ? m[3].slice(0, 7) : `#${m[3]}`;
  return `${m[1]} ${kind} ${id}`;
}

/** Sentence used as a title → its main part: split on 。；, drop a label before ：, then cut at the first ，( if still long */
export function trunk(t: string): string {
  let s = strip(t);
  s = s.split(/[。；;！!？?\n]/)[0] ?? s;
  // "做了什么 ：PR #602" → "PR #602"; "另外：外网入口是 X" → "外网入口是 X"; "备案状态：用" keeps the part before ：
  const parts = s.split(/\s*[:：]\s*/).map(strip).filter(Boolean);
  if (parts.length > 1) {
    const named = parts.filter((p) => !isGenericTitle(p) && !LABEL_PREFIX.test(`${p}：`));
    s = named.find((p) => p.length >= 4) ?? named[0] ?? parts[0];
  }
  s = strip(s.replace(LABEL_PREFIX, ''));
  const han = /\p{Script=Han}/u.test(s);
  if (s.length > (han ? 16 : 32)) {
    const head = strip(s.split(/[，,（(—–]|\s-\s|——/)[0] ?? '');
    if (head.length >= 4) s = head;
  }
  const max = han ? 30 : 48;
  if (s.length > max) s = `${s.slice(0, max).trim()}…`;
  return s;
}

/**
 * The words just before a generic label in the context usually are the real name:
 * "The Matrioshka Fee Machine Behind the Capital 2026-05-13 · link" → "The Matrioshka Fee Machine Behind the Capital".
 */
export function nameFromContext(contexts: string[], label: string): string | null {
  const l = strip(label).toLowerCase();
  if (!l) return null;
  for (const c of contexts) {
    const i = c.toLowerCase().lastIndexOf(l);
    if (i <= 0) continue;
    let before = c.slice(Math.max(0, i - 80), i);
    before = before.replace(/[·\-–—|:：\s]+$/u, '').replace(/\d{4}-\d{2}-\d{2}$/, '').replace(/[·\-–—|:：\s]+$/u, '');
    const seg = before.split(/\s[·\-–—|]\s|[。；;！？!?]/).pop() ?? '';
    const words = strip(seg).split(/\s+/);
    // keep the last ≤6 words (the name sits right before the label)
    const cand = strip(words.slice(-6).join(' '));
    const letters = (cand.match(/[\p{Script=Han}\p{L}]/gu) ?? []).length;
    // Chinese contexts are keyword soup (punctuation already stripped): only trust Latin-script names here
    const latin = (cand.match(/[A-Za-z]/g) ?? []).length;
    if (latin < letters * 0.6) continue;
    if (cand.length >= 4 && cand.length <= 48 && letters >= 4 && !isGenericTitle(cand) && !/[=$|]|--/.test(cand)) return cand;
  }
  return null;
}

/** `full`: the longer original when the title was cut to its main part (still matched by search, never shown) */
export interface RefinedTitle { title: string; weak: boolean; full?: string }

/** Clean up one item's title. Idempotent: refining a refined title changes nothing. */
/** "@张三 @李四 定价框架 v1 写好了" → "定价框架 v1 写好了" (mentions are who it was sent to, not what it is) */
export function stripMentions(t: string): string {
  return t.replace(/(^|[\s(（【「])@[\p{L}\p{N}_.\-]+/gu, '$1').replace(/\s{2,}/g, ' ').trim();
}

export function refineTitle(it: Pick<SavedItem, 'title' | 'url' | 'kind' | 'contexts' | 'titleSource'>): RefinedTitle {
  const raw = stripMentions((it.title ?? '').trim());
  const gh = it.kind === 'web' ? githubName(it.url) : null;
  if (!raw || isGenericTitle(raw)) {
    if (gh) return { title: gh, weak: false };
    if (it.kind === 'file') {
      const name = it.url.split('/').filter(Boolean).pop() ?? '';
      return { title: name, weak: false };
    }
    const fromCtx = raw ? nameFromContext(it.contexts ?? [], raw) : null;
    if (fromCtx) return { title: trunk(fromCtx), weak: false };
    return { title: '', weak: true };
  }
  // page <title>, publish titles and fetched titles are names already; only very long ones get cut
  const trusted = it.titleSource === 'html' || it.titleSource === 'publish' || it.titleSource === 'fetch';
  const t = trusted && raw.length <= 30 ? raw : trunk(raw);
  if (!t || isGenericTitle(t)) return gh ? { title: gh, weak: false } : { title: '', weak: true };
  return t !== raw ? { title: t, weak: false, full: raw.slice(0, 200) } : { title: t, weak: false };
}

// ───────────────────────── made by the AI vs. mentioned ─────────────────────────

/** Hosts where something the AI deployed lives (preview / static hosting / tunnels) */
const DEPLOY_HOST = /\.(?:vercel\.app|netlify\.app|pages\.dev|workers\.dev|github\.io|fly\.dev|onrender\.com|surge\.sh|railway\.app|aiforce\.cloud|ts\.net|trycloudflare\.com|ngrok(?:-free)?\.app|loca\.lt)$/i;
/** Hosts where the AI creates documents (Feishu / Google Docs / Notion) */
const DOC_HOST = /(?:^|\.)(?:feishu\.cn|larksuite\.com|docs\.google\.com|notion\.so|yuque\.com)$/i;
const DEPLOY_WORDS = /部署|上线|发布|已推|推到|deploy|deployed|published|preview|预览|上生产/i;
const CREATE_WORDS = /已建好|建好|已创建|创建了|新建|建档|已发|写好|生成|created|published/i;
const PR_WORDS = /开了?\s*PR|PR\s*(?:已|开|ready|open|squash)|已开|已推|推送|已挂|挂上|automerge|auto-merge|gh pr create|完工|已合并|合入|opened|created|merged|commit/i;

/**
 * Did the AI make this (a page it published, a service it ran, a file it wrote or sent, a PR it opened, a site it
 * deployed, a doc it created)? Links that were only mentioned or read (news, docs, other people's repos) are not.
 * Local services, Claude artifacts and files come only from the AI's own work (src/indexer.ts); web links need
 * a host where the AI publishes AND words in the surrounding text saying it did.
 */
export function madeByAI(it: Pick<SavedItem, 'kind' | 'url' | 'contexts'> & { title?: string }): boolean {
  if (it.kind !== 'web') return true;
  let host = '';
  try { host = new URL(it.url).hostname; } catch { return false; }
  const ctx = (it.contexts ?? []).join(' ');
  if (/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(it.url)) return PR_WORDS.test(`${ctx} ${it.title ?? ''}`);
  if (DEPLOY_HOST.test(host)) return DEPLOY_WORDS.test(ctx);
  if (DOC_HOST.test(host) && /\/(?:docx|docs|base|wiki|sheets|document|d)\//.test(it.url)) return CREATE_WORDS.test(ctx);
  return false;
}

/** Agent work files: briefs, hand-offs, audits and reports an agent wrote for another agent, or anything under temp /
 *  scratchpad / ~/.claude* / ~/.codex*. Still searchable, but not counted as something made for the user. */
const WORK_FILE_NAME = /(?:^|[-_.\s])(?:brief|briefs|handoff|hand-off|audit|report|pr-body|prbody|workorder|work-order|status|notes?|plan)(?:[-_.\s\d]|$)[^/]*\.(?:md|txt|json)$|^(?:brief|handoff|audit|report)[^/]*\.(?:md|txt)$/i;
export function isAgentWorkFile(it: Pick<SavedItem, 'kind' | 'url'>, home: string = homedir(), tmp: string = process.env.TMPDIR || tmpdir()): boolean {
  if (it.kind !== 'file') return false;
  const p = it.url;
  const under = (dir: string) => !!dir && (p === dir || p.startsWith(dir.endsWith('/') ? dir : `${dir}/`));
  if (under('/private/tmp') || under('/tmp') || under('/private/var/folders') || under(tmp.replace(/\/+$/, ''))) return true;
  if (p.includes('/scratchpad/')) return true;
  if (home && (p.startsWith(`${home}/.claude`) || p.startsWith(`${home}/.codex`))) return true;
  const name = p.split('/').pop() ?? '';
  return WORK_FILE_NAME.test(name);
}

/** What the first-run counts and the default live list show: made by the AI for the user (not agent work files) */
export function isProduct(it: Pick<SavedItem, 'kind' | 'url' | 'contexts'>): boolean {
  return madeByAI(it) && !isAgentWorkFile(it);
}

// ───────────────────────── first-run groups ─────────────────────────

export type Group = 'dashboard' | 'report' | 'deck' | 'site' | 'pr' | 'file';
export const GROUPS: readonly Group[] = ['dashboard', 'report', 'deck', 'site', 'pr', 'file'];

const DASH_RE = /看板|大盘|仪表盘|面板|监控|dashboard|board|console|monitor/i;
const REPORT_RE = /报告|周报|日报|月报|复盘|纪要|分析|调研|研究|总结|方案|手册|report|review|analysis|memo|summary|brief/i;
const DECK_RE = /\bppt\b|幻灯|演示稿|slides?\b|deck\b|keynote/i;

/** Which of the six first-run groups an item counts in (every item lands in exactly one) */
export function groupOf(it: Pick<SavedItem, 'kind' | 'url' | 'title'>): Group {
  const t = it.title ?? '';
  if (it.kind === 'web' && /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(it.url)) return 'pr';
  if (/\.(pptx?|key)$/i.test(it.url) || DECK_RE.test(t)) return 'deck';
  if (it.kind === 'local' || DASH_RE.test(t)) return 'dashboard';
  if (REPORT_RE.test(t) || (it.kind === 'file' && /\.(md|pdf|docx?)$/i.test(it.url))) return 'report';
  if (it.kind === 'web' || it.kind === 'artifact') return 'site';
  return 'file';
}

/** First-run counts: only what the AI made (madeByAI); links that were just mentioned are searchable but not counted */
export function groupCounts(items: Iterable<Pick<SavedItem, 'kind' | 'url' | 'title' | 'contexts'>>): Record<Group, number> {
  const out: Record<Group, number> = { dashboard: 0, report: 0, deck: 0, site: 0, pr: 0, file: 0 };
  for (const it of items) if (isProduct(it)) out[groupOf(it)] += 1;
  return out;
}

export function madeCount(items: Iterable<Pick<SavedItem, 'kind' | 'url' | 'contexts'>>): number {
  let n = 0;
  for (const it of items) if (isProduct(it)) n += 1;
  return n;
}

// ───────────────────────── first-run sample ─────────────────────────

const SAMPLE_RE = /看板|大盘|仪表盘|报告|周报|复盘|页面|主页|官网|dashboard|report|page|board/i;

/** A title clean enough to show as "try: open <title>": short, a name, no paths/ids/sentences */
export function isCleanTitle(t: string): boolean {
  if (t.length < 2 || t.length > 16) return false;
  if (isGenericTitle(t)) return false;
  if (/[\/\\:：，,。;；|=$@#<>{}()（）[\]…"'`]|https?|\.\w{2,4}$/.test(t)) return false;
  if (/\d{3,}|[A-Za-z0-9_-]{12,}/.test(t)) return false; // ids, ports, hashes
  return true;
}

/**
 * The first-run example: seen in the last 7 days, a clean title that looks like a dashboard / report / page.
 * Pages made by Claude (artifact) and local services rank above web pages and files. null = show no example.
 */
export function pickSample<T extends Pick<SavedItem, 'kind' | 'url' | 'title' | 'lastSeen' | 'count' | 'contexts'> & { weakTitle?: boolean }>(items: Iterable<T>, now: Date = new Date()): T | null {
  const since = now.getTime() - 7 * 86_400_000;
  let best: { it: T; score: number } | null = null;
  for (const it of items) {
    if (it.weakTitle || !isCleanTitle(it.title) || !isProduct(it)) continue;
    const seen = Date.parse(it.lastSeen);
    if (!Number.isFinite(seen) || seen < since) continue;
    const word = SAMPLE_RE.test(it.title);
    const kindRank = it.kind === 'artifact' || it.kind === 'local' ? 1 : 0;
    if (!word && !kindRank) continue;
    const score = (word ? 2 : 0) + kindRank + Math.min(1, Math.log2(1 + it.count) / 4) + (seen - since) / (7 * 86_400_000) * 0.5;
    if (!best || score > best.score) best = { it, score };
  }
  return best?.it ?? null;
}
