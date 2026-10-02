/**
 * open_saved 的本地检索：中文 bigram 重合 + 别名 + 次数/最近时间加权，取前 5 候选。
 * 只把候选的「标题 + 上下文关键词 + 类型」给模型挑（完整 URL 不发）。
 */
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteJsonSync, readJsonSync, updateJsonSync } from './fsutil.ts';
import type { SavedItem } from './indexer.ts';
import { getConfig } from './config.ts';
import { EN, PACKS, ZH, detectLocale, packFor } from './i18n.ts';
import type { Locale } from './i18n.ts';
import { extractTimeHint } from './timewords.ts';
import type { TimeHint } from './timewords.ts';
import { itemIsType, parseQuery, setUserSynonyms } from './query.ts';
import type { Noun } from './query.ts';
import { isProduct, madeByAI } from './title-quality.ts';
import type { OpenedInfo } from './types.ts';

/** 泛词：只靠它们重合不算「对上了」（中文 bigram + 英文整词；按查询语言选，见 src/i18n.ts） */
export const GENERIC_GRAMS = new Set(ZH.genericWords);
const GENERIC_EN = new Set(EN.genericWords);
const genericFor = (q: string): Set<string> => (detectLocale(q, getConfig().locale) === 'en' ? GENERIC_EN : GENERIC_GRAMS);

/** locale = the QUERY's locale (titles are cored with the query's rules so they stay comparable) */
export function queryCore(q: string, locale: Locale = detectLocale(q, getConfig().locale)): string {
  const pack = PACKS[locale];
  const base = q.normalize('NFKC').toLowerCase();
  if (pack === ZH) return base.replace(/[\p{P}\p{S}\s]+/gu, '').replace(ZH.stopRe, '');
  // English: keep word boundaries (grams() splits on words), drop stop words, collapse spaces
  return base.replace(/[\p{P}\p{S}]+/gu, ' ').replace(EN.stopRe, ' ').replace(/\s+/g, ' ').trim();
}

/** 中文按相邻两字切 bigram；英文/数字按整词 */
export function grams(s: string): Set<string> {
  const out = new Set<string>();
  const t = s.normalize('NFKC').toLowerCase();
  for (const w of t.match(/[a-z0-9]+/g) ?? []) if (w.length >= 2) out.add(w);
  const han = t.replace(/[^\p{Script=Han}]+/gu, '|').split('|').filter(Boolean);
  for (const h of han) {
    if (h.length === 1) out.add(h);
    for (let i = 0; i + 1 < h.length; i++) out.add(h.slice(i, i + 2));
  }
  return out;
}

export type Aliases = Record<string, string>; // 别名(归一化) → item.key


/**
 * Words an item answers to besides its title: GitHub pull requests / issues are often titled with a sentence
 * ("开 PR + 挂 automerge"), but users say "那个 PR". Only used for matching, never shown.
 */
export function virtualTags(it: Pick<SavedItem, 'url' | 'kind'>): string {
  if (it.kind !== 'web') return '';
  if (/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(it.url)) return ' pr pull request';
  if (/github\.com\/[^/]+\/[^/]+\/issues\/\d+/.test(it.url)) return ' issue';
  return '';
}

/**
 * Title shown to the user. Empty titles fall back to: host (web / local service) or file name (file)
 * → last path segment of the address → the address itself.
 */
export function displayTitle(it: Pick<SavedItem, 'title' | 'url' | 'kind'>): string {
  const t = (it.title ?? '').trim();
  if (t) return t;
  const url = it.url ?? '';
  if (it.kind === 'file' || url.startsWith('/')) {
    const name = url.split('/').filter(Boolean).pop();
    if (name) return name;
  }
  try {
    const u = new URL(url);
    if (it.kind === 'web' || it.kind === 'local') {
      const host = u.hostname.replace(/^www\./, '');
      const port = u.port && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') ? `localhost:${u.port}` : '';
      if (port) return port;
      if (host) return host;
    }
    const seg = u.pathname.split('/').filter(Boolean).pop();
    if (seg) return decodeURIComponent(seg);
    if (u.hostname) return u.hostname;
  } catch {
    const seg = url.split('/').filter(Boolean).pop();
    if (seg) return seg;
  }
  return url;
}

