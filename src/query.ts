/**
 * What a "find that thing" sentence asks for (WO-20261003-002, retrieval quality):
 *  - nouns: the words that name the thing ("库存", "交易大盘", "logo"); function words (打开 / 那个 / 的 / open / the)
 *    and time words are not nouns
 *  - types: what kind of thing ("看板" → dashboard, "报告" → report, "PR", "页面" → page …); a type word filters
 *  - time: "昨天 / 上周" (a window that filters) or "最近" (newest first); `made` = "做的 / made": judge by first seen
 * Pure functions, no I/O. Used by src/saved.ts.
 */
import { extractTimeHint } from './timewords.ts';
import type { TimeHint } from './timewords.ts';
import type { SavedItem } from './indexer.ts';

export type QType = 'dashboard' | 'report' | 'pr' | 'page' | 'deck' | 'file';

export interface Noun {
  /** normalized text (NFKC, lower case) */
  text: string;
  /** synonyms / the other language ("原型" ↔ "prototype"); matching any of them counts */
  alts: string[];
}

export interface ParsedQuery {
  /** nouns in order */
  nouns: Noun[];
  types: QType[];
  time: TimeHint | null;
  /** "做的 / 写的 / made": time words apply to when it was made (first seen) */
  made: boolean;
  /** the query without function words and time words, type words kept ("库存看板"), for exact-title checks */
  core: string;
}

/** Type words → type. Order matters only for readability; each is matched as a whole word */
const TYPE_WORDS: Array<[RegExp, QType]> = [
  [/看板|大盘|仪表盘|仪表板|监控面板|dashboards?|monitor/giu, 'dashboard'],
  [/报告|报表|reports?/giu, 'report'],
  [/\bprs?\b|pull\s*requests?|合并请求/giu, 'pr'],
  [/页面|网页|主页|网站|站点|\bpages?\b|\bwebsites?\b|\bsites?\b|\bweb\s*pages?\b/giu, 'page'],
  [/\bppt\b|幻灯片?|演示稿|\bslides?\b|\bdecks?\b|keynote/giu, 'deck'],
  [/文件|\bfiles?\b/giu, 'file'],
];

/** Words that only carry the request, never the name */
const ZH_FUNC = /让\s*claude\s*|帮我|给我|替我|麻烦你?|请你?|打开|开一下|开下|看一下|看下|看看|瞧瞧|调出来|调出|找一下|找出来|找到|找找|找|那一?个|这一?个|那份|这份|那张|这张|那篇|这篇|那条|这条|那次|一下|我的|咱们的|我们的|(?:做|弄|搞|写|生成|发|给|建|画)(?:过|了)?的|做过|做了|之前|以前|上次|是|的|吧|呢|啊|呀|嘛/giu;
const EN_FUNC = /\b(?:please|open|show(?:\s+me)?|bring\s+up|pull\s+up|launch|find|go\s+to|look\s+at|view|get|the|my|our|a|an|that|this|those|these|for\s+me|up|one|i|we|made|built|created|wrote|did|from|of|in|on|at|to|with|was|is|which|thing|stuff)\b/giu;
const MADE_RE = /(?:做|弄|搞|写|生成|建|画)(?:过|了)?的|做过|做了|\b(?:made|built|created|wrote|did)\b/iu;

/**
 * Synonym groups (zh ↔ en, and common spoken variants). Keep it small: only words seen in real requests.
 * Matching uses the first group a noun belongs to.
 */
const SYNONYMS: string[][] = [
  ['原型', 'prototype', 'mockup'],
  ['图标', 'logo', 'icon', '标志'],
  ['比稿', 'board', 'boards', '比稿板', 'comparison'],
  ['交易', 'trading', 'trade'],
  ['股票', 'stock', 'stocks'],
  ['流量', 'traffic', 'bandwidth'],
  ['设计稿', 'design', 'mockups'],
  ['期权', 'options', 'option'],
  ['手册', 'handbook', 'manual', 'guide', 'playbook'],
  ['周报', 'weekly'],
  ['月报', 'monthly'],
  ['日报', 'daily'],
  ['试听', 'audition', 'preview'],
  ['音色', 'voice', 'voices', 'timbre'],
  ['发布', 'launch', 'release'],
  ['芝麻', 'sesame'],
  ['库存', 'inventory'],
  ['预算', 'budget'],
];
const SYN = new Map<string, string[]>();
const addGroups = (groups: readonly (readonly string[])[]): void => {
  for (const raw of groups) {
    const g = raw.map((w) => w.normalize('NFKC').toLowerCase().trim()).filter(Boolean);
    for (const w of g) SYN.set(w, [...new Set([...(SYN.get(w) ?? []), ...g.filter((x) => x !== w)])]);
  }
};
addGroups(SYNONYMS);
const BUILTIN_SYN = new Map(SYN);
let userGroupsKey = '';

/**
 * Personal vocabulary from config.yaml `synonyms:` (a list of word groups, e.g. `- [库存, inventory]`): words of your
 * own projects never live in the repo. Re-applied when the config changes; builtin groups always stay.
 */
export function setUserSynonyms(groups: readonly (readonly string[])[]): void {
  const key = JSON.stringify(groups);
  if (key === userGroupsKey) return;
  userGroupsKey = key;
  SYN.clear();
  for (const [k, v] of BUILTIN_SYN) SYN.set(k, v);
  addGroups(groups);
  hanKeys = [...SYN.keys()].filter(isHan).sort((a, b) => b.length - a.length);
}

