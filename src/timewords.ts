/**
 * Spoken time words in a saved-item query ("昨天的报告", "最近做的 PR", "the dashboard from last week").
 * They say WHEN the thing was made, not what it is called, so they are removed from the text query and turned
 * into a date window (weighted, not a hard filter: speech is vague and items keep their own first/last seen time).
 */

export interface TimeHint {
  /** matched phrase, for logs */
  word: string;
  /** inclusive window start / exclusive end; absent for "recent" */
  from?: Date;
  to?: Date;
  /** "最近 / recently / latest": favor the newest items */
  recent?: boolean;
}

const DAY = 86_400_000;

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Monday 00:00 of d's week (local time) */
function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  const dow = (x.getDay() + 6) % 7; // Mon=0 … Sun=6
  return new Date(x.getTime() - dow * DAY);
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

type Rule = { re: RegExp; hint: (now: Date) => Omit<TimeHint, 'word'> };

const day = (offset: number) => (now: Date) => {
  const s = startOfDay(now).getTime() + offset * DAY;
  return { from: new Date(s), to: new Date(s + DAY) };
};

// Longest phrases first so "前天" is not read as "天", "上个月" before "上月"
const RULES: Rule[] = [
  { re: /大前天|the day before the day before yesterday/i, hint: day(-3) },
  { re: /前天|the day before yesterday/i, hint: day(-2) },
  { re: /昨天|昨日|昨晚|yesterday|last night/i, hint: day(-1) },
  { re: /今天|今日|today|tonight|this morning/i, hint: day(0) },
  { re: /上上周|上上个?星期|two weeks ago/i, hint: (now) => { const w = startOfWeek(now).getTime(); return { from: new Date(w - 14 * DAY), to: new Date(w - 7 * DAY) }; } },
  { re: /上周|上个?星期|上个?礼拜|last week/i, hint: (now) => { const w = startOfWeek(now).getTime(); return { from: new Date(w - 7 * DAY), to: new Date(w) }; } },
  { re: /这周|本周|这个?星期|这个?礼拜|this week/i, hint: (now) => ({ from: startOfWeek(now), to: new Date(now.getTime() + DAY) }) },
  { re: /上个?月|last month/i, hint: (now) => { const m = startOfMonth(now); return { from: new Date(m.getFullYear(), m.getMonth() - 1, 1), to: m }; } },
  { re: /这个?月|本月|this month/i, hint: (now) => ({ from: startOfMonth(now), to: new Date(now.getTime() + DAY) }) },
  { re: /最近|近期|刚才|刚刚|之前那个|最新|recently|recent|latest|newest|just now|earlier today/i, hint: () => ({ recent: true }) },
];

/** Words around a time phrase that carry no meaning once it is gone: "从…来的", "做的", "from", "made" … */
const ZH_GLUE = /(让\s*claude\s*)?(做|弄|搞|写|生成|发|给)(过)?(的|了的)/gi;
const EN_GLUE = /\b(from|made|built|created|done|that i|i made|i built|we made)\b/gi;

/** Pull the first time phrase out of a query. Returns the query without it (and without the glue words) */
export function extractTimeHint(query: string, now: Date = new Date()): { query: string; hint: TimeHint | null } {
  for (const r of RULES) {
    const m = r.re.exec(query);
    if (!m) continue;
    const rest = (query.slice(0, m.index) + ' ' + query.slice(m.index + m[0].length)).replace(ZH_GLUE, ' ').replace(EN_GLUE, ' ').replace(/\s+/g, ' ').trim();
    return { query: rest, hint: { word: m[0], ...r.hint(now) } };
  }
  return { query, hint: null };
}

/**
 * Score adjustment for an item given a time hint.
 *  - window: seen inside it (first or last seen, ±3h slack) → ×1.3 + 1.5; otherwise ×0.4 (kept, ranked lower)
 *  - recent: up to +3 for items seen in the last 7 days, linearly decaying
 */
export function timeWeight(hint: TimeHint, firstSeen: string | undefined, lastSeen: string | undefined, now: Date): { add: number; mul: number } {
  const ts = [firstSeen, lastSeen].map((s) => (s ? Date.parse(s) : NaN)).filter((t) => Number.isFinite(t));
  if (hint.recent) {
    const newest = ts.length ? Math.max(...ts) : 0;
    const days = newest ? Math.max(0, (now.getTime() - newest) / DAY) : 365;
    return { add: Math.max(0, 1 - days / 7) * 3, mul: 1 };
  }
  if (hint.from && hint.to) {
    const slack = 3 * 3_600_000;
    const f = hint.from.getTime() - slack;
    const t = hint.to.getTime() + slack;
    const inside = ts.some((x) => x >= f && x < t);
    // spans the window (first seen before, last seen after): it existed then, count it as inside too
    const spans = ts.length === 2 && ts[0] < f && ts[1] >= t;
    return inside || spans ? { add: 1.5, mul: 1.3 } : { add: 0, mul: 0.4 };
  }
  return { add: 0, mul: 1 };
}