/** Per-item grams, computed once per item object (items.json is parsed once and reused while unchanged) */
interface ItemGrams { title: Set<string>; ctx: Set<string>; sess: Set<string>; bag: Set<string>; core: Map<Locale, string> }
const gramMemo = new WeakMap<SavedItem, ItemGrams>();
function itemGrams(it: SavedItem): ItemGrams {
  let g = gramMemo.get(it);
  if (!g) {
    const t = `${it.title} ${it.fullTitle ?? ''}${virtualTags(it)}`;
    g = { title: grams(t), ctx: grams(it.contexts.join(' ')), sess: it.sessionKeywords ? grams(it.sessionKeywords) : new Set(), bag: grams(`${t} ${it.contexts.join(' ')} ${it.sessionKeywords ?? ''}`), core: new Map() };
    gramMemo.set(it, g);
  }
  return g;
}
function titleCore(it: SavedItem, loc: Locale): string {
  const g = itemGrams(it);
  let c = g.core.get(loc);
  if (c === undefined) { c = queryCore(it.title, loc); g.core.set(loc, c); }
  return c;
}

/**
 * Is the noun in this text? 1 = the word itself, 0.7 = only a synonym / the other language ("比稿" found as "board"),
 * 0 = no. Chinese nouns: the whole word, or at least two thirds of its character pairs.
 */
function nounIn(n: Noun, words: Set<string>, text: string): number {
  let best = 0;
  for (const [i, v] of [n.text, ...n.alts].entries()) {
    const w = i === 0 ? 1 : 0.7;
    if (w <= best) continue;
    let hit = false;
    if (/\p{Script=Han}/u.test(v)) {
      if (text.includes(v)) hit = true;
      else {
        const g = grams(v);
        let k = 0;
        for (const x of g) if (words.has(x)) k += 1;
        hit = g.size > 1 && k / g.size >= 0.66;
        // part of the word (dictation slips: 门店夜 → 门店): weak credit, never counts as found
        if (!hit && i === 0 && g.size > 1 && k / g.size >= 0.5) best = Math.max(best, 0.4);
      }
    } else hit = words.has(v) || (v.length >= 4 && text.includes(v));
    if (hit) best = w;
  }
  return best;
}

/** The noun is in the name both as itself and as its synonym ("原型" in the title, "prototype" in the file name) */
function nounTwice(n: Noun, words: Set<string>, text: string): boolean {
  if (n.alts.length === 0 || nounIn({ text: n.text, alts: [] }, words, text) < 1) return false;
  return n.alts.some((a) => nounIn({ text: a, alts: [] }, words, text) >= 1);
}

/** A date in the name ("layer_2026-10-01.md", "weekly_2026-W39.md", "report-20260929"): the day / ISO week it is about */
export function nameDate(it: Pick<SavedItem, 'kind' | 'url' | 'title'>): { from: Date; to: Date } | null {
  const base = it.kind === 'file' ? (it.url.split('/').pop() ?? '') : it.title ?? '';
  const w = /(20\d{2})-?W(\d{2})(?!\d)/i.exec(base);
  if (w) {
    const y = Number(w[1]);
    const jan4 = new Date(y, 0, 4);
    const monday = new Date(y, 0, 4 - ((jan4.getDay() + 6) % 7) + 7 * (Number(w[2]) - 1));
    return { from: monday, to: new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7) };
  }
  const d = /(?<!\d)(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)/.exec(base);
  if (d) {
    const from = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]));
    return { from, to: new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1) };
  }
  return null;
}

/** How an item answers the query's nouns / type / time (see src/query.ts) */
export interface Match {
  /** number of nouns in the query */
  nouns: number;
  /** nouns found in the item's own name (title, its uncut original, file name, PR/issue tag, alias) */
  inName: number;
  /** of those, found as the word itself (not only as a synonym) */
  literal: number;
  /** nouns found only in the conversation around it */
  inContext: number;
  /** every noun found somewhere (always true when the query has no nouns, only a type / time) */
  covered: boolean;
  /** the query (type words kept, function words dropped) equals the name */
  exact: boolean;
  /** the asked-for type: true = matched, null = no type asked */
  typed: boolean | null;
  /** time window asked and the item was seen in it (null = no window) */
  inTime: boolean | null;
  /** "最近 / recent": newest first */
  recent: boolean;
}

