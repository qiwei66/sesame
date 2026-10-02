/**
 * Preloaded into the core under evaluation (`node --import`): shifts the clock to SESAME_EVAL_NOW so time words
 * ("昨天", "上周", "最近") are judged against the moment the answers were labelled, not today. Time keeps flowing
 * from there (timeouts still work). Used only by scripts/eval-real.ts.
 */
const target = Date.parse(process.env.SESAME_EVAL_NOW ?? '');
if (Number.isFinite(target)) {
  const RealDate = Date;
  const offset = target - RealDate.now();
  class ShiftedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...(args as [string]));
    }
    static now(): number { return RealDate.now() + offset; }
  }
  globalThis.Date = ShiftedDate as DateConstructor;
}
