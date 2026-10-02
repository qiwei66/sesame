/**
 * va-index 的 Claude Code 解析器：~/.claude/projects/**\/*.jsonl（含 subagents）里出现过的（其它来源见 src/sources/）
 *   (a) claude.ai Artifact 链接  (b) http/https 链接（含本机/内网/Tailscale）  (c) Write / SendUserFile 产出的文件
 * 纯脚本、零模型调用；按文件 mtime/size 增量（jsonl 只追加，从上次 offset 续读）。
 * 密钥铁律：带密钥参数的 URL 去掉查询串并标记 needsAuth；上下文与标题里的密钥样式片段一律抹掉。
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { getConfig } from './config.ts';
import { isServiceNoise } from './title-quality.ts';

export type ItemKind = 'artifact' | 'local' | 'web' | 'file';

export interface SavedItem {
  key: string;
  kind: ItemKind;
  /** 打开用的首选地址（local 优先 127.0.0.1） */
  url: string;
  /** 同一服务见过的各种地址（已脱敏） */
  variants: string[];
  title: string;
  titleSource: 'html' | 'publish' | 'fetch' | 'markdown' | 'context' | 'filename' | 'description' | '';
  /** 出现位置前后的中文/字母关键词片段（≤3 段） */
  contexts: string[];
  count: number;
  firstSeen: string;
  lastSeen: string;
  needsAuth?: boolean;
  /** 上次尝试 curl 取标题的时间（本机服务） */
  fetchTriedAt?: string;
  /** artifact 发布时对应的本地文件（用于取 <title>） */
  sourcePath?: string;
  /** 出现过的会话 id（最多 5 个） */
  sessions?: string[];
  /** 同一会话里其它产物的标题（主题词），检索时参与打分：同一对话里出现的产物共享主题 */
  sessionKeywords?: string;
  /** title is a generic label we could not replace ("PR", "链接"): ranked lower (src/title-quality.ts) */
  weakTitle?: boolean;
  /** the original long title when `title` was cut to its main part: matched by search, never shown */
  fullTitle?: string;
}

export interface Hit {
  kind: ItemKind;
  url: string;
  key: string;
  title?: string;
  titleSource?: SavedItem['titleSource'];
  context: string;
  ts: string;
  needsAuth?: boolean;
  sourcePath?: string;
  session?: string;
}

/** 会话 id：…/<session>.jsonl 或 …/<session>/subagents/agent-x.jsonl → <session> */
export function sessionIdOf(path: string): string {
  const m = /([^/]+)\/subagents\/[^/]+\.jsonl$/.exec(path);
  if (m) return m[1];
  return (path.split('/').pop() ?? path).replace(/\.jsonl$/, '');
}

// ───────────────────────── 脱敏 ─────────────────────────

const SECRET_PARAM = /^(?:.*_)?(?:token|key|k|secret|sig|signature|auth|authorization|password|pwd|pass|ticket|session|sid|code|credential|apikey|access_token|refresh_token)$/i;

/** 抹掉文本里的密钥样式片段（上下文、标题都要过） */
export function scrubText(s: string): string {
  return s
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, ' ')
    .replace(/\b(?:token|key|k|secret|sig|password|pwd|apikey|api_key|access_token)\s*[=:]\s*\S+/gi, ' ')
    .replace(/[A-Za-z0-9_\-]{32,}/g, ' ')
    .replace(/[=]/g, ' ')
    .replace(/sk-/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export interface CleanUrl { url: string; needsAuth: boolean }

/** 规范化 + 去密钥；返回 null 表示整条不收 */
export function cleanUrl(raw: string): CleanUrl | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null; // user:pass@host 整条不收
  // 路径/主机里出现 sk-（OpenAI 式密钥前缀）一律不收：宁可丢掉 sk-hynix 这类误伤，也不让索引出现密钥样式串
  if (/sk-/i.test(raw.split('?')[0])) return null;
  let needsAuth = false;
  const params = [...u.searchParams.keys()];
  // 参数名命中密钥词，或以 k/key/token 结尾（tk、ak、sk、apikey…）→ 去掉整个查询串并标记需鉴权
  if (params.some((k) => SECRET_PARAM.test(k) || /(?:k|key|token)$/i.test(k)) || /(?:token|key|k)=/i.test(u.hash)) {
    needsAuth = true;
    u.search = '';
    u.hash = '';
  }
  // 路径里形似密钥的长串（>=32 位）也不收
  if (/[A-Za-z0-9_-]{40,}/.test(u.pathname)) return null;
  let s = u.toString();
  if (s.endsWith('/') && u.pathname === '/' && !u.search && !u.hash) s = s.slice(0, -1);
  return { url: s, needsAuth };
}