export interface Candidate { item: SavedItem; score: number; aliasHit: boolean; match?: Match }

/** File name without extension, split into words: "logo-sesame-v3-board.png" → "logo sesame v3 board" */
const fileStem = (it: SavedItem): string => (it.kind === 'file' ? (it.url.split('/').pop() ?? '').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[-_.]+/g, ' ') : '');

interface NameText { words: Set<string>; text: string; ctxWords: Set<string>; ctxText: string }
const nameMemo = new WeakMap<SavedItem, NameText>();
function nameText(it: SavedItem): NameText {
  let m = nameMemo.get(it);
  if (!m) {
    const name = `${it.title} ${it.fullTitle ?? ''}${virtualTags(it)} ${fileStem(it)}`.normalize('NFKC').toLowerCase();
    const ctx = `${it.contexts.join(' ')} ${it.sessionKeywords ?? ''}`.normalize('NFKC').toLowerCase();
    m = { words: grams(name), text: name.replace(/\s+/g, ''), ctxWords: grams(ctx), ctxText: ctx.replace(/\s+/g, '') };
    nameMemo.set(it, m);
  }
  return m;
}

const DAY_MS = 86_400_000;

/** Seen inside the time window? "做的 / made" → when it first appeared; otherwise first or last seen */
function seenIn(hint: TimeHint, it: SavedItem, made: boolean): boolean {
  if (!hint.from || !hint.to) return true;
  // a date in the name says what day it is about, better than when it was seen ("layer_2026-10-01.md" written at 23:40)
  const nd = nameDate(it);
  if (nd) return nd.from.getTime() < hint.to.getTime() && nd.to.getTime() > hint.from.getTime();
  const span = hint.to.getTime() - hint.from.getTime();
  const slack = span <= DAY_MS ? 3 * 3_600_000 : DAY_MS; // a day: ±3h (late nights); a week / month: ±1 day
  const f = hint.from.getTime() - slack;
  const t = hint.to.getTime() + slack;
  const ts = (made ? [it.firstSeen] : [it.firstSeen, it.lastSeen]).map((s) => (s ? Date.parse(s) : NaN)).filter(Number.isFinite);
  if (ts.some((x) => x >= f && x < t)) return true;
  // existed through the whole window (first seen before, last seen after)
  return !made && ts.length === 2 && ts[0] < f && ts[1] >= t;
}

/**
 * Local search. Nouns first: function words (打开 / 那个 / the) and time words are not matched as text; the name and the
 * conversation around an item are scored separately (the name counts far more); a type word (看板 / 报告 / PR / 页面)
 * and a time window (昨天 / 上周) filter; "最近" puts the newest first. Close matches only: an item that answers none of
 * the nouns is not a candidate. `decide()` says whether the first one can be opened without asking.
 */
