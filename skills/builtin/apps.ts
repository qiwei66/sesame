/** open_app: open an installed Mac app by (localized / fuzzy) name */
import { tr } from '../../src/i18n.ts';
import type { ToolSpec } from '../../src/types.ts';
import { obj, plan, str } from '../../src/tool-helpers.ts';
import { resolveApp } from '../../src/apps.ts';

export const openAppTool: ToolSpec = {
  name: 'open_app',
  description: '打开一个 Mac App。name 可用中文名（飞书、微信、浏览器…）或 App 英文名',
  parameters: obj({ name: { type: 'string', description: 'App 中文名或英文名' } }, ['name']),
  readOnly: false,
  async exec(a, ctx) {
    const app = resolveApp(str(a.name));
    if (!app) return { ok: false, display: tr(`没找到应用「${str(a.name)}」`, `App not found: "${str(a.name)}"`) };
    const opened = { title: app, url: '', kind: 'app' };
    if (ctx.dryRun) return { ...plan(ctx, `open -a "${app}"`), opened };
    const r = await ctx.run('open', ['-a', app]);
    return r.code === 0 ? { ok: true, display: tr(`已打开 ${app}`, `Opened ${app}`), opened } : { ok: false, display: tr(`打开 ${app} 失败：${r.stderr.trim()}`, `Failed to open ${app}: ${r.stderr.trim()}`) };
  },
};