// ───────────────────────── 分类与降噪 ─────────────────────────

const DOC_HOSTS = [
  /^docs\./, /^api-docs\./, /^developer\./, /^developers\./, /\.readthedocs\./, /^learn\.microsoft\.com$/, /^support\.apple\.com$/,
  /^nodejs\.org$/, /^www\.typescriptlang\.org$/, /^typescriptlang\.org$/, /^developer\.mozilla\.org$/, /^code\.claude\.com$/,
  /^json-schema\.org$/, /^www\.w3\.org$/, /^schemas\./, /^pypi\.org$/, /^www\.npmjs\.com$/, /^npmjs\.com$/, /^registry\.npmjs\.org$/,
  /^help\./, /^www\.alfredapp\.com$/, /^platform\.openai\.com$/, /^platform\.deepseek\.com$/, /^console\./, /^status\./,
  /^cdn\./, /^cdnjs\./, /^unpkg\.com$/, /^fonts\.(googleapis|gstatic)\.com$/, /^r\.jina\.ai$/, /^img\./, /^images\./,
  /^(www\.)?example\.(com|org)$/, /^schema\.org$/, /^github\.githubassets\.com$/, /^objects\.githubusercontent\.com$/, /^avatars\./,
];

export function isLocalHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0' || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(host) || host.endsWith('.ts.net');
}

/** 丢掉 API 端点、文档站、github 根域与搜索页等噪声 */
export function isNoise(url: URL): boolean {
  const h = url.hostname.toLowerCase();
  const p = url.pathname;
  if (h.startsWith('api.') || /\/v\d+(\/|$)/.test(p) || p.startsWith('/api/')) return true;
  if (h === 'raw.githubusercontent.com' || h === 'gist.githubusercontent.com') return true;
  if (DOC_HOSTS.some((re) => re.test(h))) return true;
  if ((h === 'github.com' || h === 'www.github.com') && (p === '/' || p === '' || p.startsWith('/search') || p === '/settings' || p.startsWith('/login'))) return true;
  if (/\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|woff2?|ttf|map|zip|tar|gz|dmg|pkg)$/i.test(p)) return true;
  if (h.includes('{') || h.includes('<') || h.includes('$')) return true;
  // 短链与社交帖子：t.co 跳转短链、x.com / twitter.com 的单条帖子（不是 Claude 交付的产物，量又大）
  if (h === 't.co') return true;
  if (/^(?:(?:www|mobile)\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx)\.com$/.test(h) && /^\/[^/]+\/status(?:es)?\//.test(p)) return true;
  // GitHub Actions 运行页（每次 CI 一条，没有回看价值）
  if ((h === 'github.com' || h === 'www.github.com') && /^\/[^/]+\/[^/]+\/actions\/(?:runs|jobs)\//.test(p)) return true;
  return false;
}

const ART_RE = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9-]{8,})/;

/** 生成去重键：同一服务（同端口+路径）的 127.0.0.1 / 100.x / ts.net / localhost 合并 */
export function urlKey(url: URL, kind: ItemKind): string {
  if (kind === 'artifact') {
    const m = ART_RE.exec(url.toString());
    return `artifact:${m ? m[1] : url.pathname}`;
  }
  if (kind === 'local') {
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    const path = url.pathname.replace(/\/+$/, '');
    // ts.net 未写端口时通常是 tailscale serve 的 443，单独成组
    const group = url.hostname.endsWith('.ts.net') && !url.port ? `tsnet-${url.hostname}` : 'host';
    return `local:${group}:${port}${path}`;
  }
  return `web:${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}${url.search}`;
}

