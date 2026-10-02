import { AsyncLocalStorage } from 'node:async_hooks';
/**
 * Language packs for the literal (non-semantic) text processing layers:
 *  - normalize: leading/trailing filler words stripped from cache keys
 *  - saved: generic words (down-weighted in retrieval) and stop words (removed from queries)
 * Locale is picked per input: config `locale: zh|en` forces one; `auto` (default) → zh when the text contains Han characters, else en.
 */

export type Locale = 'zh' | 'en';
export type LocaleSetting = Locale | 'auto';

export interface LangPack {
  leadingFillers: readonly string[];
  trailingFillers: readonly string[];
  /** Generic words: matching only these does not count as "found it" */
  genericWords: readonly string[];
  /** Verbs / function words removed from saved-item queries */
  stopRe: RegExp;
  /** Detects "I want a website" style queries (web/local items preferred over files) */
  siteRe: RegExp;
}

export const ZH: LangPack = {
  leadingFillers: [
    '嗯', '呃', '额', '那个', '哎', '诶', '喂',
    '麻烦你', '麻烦', '请你', '请', '你帮我', '帮我', '给我', '替我', '我想', '我要', '能不能', '可以',
  ],
  trailingFillers: ['一下子', '一下', '好吗', '好不好', '可以吗', '行吗', '谢谢', '吧', '呢', '啊', '呀', '哈', '嘛', '哦', '喔'],
  genericWords: ['官网', '网站', '看板', '页面', '周报', '手册', '报告', '清单', '文档', '链接', '首页', '网页', '那个', '一下', '打开', '项目'],
  stopRe: /(帮我|给我|请|麻烦|打开|开一下|开下|看一下|看下|看看|瞧瞧|调出|调出来|找一下|找到|找|那个|这个|一下|我的|咱们的|我们的|的|吧|呢|啊|页面|链接|网页)/g,
  siteRe: /官网|网站|站点|网页|主页|首页|演示站|demo/i,
};

/**
 * English fillers are matched on the punctuation/space-stripped lower-case string (normalize removes spaces first),
 * so multi-word fillers are written without spaces: "canyou" = "can you".
 */
export const EN: LangPack = {
  leadingFillers: ['um', 'uh', 'hey', 'please', 'canyou', 'couldyou', 'wouldyou', 'canyouplease', 'couldyouplease', 'iwantto', 'iwant', 'idliketo', 'letme', 'helpme', 'kindly'],
  trailingFillers: ['please', 'thanks', 'thankyou', 'forme', 'now', 'rightnow', 'quickly'],
  genericWords: ['dashboard', 'page', 'site', 'website', 'report', 'doc', 'docs', 'document', 'link', 'home', 'homepage', 'project', 'list', 'manual', 'guide', 'the', 'my', 'open'],
  stopRe: /\b(please|open|show|show me|bring up|pull up|launch|find|go to|look at|view|the|my|our|a|an|that|this|for me|up|page|link)\b/g,
  siteRe: /\b(website|site|homepage|landing page|demo)\b/i,
};

export const PACKS: Record<Locale, LangPack> = { zh: ZH, en: EN };

export function detectLocale(text: string, setting: LocaleSetting = 'auto'): Locale {
  if (setting === 'zh' || setting === 'en') return setting;
  if (/\p{Script=Han}/u.test(text)) return 'zh';
  // no letters at all (empty / digits / punctuation) → the default output language
  return /\p{L}/u.test(text) ? 'en' : fallbackOut;
}

export function packFor(text: string, setting: LocaleSetting = 'auto'): LangPack {
  return PACKS[detectLocale(text, setting)];
}

/** System locale (for prompt language when config says auto and there is no input yet) */
export function systemLocale(env: NodeJS.ProcessEnv = process.env): Locale {
  const l = env.VA_LOCALE || env.LC_ALL || env.LC_MESSAGES || env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || '';
  return /^zh/i.test(l) ? 'zh' : 'en';
}

// ── Output language for user-facing strings (results, dialogs, plan lines, doctor) ──
// Scoped per request with AsyncLocalStorage so concurrent RPC requests in different languages don't mix.
const outStore = new AsyncLocalStorage<Locale>();
let fallbackOut: Locale = 'zh';

/** Run fn with user-facing strings in `locale` */
export function withLocale<T>(locale: Locale, fn: () => T): T {
  return outStore.run(locale, fn);
}

/** Language for strings outside any withLocale scope (CLI startup, doctor) */
export function setDefaultOutputLocale(l: Locale): void {
  fallbackOut = l;
}

export function outLocale(): Locale {
  return outStore.getStore() ?? fallbackOut;
}

/** Language for no-input output (doctor …): config.ui_locale, or the system language when auto */
export function uiLocale(cfg: { ui_locale: LocaleSetting }, env: NodeJS.ProcessEnv = process.env): Locale {
  return cfg.ui_locale === 'zh' || cfg.ui_locale === 'en' ? cfg.ui_locale : systemLocale(env);
}

/** Pick the zh or en variant of a user-facing string */
export function tr(zh: string, en: string): string {
  return outLocale() === 'en' ? en : zh;
}
