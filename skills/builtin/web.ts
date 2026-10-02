/** open_url: open an http(s) URL in the default browser */
import { tr } from '../../src/i18n.ts';
import type { ToolSpec } from '../../src/types.ts';
import { obj, plan, str } from '../../src/tool-helpers.ts';

export const openUrlTool: ToolSpec = {
  name: 'open_url',
  description: '用默认浏览器打开一个 http/https 网址。只用确定存在的网址，不要编造',
  parameters: obj({ url: { type: 'string', description: '完整网址，http:// 或 https:// 开头' } }, ['url']),
  readOnly: false,
  async exec(a, ctx) {
    const url = str(a.url).trim();
    let u: URL;
    try { u = new URL(url); } catch { return { ok: false, display: tr(`网址不合法：${url}`, `Invalid URL: ${url}`) }; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, display: tr(`只允许 http/https：${url}`, `Only http/https allowed: ${url}`) };
    const opened = { title: u.host.replace(/^www\./, ''), url: u.href, kind: 'web' };
    if (ctx.dryRun) return { ...plan(ctx, `open "${u.href}"`), opened };
    const r = await ctx.run('open', [u.href]);
    return r.code === 0 ? { ok: true, display: tr(`已打开 ${u.host}`, `Opened ${u.host}`), opened } : { ok: false, display: tr(`打开网址失败：${r.stderr.trim()}`, `Failed to open URL: ${r.stderr.trim()}`) };
  },
};
