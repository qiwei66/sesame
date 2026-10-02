/** notify / speak: feedback-only tools (never cached) */
import { tr } from '../../src/i18n.ts';
import type { ToolSpec } from '../../src/types.ts';
import { notifyNow, obj, plan, sayArgs, str } from '../../src/tool-helpers.ts';

export const notifyTool: ToolSpec = {
  name: 'notify',
  description: '弹系统通知给用户看（反馈结果用）',
  parameters: obj({ text: { type: 'string' } }, ['text']),
  readOnly: false,
  feedbackOnly: true,
  async exec(a, ctx) {
    const text = str(a.text);
    if (ctx.dryRun) return plan(ctx, tr(`通知「${text}」`, `notify "${text}"`));
    await notifyNow(ctx, text);
    return { ok: true, display: text };
  },
};


export const speakTool: ToolSpec = {
  name: 'speak',
  description: '用中文语音朗读一句话（反馈结果用）',
  parameters: obj({ text: { type: 'string' } }, ['text']),
  readOnly: false,
  feedbackOnly: true,
  async exec(a, ctx) {
    const text = str(a.text);
    if (ctx.dryRun) return plan(ctx, tr(`朗读「${text}」`, `speak "${text}"`));
    await ctx.run('say', sayArgs(text), { timeoutMs: 120_000 });
    return { ok: true, display: text };
  },
};