export function searchSaved(query: string, items: SavedItem[], aliases: Aliases, now: Date = new Date(), limit = 5): Candidate[] {
  const loc = detectLocale(query, getConfig().locale);
  setUserSynonyms(getConfig().synonyms ?? []);
  const pq = parseQuery(query, now);
  const window = pq.time && pq.time.from ? pq.time : null;
  const recent = Boolean(pq.time?.recent);
  const fullCore = queryCore(query, loc);
  const aliasKey = aliases[fullCore] ?? aliases[pq.core];
  const wantsSite = packFor(query, getConfig().locale).siteRe.test(query);
  const n = pq.nouns.length;
  if (n === 0 && pq.types.length === 0 && !pq.time && !aliasKey) return [];
  // generic words (官网 / 手册 / 项目 …) weigh 0.3: they say what kind of thing, not which one
  const generic = genericFor(query);
  const weights = pq.nouns.map((x) => (generic.has(x.text) ? 0.3 : 1));
  const wsum = weights.reduce((a, b) => a + b, 0) || 1;
  const hasSpecific = weights.some((w) => w === 1);
  const out: Candidate[] = [];
  for (const it of items) {
    const aliasHit = aliasKey === it.key || Object.entries(aliases).some(([a, k]) => k === it.key && a.length >= 2 && fullCore.includes(a));
    const nt = nameText(it);
    let inName = 0;
    let literal = 0;
    let nameQ = 0;
    let inContext = 0;
    let ctxQ = 0;
    let twice = 0;
    let specific = false;
    for (const [k, noun] of pq.nouns.entries()) {
      const w = weights[k];
      const q = nounIn(noun, nt.words, nt.text);
      const c = q >= 0.7 ? 0 : nounIn(noun, nt.ctxWords, nt.ctxText);
      if (q >= 0.7) { inName += 1; if (q >= 1) literal += 1; if (nounTwice(noun, nt.words, nt.text)) twice += 1; }
      else if (c >= 0.7) inContext += 1;
      nameQ += q * w;
      ctxQ += c * w;
      if ((q > 0 || c > 0) && w === 1) specific = true;
    }
    if (n > 0 && nameQ + ctxQ === 0 && !aliasHit) continue;
    const typed = pq.types.length ? pq.types.some((t) => itemIsType(it, t)) : null;
    // asked for a dashboard: items of another type are not candidates (an item with no name of its own: type unknown, kept)
    if (typed === false && !aliasHit && it.title.trim()) continue;
    const inTime = window ? seenIn(window, it, pq.made) : null;
    if (inTime === false && !aliasHit) continue; // asked for yesterday's: other days are not candidates
    const product = isProduct(it);
    const tcore = titleCore(it, loc);
    const junkShort = tcore.length <= 2 && /^[a-z0-9 ]+$/.test(tcore);
    const exact = !junkShort && fullCore.length >= 2 && (tcore === fullCore || (pq.core.length >= 2 && tcore === pq.core));
    const contains = !junkShort && !exact && fullCore.length >= 2 && tcore.includes(fullCore);
    let score = n > 0 ? (nameQ / wsum) * 4 + (ctxQ / wsum) * 1.5 + twice * 0.3 : 1;
    // only generic words matched ("官网", "手册"): weak evidence; a specific word (门店) also found as a part counts
    if (n > 0 && !specific && hasSpecific) score *= 0.5;
    else if (n > 0 && specific) score += 0.8;
    if (exact) score += 3;
    else if (contains) score += 1.5;
    if (aliasHit) score += 10;
    if (typed) score += 1;
    if (inTime) score += 1;
    // what the AI made for the user comes first; links that were only mentioned rank lower (unless web pages are asked for)
    // (a "website / 官网" request is about web pages anyway: no preference there)
    if (!wantsSite) {
      if (product) score += 1;
      else score *= madeByAI(it) ? 0.75 : 0.5;
    }
    if (wantsSite) score += it.kind === 'web' || it.kind === 'local' ? 0.6 : it.kind === 'file' ? -0.6 : 0;
    // no name given ("昨天做的那个页面"): "that one" is the page that was published / used most, not a one-off file
    if (it.kind === 'artifact' || it.kind === 'local') score += n === 0 ? 1.5 : 0.2;
    else if (n === 0 && it.kind === 'file' && /\.html?$/i.test(it.url)) score += 0.3;
    score += n === 0 ? Math.min(1.5, Math.log2(1 + it.count) * 0.5) : Math.min(0.5, Math.log2(1 + it.count) * 0.12);
    const when = Date.parse((pq.made ? it.firstSeen : it.lastSeen) || it.lastSeen || '');
    const days = Number.isFinite(when) ? Math.max(0, (now.getTime() - when) / DAY_MS) : 365;
    score += Math.max(0, 1 - days / 60) * 0.3;
    if (recent) score += Math.max(0, 1 - days / 7) * (n === 0 ? 4 : 2);
    if (isWeakWeb(it)) score *= 0.5;
    if (it.weakTitle) score *= 0.6;
    // a type word narrowed the search ("VPS 流量看板"): half of the other nouns is enough to be a close match
    const covered = n === 0 || inName + inContext === n || (typed === true && (inName + inContext) * 2 >= n);
    const match: Match = { nouns: n, inName, literal, inContext, covered, exact, typed, inTime, recent };
    out.push({ item: it, score, aliasHit, match });
  }
  out.sort((a, b) => b.score - a.score);
  // 同名去重：同一个标题既是本机服务又是磁盘上的源文件时，只留更「活」的那个（服务 > Claude 页面 > 网页 > 文件）
  const seen = new Map<string, Candidate>();
  for (const c of out) {
    const t = titleCore(c.item, loc);
    const prev = t ? seen.get(t) : undefined;
    if (!prev) { if (t) seen.set(t, c); continue; }
    if (KIND_RANK[c.item.kind] > KIND_RANK[prev.item.kind] && c.score >= prev.score * 0.8) {
      c.score = Math.max(c.score, prev.score);
      seen.set(t, c);
    }
  }
  const dedup = out.filter((c) => { const t = titleCore(c.item, loc); return !t || seen.get(t) === c; });
  return dedup.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Lead the first candidate needs over the next close match to be opened without asking */
export const LEAD = 1.3;

/** Every noun of the query is in the item's own name */
const fullName = (x: Candidate): boolean => Boolean(x.match && x.match.nouns > 0 && x.match.inName === x.match.nouns);

/**
 * What a list may offer when the first one cannot be opened: items whose NAME carries every noun (or, for a sentence
 * with only a type / time, everything that passed those filters). An item that answers only part of the sentence is
 * not offered: no filler candidates.
 */
export function shortlist(c: Candidate[]): Candidate[] {
  return c.filter((x) => x.aliasHit || !x.match || x.match.exact || (x.match.nouns === 0 ? x.match.covered : fullName(x)));
}

/**
 * Open the first candidate without asking? (no model, or the model already chose open_saved)
 *  - an alias, or the only item whose name is exactly the query
 *  - nouns asked: among items whose name has every noun, the first leads the next by LEAD, or is the only one with
 *    every noun as the word itself; with no such item, the one item that has the most nouns in its name (no tie) and
 *    the rest in its conversation; or, when a type word narrowed it ("VPS 流量看板"), the only item of that type left
 *  - only a type / time: the only one; "最近" → the newest; a time window → a clear lead
 * null = list the shortlist (if any) or say nothing was found.
 */
export function decide(c: Candidate[]): Candidate | null {
  if (c.length === 0) return null;
  if (c[0].aliasHit) return c[0];
  const exact = c.filter((x) => x.match?.exact);
  if (exact.length === 1) return exact[0];
  const m0 = c[0].match;
  if (!m0) return null;
  const leads = (a: Candidate, b: Candidate | undefined): boolean => !b || a.score >= b.score * LEAD;
  if (m0.nouns > 0) {
    const full = c.filter(fullName);
    if (full.length) {
      if (leads(full[0], full[1])) return full[0];
      const lit = full.filter((x) => x.match!.literal === x.match!.nouns);
      return lit.length === 1 && lit[0].score >= full[0].score * 0.9 ? lit[0] : null;
    }
    const covered = c.filter((x) => x.match?.covered);
    if (covered.length === 0) return null;
    const best = covered.reduce((a, b) => (b.match!.inName > a.match!.inName ? b : a));
    const ties = covered.filter((x) => x.match!.inName === best.match!.inName);
    if (best.match!.inName > 0 && ties.length === 1) return best;
    if (covered.length === 1 && covered[0].match!.typed === true) return covered[0];
    return null;
  }
  const list = shortlist(c);
  if (list.length === 1 || (list.length && list[0].match?.recent)) return list[0];
  return list.length && leads(list[0], list[1]) ? list[0] : null;
}

/** Share of the query's grams found in the item's own name (title, its uncut original, PR/issue tags, alias) */
export function titleCoverage(core: string, it: SavedItem, aliases: Aliases = {}): number {
  const qg = grams(core);
  if (qg.size === 0) return 0;
  const names = `${it.title} ${it.fullTitle ?? ''}${virtualTags(it)} ${Object.entries(aliases).filter(([, k]) => k === it.key).map(([a]) => a).join(' ')}`;
  const loc = detectLocale(core, getConfig().locale);
  if (core && queryCore(names, loc).includes(core)) return 1;
  const tg = grams(names);
  let n = 0;
  for (const g of qg) if (tg.has(g)) n += 1;
  return n / qg.size;
}

/**
 * Results while typing (Spotlight-like): only items whose NAME carries at least half of what was typed. Context-only
 * matches that the sentence flow keeps as candidates ("v2" somewhere in a chat line) are left out, so a miss shows the
 * "let Sesame look for …" row instead of noise. One or two typed characters also match inside titles ("大" → 交易大盘).
 */
const WEB_WORDS = /网页|链接|文章|帖子|新闻|网址|\b(?:web|link|links|article|articles|url|page)\b/i;

export function searchLive(query: string, items: SavedItem[], aliases: Aliases, now: Date = new Date(), limit = 6): Candidate[] {
  const loc = detectLocale(query, getConfig().locale);
  const core = queryCore(query, loc) || query.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  if (!core) return [];
  const byKey = new Map<string, Candidate>();
  for (const c of searchSaved(query, items, aliases, now, 50)) if (titleCoverage(core, c.item, aliases) >= 0.5) byKey.set(c.item.key, c);
  // short input: a plain "title contains it" pass (bigrams cannot see a single character inside 交易大盘)
  if ([...core].length <= 2) {
    for (const it of items) {
      if (byKey.has(it.key) || !(titleCore(it, loc).includes(core) || (it.fullTitle !== undefined && queryCore(it.fullTitle, loc).includes(core)))) continue;
      const days = it.lastSeen ? Math.max(0, (now.getTime() - Date.parse(it.lastSeen)) / 86_400_000) : 365;
      let score = 2 + Math.min(0.4, Math.log2(1 + it.count) * 0.1) + Math.max(0, 1 - days / 60) * 0.3 + (it.kind === 'artifact' || it.kind === 'local' ? 0.2 : 0);
      if (it.weakTitle) score *= 0.6;
      byKey.set(it.key, { item: it, score, aliasHit: false });
    }
  }
  // what the AI made comes first and alone; links that were only mentioned join (at the end) when the user asks for
  // web pages / links / articles, or when nothing the AI made matches
  const all = [...byKey.values()].sort((a, b) => b.score - a.score || KIND_RANK[b.item.kind] - KIND_RANK[a.item.kind]);
  const made = all.filter((c) => isProduct(c.item));
  const wantsWeb = WEB_WORDS.test(query);
  const ordered = made.length === 0 || wantsWeb ? [...made, ...all.filter((c) => !isProduct(c.item))] : made;
  // one row per name: the same dashboard seen as a service, a Claude page and a file shows once (the higher score)
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of ordered) {
    const t = queryCore(displayTitle(c.item), loc) || c.item.key;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

const KIND_RANK: Record<string, number> = { local: 4, artifact: 3, web: 2, file: 1 };

/** 弱网页：没有标题、只在对话里出现过一次。检索降权，且不发给模型挑选 */
export function isWeakWeb(it: SavedItem): boolean {
  return it.kind === 'web' && !it.title.trim() && it.count <= 1;
}

/** 不需要问模型的情况：别名命中，或第一名标题完整包含查询词且明显领先 */
/** 候选里有哪些在「非泛词」上和查询对得上（标题、上下文或同会话主题词） */
export function specificHits(query: string, c: Candidate[]): Candidate[] {
  const generic = genericFor(query);
  const qg = [...grams(queryCore(query))].filter((g) => !generic.has(g));
  if (qg.length === 0) return [];
  return c.filter((x) => {
    const bag = grams(`${x.item.title} ${x.item.contexts.join(' ')} ${x.item.sessionKeywords ?? ''}`);
    return qg.some((g) => bag.has(g));
  });
}

/** 最高分低于它就先刷新一次索引再查 */
export const REFRESH_BELOW = 2;

/** Kept for callers that pass only candidates: same rule as decide() (the query's own exact title wins) */
export function obviousWinner(c: Candidate[], _core?: string): Candidate | null {
  return decide(c);
}

const KIND_LABEL: Record<string, string> = { artifact: 'Claude 页面', local: '本机服务', web: '网页', file: '本地文件' };

/** 给模型看的候选描述：只有标题、关键词、类型，不含 URL */
export function describeForModel(c: Candidate[]): string {
  const noUrl = (t: string) => t.replace(/https?:\/\/\S+/g, '').replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, '').replace(/\/[\w./-]{3,}/g, '').trim();
  return c.map((x, i) => `${i + 1}. [${KIND_LABEL[x.item.kind] ?? x.item.kind}] ${noUrl(x.item.title) || '(无标题)'} —— 关键词：${noUrl(x.item.contexts[0] ?? '').slice(0, 60)}`).join('\n');
}

/** Structured item for UIs (RPC opened / candidates / search). URL stays on this machine, never goes to the model */
export function openedInfo(it: SavedItem, score?: number): OpenedInfo {
  return {
    key: it.key, title: displayTitle(it), url: it.url, kind: it.kind, lastSeen: it.lastSeen, firstSeen: it.firstSeen,
    ...(it.sessions?.length ? { session: it.sessions[it.sessions.length - 1] } : {}),
    ...(score !== undefined ? { score: Math.round(score * 1000) / 1000 } : {}),
  };
}

/** The candidate's title (not just its context) contains a specific word of the query (time words excluded) */
export function titleBacks(query: string, c: Candidate): boolean {
  if (c.aliasHit) return true;
  const generic = genericFor(query);
  const base = queryCore(extractTimeHint(query).query); // time words say when, not what
  const qg = [...grams(base)].filter((g) => !generic.has(g));
  const tg = grams(`${c.item.title} ${c.item.fullTitle ?? ''}${virtualTags(c.item)}`);
  return qg.length === 0 || qg.some((g) => tg.has(g));
}

/**
 * Can the local index answer this alone, without asking the model? (aliases, the exact title, or a clear lead)
 * `strict` (a model is available): only an alias, an exact unique title, or a big lead (≥4 and ≥2× the runner-up).
 */
export function strongLocalWinner(c: Candidate[], _core: string, strict: boolean): Candidate | null {
  const w = decide(c);
  if (!w || !strict) return w;
  // a model is available to double-check: answer locally only for an alias, the exact name, or a big lead by name
  if (w.aliasHit || w.match?.exact) return w;
  const next = shortlist(c).find((x) => x !== w);
  return w.match && w.match.nouns > 0 && w.match.inName === w.match.nouns && (!next || w.score >= next.score * 2) ? w : null;
}

// ───────────────────────── 存取 ─────────────────────────

const readJson = readJsonSync;

/** 索引目录里的小文件：600 权限、pid 临时文件 + rename */
export function writePrivateSync(p: string, data: unknown): void {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  atomicWriteJsonSync(p, data, { mode: 0o600, indent: 1 });
}

export interface SavedStore {
  items(): SavedItem[];
  aliases(): Aliases;
  setAlias(alias: string, key: string): void;
  lastOpened(): string | null;
  setLastOpened(key: string): void;
  /** 索引文件更新后重新读取 */
  reload(): void;
}

/** Parsed items.json by path, reused while the file is unchanged (va serve answers a search per keystroke) */
const itemsMemo = new Map<string, { mtimeMs: number; size: number; items: SavedItem[] }>();

function readItemsMemo(path: string): SavedItem[] {
  let st;
  try { st = statSync(path); } catch { return []; }
  const m = itemsMemo.get(path);
  if (m && m.mtimeMs === st.mtimeMs && m.size === st.size) return m.items;
  const items = readJson<SavedItem[]>(path, []);
  itemsMemo.set(path, { mtimeMs: st.mtimeMs, size: st.size, items });
  return items;
}

export function fileStore(indexDir: string): SavedStore {
  let cache: SavedItem[] | null = null;
  return {
    items: () => (cache ??= readItemsMemo(`${indexDir}/items.json`)),
    reload() { cache = null; itemsMemo.delete(`${indexDir}/items.json`); },
    aliases: () => readJson<Aliases>(`${indexDir}/aliases.json`, {}),
    setAlias(alias, key) {
      // 加锁 → 重读 → 合并 → 原子写：并发的两个 va 各记一个别名，两个都要留下
      mkdirSync(indexDir, { recursive: true, mode: 0o700 });
      updateJsonSync<Aliases, void>(`${indexDir}/aliases.json`, () => ({}), (a) => {
        a[queryCore(alias)] = key;
        return { data: a, result: undefined };
      }, { mode: 0o600, indent: 1 });
    },
    lastOpened: () => readJson<{ key?: string }>(`${indexDir}/last_opened.json`, {}).key ?? null,
    setLastOpened(key) {
      writePrivateSync(`${indexDir}/last_opened.json`, { key, at: new Date().toISOString() });
    },
  };
}

export function memoryStore(items: SavedItem[], aliases: Aliases = {}): SavedStore & { _aliases: Aliases } {
  let last: string | null = null;
  const st = {
    _aliases: { ...aliases },
    items: () => items,
    aliases: () => st._aliases,
    setAlias(alias: string, key: string) { st._aliases[queryCore(alias)] = key; },
    lastOpened: () => last,
    setLastOpened(key: string) { last = key; },
    reload() {},
  };
  return st;
}
