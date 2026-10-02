/**
 * Example user skill. Copy to ~/.config/voice-agent/skills/open_ticket.ts and edit the tracker URL.
 * No imports from the repo: helpers arrive as `api`.
 */
import type { SkillApi } from '../../src/skills.ts';
import type { ToolSpec } from '../../src/types.ts';

export default (api: SkillApi): ToolSpec => ({
  name: 'open_ticket',
  description: 'Open a ticket in the issue tracker by number, e.g. "open ticket 123" / 「打开工单 123」',
  parameters: api.obj({ number: { type: 'integer', description: 'ticket number' } }, ['number']),
  readOnly: false,
  cachePolicy: 'auto',
  locale: 'all',
  async exec(args, ctx) {
    const n = Number(args.number);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, display: `not a ticket number: ${api.str(args.number)}` };
    const url = `https://tracker.example.com/t/${n}`;
    if (ctx.dryRun) return api.plan(ctx, `open ${url}`);
    const r = await ctx.run('open', [url]);
    return r.code === 0 ? { ok: true, display: `Opened ticket ${n}` } : { ok: false, display: `open failed: ${r.stderr.trim()}` };
  },
});