const isHan = (s: string): boolean => /\p{Script=Han}/u.test(s);

/**
 * A run of Chinese characters → words. Synonym keys are cut out first ("芝麻图标比稿" → 芝麻 | 图标 | 比稿); the rest is
 * split with the system word segmenter, single characters joined in pairs ("期|权|作战" → 期权 | 作战), and a last
 * single character joined to the word before it ("设计|稿" → 设计稿).
 */
const SEG = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('zh', { granularity: 'word' }) : null;
let hanKeys = [...SYN.keys()].filter(isHan).sort((a, b) => b.length - a.length);

function splitHan(run: string): string[] {
  for (const k of hanKeys) {
    const i = run.indexOf(k);
    if (i >= 0 && run.length > k.length) return [...splitHan(run.slice(0, i)), k, ...splitHan(run.slice(i + k.length))].filter(Boolean);
  }
  if (run.length <= 3 || !SEG) return run ? [run] : [];
  const segs = [...SEG.segment(run)].map((s) => s.segment).filter(Boolean);
  const out: string[] = [];
  let single = '';
  for (const s of segs) {
    if ([...s].length === 1) {
      single += s;
      if (single.length === 2) { out.push(single); single = ''; }
      continue;
    }
    if (single) { if (out.length) out[out.length - 1] += single; else s.length && out.push(single); single = ''; }
    out.push(s);
  }
  if (single) { if (out.length) out[out.length - 1] += single; else out.push(single); }
  return out;
}

export function parseQuery(query: string, now: Date = new Date()): ParsedQuery {
  const made = MADE_RE.test(query);
  const th = extractTimeHint(query, now);
  // a sentence that is only a time word ("昨天") keeps it as text: there is nothing else to search for
  const time = th.hint && th.query.trim() ? th.hint : null;
  let t = (time ? th.query : query).normalize('NFKC').toLowerCase();
  const core = t.replace(ZH_FUNC, ' ').replace(EN_FUNC, ' ').replace(/[\p{P}\p{S}\s]+/gu, '');
  const types: QType[] = [];
  for (const [re, ty] of TYPE_WORDS) {
    re.lastIndex = 0;
    if (re.test(t)) { if (!types.includes(ty)) types.push(ty); t = t.replace(re, ' '); }
  }
  t = t.replace(ZH_FUNC, ' ').replace(EN_FUNC, ' ');
  const nouns: Noun[] = [];
  const seen = new Set<string>();
  for (const part of t.split(/[\p{P}\p{S}\s]+/u)) {
    if (!part) continue;
    // split at script boundaries: "sesame原型" → sesame | 原型
    for (const piece of part.match(/\p{Script=Han}+|[^\p{Script=Han}]+/gu) ?? []) {
      const words = isHan(piece) ? splitHan(piece) : [piece];
      for (const w of words) {
        if (!w || seen.has(w)) continue;
        if (!isHan(w) && w.length < 2 && !/\d/.test(w)) continue; // stray letters
        seen.add(w);
        nouns.push({ text: w, alts: SYN.get(w) ?? [] });
      }
    }
  }
  return { nouns, types, time, made, core };
}

// ───────────────────────── types of items ─────────────────────────

const DASH_NAME = /看板|大盘|仪表盘|仪表板|面板|监控|dashboard|monitor|console/i;
const REPORT_NAME = /报告|报表|周报|日报|月报|复盘|调研|研究|总结|分析|纪要|review|report|summary|analysis|monthly|weekly/i;
const DECK_NAME = /\bppt\b|幻灯|演示稿|slides?\b|deck\b|keynote/i;
const DEPLOY_HOST = /\.(?:vercel\.app|netlify\.app|pages\.dev|workers\.dev|github\.io|fly\.dev|onrender\.com|surge\.sh|railway\.app|aiforce\.cloud|ts\.net|trycloudflare\.com)$/i;

/** Does this item count as the asked-for type? (a file's folder counts for reports: …/reviews/thesis_monthly.md) */
export function itemIsType(it: Pick<SavedItem, 'kind' | 'url' | 'title'>, ty: QType): boolean {
  const name = it.title ?? '';
  const isPR = it.kind === 'web' && /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(it.url);
  switch (ty) {
    case 'pr': return isPR;
    case 'dashboard': return it.kind === 'local' || DASH_NAME.test(name) || (it.kind === 'file' && /dashboard/i.test(it.url) && /\.html?$/i.test(it.url));
    case 'report': return !isPR && (REPORT_NAME.test(name) || (it.kind === 'file' && /\.(md|pdf|docx?|html?)$/i.test(it.url) && REPORT_NAME.test(it.url.split('/').slice(-3).join('/'))));
    case 'deck': return /\.(pptx?|key)$/i.test(it.url) || DECK_NAME.test(name);
    case 'file': return it.kind === 'file';
    case 'page': {
      if (it.kind === 'artifact' || it.kind === 'local') return true;
      if (it.kind === 'file') return /\.html?$/i.test(it.url);
      try { return DEPLOY_HOST.test(new URL(it.url).hostname) || !isPR; } catch { return false; }
    }
  }
}