export function classify(raw: string): { kind: ItemKind; url: string; key: string; needsAuth: boolean } | null {
  const c = cleanUrl(raw);
  if (!c) return null;
  const u = new URL(c.url);
  if (u.hostname === 'claude.ai') {
    if (!ART_RE.test(c.url)) return null; // claude.ai 只收 artifact
    const m = ART_RE.exec(c.url);
    const url = m ? c.url.slice(0, m[0].length) : c.url;
    return { kind: 'artifact', url, key: urlKey(new URL(url), 'artifact'), needsAuth: false };
  }
  if (isLocalHost(u.hostname)) {
    if (isServiceNoise(u)) return null; // proxies, DevTools, model APIs: not something the user made
    return { kind: 'local', url: c.url, key: urlKey(u, 'local'), needsAuth: c.needsAuth };
  }
  if (isNoise(u)) return null;
  return { kind: 'web', url: c.url, key: urlKey(u, 'web'), needsAuth: c.needsAuth };
}

// ───────────────────────── 文本里抽 URL + 上下文 ─────────────────────────

const URL_RE = /https?:\/\/[^\s"'<>()[\]{}|\\^`，。、；：！？（）【】《》「」『』“”]+/g;

export function trimUrl(u: string): string {
  return u.replace(/[.,;:!?*_~'"）)\]>]+$/u, '').replace(/\*\*.*$/, '');
}

/** 上下文关键词：取 URL 前后各约 80 字，只留中日韩字、字母数字，抹密钥 */
export function contextAround(text: string, start: number, end: number): string {
  const before = text.slice(Math.max(0, start - 80), start);
  const after = text.slice(end, end + 80);
  const keep = (s: string) => s.replace(URL_RE, ' ').replace(/[^\p{Script=Han}A-Za-z0-9぀-ヿ\s·-]+/gu, ' ');
  return scrubText(`${keep(before)} ${keep(after)}`).slice(0, 200);
}

/** URL 自带的标题：markdown [标题](url)，或同一行 URL 前面的短语（「教学页 | https://」「本机：http://」） */
export function titleNear(text: string, start: number): { title: string; source: 'markdown' | 'context' } | null {
  const md = /\[([^\]\n]{1,60})\]\($/.exec(text.slice(Math.max(0, start - 80), start));
  if (md) {
    const t = scrubText(md[1]).trim();
    if (t && !/^https?:/.test(t)) return { title: t, source: 'markdown' };
  }
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const prefix = text.slice(lineStart, start)
    .replace(/[*`#>|\-–—:：（(【\[\s]+$/u, '')
    .replace(/^[\s*`#>|\-\d.、]+/u, '');
  const seg = prefix.split(/[|。；;！!？?]/).pop()?.trim() ?? '';
  const cleaned = scrubText(
    seg.replace(/\\[nrt]/g, ' ').replace(/[*`_"'{}[\]\\]/g, ' ').replace(/^\s*[A-Za-z_][\w-]*\s*:\s*/, ''),
  ).replace(/[:：\s]+$/u, '').replace(/^[:：\s]+/u, '').trim();
  if (!isGoodTitle(cleaned)) return null;
  return { title: cleaned, source: 'context' };
}

/** 上下文标题要像个名字：2–30 字、至少两个汉字或字母、不像命令行 */
export function isGoodTitle(t: string): boolean {
  if (t.length < 2 || t.length > 30) return false;
  if (/https?:/.test(t)) return false;
  if (/^[-$#>~./\\]/.test(t) || /\$\(|\||&&|--|\bcurl\b|\becho\b|=/.test(t)) return false;
  const words = (t.match(/[\p{Script=Han}A-Za-z]/gu) ?? []).length;
  return words >= 2;
}

/** va 自己的演练输出（[DRY-RUN] / （演练））被贴回对话时，里面的链接不是新产物 */
const VA_ECHO_RE = /\[DRY-RUN\]|（演练）|\(dry run\)/;

/** 被省略号截断的 URL：匹配本身含「…」，或紧跟着 … / ...（「https://foo.com/abc…」「https://foo.com/ab...」） */
export function isTruncatedUrl(match: string, after: string): boolean {
  return /…|\.{3}$/.test(match) || /^(?:…|\.{3})/.test(after);
}

export function extractUrlsFromText(text: string, ts: string): Hit[] {
  const out: Hit[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const s0 = m.index ?? 0;
    if (isTruncatedUrl(m[0], text.slice(s0 + m[0].length, s0 + m[0].length + 3))) continue;
    const ls = text.lastIndexOf('\n', s0) + 1;
    const le = text.indexOf('\n', s0);
    if (VA_ECHO_RE.test(text.slice(ls, le < 0 ? undefined : le))) continue;
    const raw = trimUrl(m[0]);
    const c = classify(raw);
    if (!c) continue;
    const start = m.index ?? 0;
    const near = titleNear(text, start);
    out.push({ ...c, context: contextAround(text, start, start + m[0].length), ts, title: near?.title, titleSource: near?.source });
  }
  return out;
}

export function htmlTitle(s: string): string | null {
  const m = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(s);
  if (!m) return null;
  const t = scrubText(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim());
  return t || null;
}

// ───────────────────────── 逐行解析 jsonl ─────────────────────────

interface Block { type?: string; text?: string; name?: string; id?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown }

function blockText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b === 'object' && typeof (b as Block).text === 'string' ? (b as Block).text : '')).join('\n');
  return '';
}

/** 一个会话文件内的跨行状态（tool_use id → 输入；文件路径 → html 标题） */
export interface FileState {
  toolInputs: Map<string, { name: string; input: Record<string, unknown> }>;
}

export interface LineResult { hits: Hit[]; titles: Array<[string, string]>; files: Array<{ path: string; ts: string; context: string; caption?: string }> }

const PUBLISHED_RE = /Published (\S+) at (https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+)/g;

export function processLine(line: string, st: FileState): LineResult {
  const res: LineResult = { hits: [], titles: [], files: [] };
  if (!line.includes('http') && !line.includes('"Write"') && !line.includes('"Read"') && !line.includes('"Artifact"') && !line.includes('SendUserFile') && !line.includes('<title')) return res;
  let d: { type?: string; timestamp?: string; message?: { role?: string; content?: unknown } };
  try {
    d = JSON.parse(line);
  } catch {
    return res;
  }
  const ts = d.timestamp ?? '';
  const content = d.message?.content;
  const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as Block[]) : [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string' && (d.type === 'assistant' || d.type === 'user')) {
      // 用户与助手的正文：链接主要出现在这里（不扫工具读到的源码，避免噪声）
      res.hits.push(...extractUrlsFromText(b.text, ts));
    } else if (b.type === 'tool_use' && b.input) {
      st.toolInputs.set(b.id ?? '', { name: b.name ?? '', input: b.input });
      if (st.toolInputs.size > 2000) st.toolInputs.delete(st.toolInputs.keys().next().value as string);
      const inp = b.input;
      if (b.name === 'Write' && typeof inp.file_path === 'string') {
        const t = typeof inp.content === 'string' ? htmlTitle(inp.content) : null;
        if (t) res.titles.push([inp.file_path, t]);
        res.files.push({ path: inp.file_path, ts, context: '' });
      } else if ((b.name === 'Edit' || b.name === 'MultiEdit') && typeof inp.file_path === 'string' && typeof inp.new_string === 'string') {
        const t = htmlTitle(inp.new_string);
        if (t) res.titles.push([inp.file_path, t]);
      } else if (b.name === 'SendUserFile' && Array.isArray(inp.files)) {
        const caption = typeof inp.caption === 'string' ? scrubText(inp.caption).slice(0, 80) : '';
        for (const f of inp.files) if (typeof f === 'string') res.files.push({ path: f, ts, context: caption, caption });
      }
    } else if (b.type === 'tool_result') {
      const text = blockText(b.content);
      const src = st.toolInputs.get(b.tool_use_id ?? '');
      if (src?.name === 'Read' && typeof src.input.file_path === 'string' && text.includes('<title')) {
        const t = htmlTitle(text);
        if (t) res.titles.push([src.input.file_path, t]);
      }
      for (const m of text.matchAll(PUBLISHED_RE)) {
        const c = classify(m[2]);
        if (!c) continue;
        const desc = src?.name === 'Artifact' && typeof src.input.description === 'string' ? scrubText(src.input.description) : '';
        const ttl = src?.name === 'Artifact' && typeof src.input.title === 'string' ? scrubText(src.input.title) : '';
        res.hits.push({
          ...c, ts, context: desc.slice(0, 200), sourcePath: m[1],
          title: ttl || undefined, titleSource: ttl ? 'publish' : undefined,
        });
      }
    }
  }
  return res;
}

export async function readLinesFrom(path: string, start: number, onLine: (l: string) => void): Promise<number> {
  const stream = createReadStream(path, { start, encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let bytes = start;
  let lastLen = 0;
  let pending: string | null = null;
  for await (const l of rl) {
    if (pending !== null) onLine(pending);
    pending = l;
    lastLen = Buffer.byteLength(l, 'utf8');
    bytes += lastLen + 1;
  }
  // 末行若没有换行（还在写），不处理、offset 停在它前面，下次整行重读
  const size = (await stat(path)).size;
  if (pending !== null) {
    if (bytes <= size) onLine(pending);
    else return bytes - lastLen - 1;
  }
  return Math.min(bytes, size);
}

// ───────────────────────── 合并 ─────────────────────────

const TITLE_RANK: Record<SavedItem['titleSource'], number> = { html: 6, publish: 6, fetch: 5, markdown: 4, description: 3, filename: 2, context: 1, '': 0 };

/**
 * Opening address for a local service: 127.0.0.1 > localhost > one of THIS machine's other addresses
 * (config.self_hosts, e.g. its Tailscale IP — rewritten to 127.0.0.1) > first seen.
 */
export function preferUrl(variants: string[], selfHosts: string[] = getConfig().self_hosts): string {
  const pick = (re: RegExp) => variants.find((v) => re.test(v));
  const own = pick(/^https?:\/\/127\.0\.0\.1[:/]/) ?? pick(/^https?:\/\/localhost[:/]/);
  if (own) return own;
  for (const h of selfHosts) {
    const esc = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hit = pick(new RegExp(`^https?:\\/\\/${esc}[:/]`));
    if (hit) return hit.replace(h, '127.0.0.1');
  }
  return variants[0];
}

export function mergeHit(items: Map<string, SavedItem>, h: Hit): void {
  const cur = items.get(h.key);
  if (!cur) {
    items.set(h.key, {
      key: h.key, kind: h.kind, url: h.url, variants: [h.url], title: h.title ?? '', titleSource: h.titleSource ?? '',
      contexts: h.context ? [h.context] : [], count: 1, firstSeen: h.ts, lastSeen: h.ts, ...(h.needsAuth ? { needsAuth: true } : {}),
      ...(h.sourcePath ? { sourcePath: h.sourcePath } : {}),
      ...(h.session ? { sessions: [h.session] } : {}),
    });
    const it = items.get(h.key) as SavedItem;
    it.url = h.kind === 'local' ? preferUrl(it.variants) : it.url;
    return;
  }
  cur.count += 1;
  if (h.ts && (!cur.lastSeen || h.ts > cur.lastSeen)) cur.lastSeen = h.ts;
  if (h.ts && (!cur.firstSeen || h.ts < cur.firstSeen)) cur.firstSeen = h.ts;
  if (!cur.variants.includes(h.url) && cur.variants.length < 6) cur.variants.push(h.url);
  if (h.kind === 'local') cur.url = preferUrl(cur.variants);
  if (h.needsAuth) cur.needsAuth = true;
  if (h.sourcePath && !cur.sourcePath) cur.sourcePath = h.sourcePath;
  if (h.session) {
    cur.sessions ??= [];
    if (!cur.sessions.includes(h.session)) {
      cur.sessions.push(h.session);
      if (cur.sessions.length > 5) cur.sessions.shift();
    }
  }
  if (h.title && TITLE_RANK[h.titleSource ?? ''] > TITLE_RANK[cur.titleSource]) {
    cur.title = h.title;
    cur.titleSource = h.titleSource ?? '';
    delete cur.fullTitle; // the cut-down original belonged to the old title
  }
  if (h.context && !cur.contexts.includes(h.context)) {
    cur.contexts.push(h.context);
    if (cur.contexts.length > 3) cur.contexts.shift();
  }
}
