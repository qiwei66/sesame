/** applescript: predefined system actions only (volume, reminders, activate/quit app, Finder) — no free-form scripts */
import { tr } from '../../src/i18n.ts';
import type { Args, ExecContext, ToolResult, ToolSpec } from '../../src/types.ts';
import { confirmOrPlan, dirPath, num, obj, osa, plan, str } from '../../src/tool-helpers.ts';
import { resolveApp } from '../../src/apps.ts';

export function reminderDate(now: Date, dayOffset: number, time: string): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59 || !Number.isInteger(dayOffset) || dayOffset < 0 || dayOffset > 365) return null;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, h, mi, 0, 0);
  return d;
}

const fmtDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

type AsAction = (p: Args, ctx: ExecContext) => Promise<ToolResult>;

const VOLUME_SCRIPT = `on run argv
set delta to (item 1 of argv) as integer
set v to (output volume of (get volume settings)) + delta
if v < 0 then set v to 0
if v > 100 then set v to 100
set volume output volume v
return v
end run`;

export const APPLESCRIPT_ACTIONS: Record<string, { description: string; exec: AsAction }> = {
  volume_down: {
    description: '音量调小。params: {step?: 1-50，默认 12}',
    async exec(p, ctx) {
      const step = Math.min(50, Math.max(1, num(p.step, 12)));
      if (ctx.dryRun) return plan(ctx, tr(`音量调小 ${step}`, `volume down ${step}`));
      const r = await osa(ctx, VOLUME_SCRIPT, [String(-step)]);
      return r.ok ? { ok: true, display: tr(`音量已调到 ${r.out}`, `Volume set to ${r.out}`) } : { ok: false, display: tr(`调音量失败：${r.err}`, `Failed to change volume: ${r.err}`) };
    },
  },
  volume_up: {
    description: '音量调大。params: {step?: 1-50，默认 12}',
    async exec(p, ctx) {
      const step = Math.min(50, Math.max(1, num(p.step, 12)));
      if (ctx.dryRun) return plan(ctx, tr(`音量调大 ${step}`, `volume up ${step}`));
      const r = await osa(ctx, VOLUME_SCRIPT, [String(step)]);
      return r.ok ? { ok: true, display: tr(`音量已调到 ${r.out}`, `Volume set to ${r.out}`) } : { ok: false, display: tr(`调音量失败：${r.err}`, `Failed to change volume: ${r.err}`) };
    },
  },
  set_volume: {
    description: '音量设为指定值。params: {level: 0-100}',
    async exec(p, ctx) {
      const level = Math.min(100, Math.max(0, num(p.level, -1)));
      if (num(p.level, -1) < 0) return { ok: false, display: tr('set_volume 缺少 level', 'set_volume needs a level') };
      if (ctx.dryRun) return plan(ctx, tr(`音量设为 ${level}`, `set volume to ${level}`));
      const r = await osa(ctx, 'on run argv\nset volume output volume ((item 1 of argv) as integer)\nend run', [String(level)]);
      return r.ok ? { ok: true, display: tr(`音量已设为 ${level}`, `Volume set to ${level}`) } : { ok: false, display: tr(`调音量失败：${r.err}`, `Failed to change volume: ${r.err}`) };
    },
  },
  mute: {
    description: '静音',
    async exec(_p, ctx) {
      if (ctx.dryRun) return plan(ctx, tr('静音', 'mute'));
      const r = await osa(ctx, 'set volume with output muted');
      return r.ok ? { ok: true, display: tr('已静音', 'Muted') } : { ok: false, display: tr(`静音失败：${r.err}`, `Failed to mute: ${r.err}`) };
    },
  },
  unmute: {
    description: '取消静音',
    async exec(_p, ctx) {
      if (ctx.dryRun) return plan(ctx, tr('取消静音', 'unmute'));
      const r = await osa(ctx, 'set volume without output muted');
      return r.ok ? { ok: true, display: tr('已取消静音', 'Unmuted') } : { ok: false, display: tr(`取消静音失败：${r.err}`, `Failed to unmute: ${r.err}`) };
    },
  },
  create_reminder: {
    description: '在「提醒事项」新建提醒。params: {title: 提醒内容, day_offset: 相对今天的天数（今天0/明天1/后天2）, time: "HH:MM" 24小时制}。必须用相对天数，不要写绝对日期',
    async exec(p, ctx) {
      const title = str(p.title).trim();
      const d = reminderDate(ctx.now(), num(p.day_offset, 0), str(p.time) || '09:00');
      if (!title || !d) return { ok: false, display: tr(`提醒参数不合法：title=${title} day_offset=${str(p.day_offset)} time=${str(p.time)}`, `Invalid reminder: title=${title} day_offset=${str(p.day_offset)} time=${str(p.time)}`) };
      const what = tr(`在提醒事项新建「${title}」，时间 ${fmtDate(d)}`, `create reminder "${title}" at ${fmtDate(d)}`);
      if (ctx.dryRun) return plan(ctx, what);
      const script = `on run argv
set t to item 1 of argv
set d to current date
set day of d to 1
set year of d to (item 2 of argv) as integer
set month of d to (item 3 of argv) as integer
set day of d to (item 4 of argv) as integer
set hours of d to (item 5 of argv) as integer
set minutes of d to (item 6 of argv) as integer
set seconds of d to 0
tell application "Reminders" to make new reminder with properties {name:t, due date:d, remind me date:d}
end run`;
      const r = await osa(ctx, script, [title, String(d.getFullYear()), String(d.getMonth() + 1), String(d.getDate()), String(d.getHours()), String(d.getMinutes())]);
      return r.ok ? { ok: true, display: tr(`已提醒：${fmtDate(d)} ${title}`, `Reminder set: ${fmtDate(d)} ${title}`) } : { ok: false, display: tr(`建提醒失败：${r.err}`, `Failed to create reminder: ${r.err}`) };
    },
  },
  activate_app: {
    description: '切换到（激活）某个已打开的 App。params: {name: App 名或中文名}',
    async exec(p, ctx) {
      const app = resolveApp(str(p.name));
      if (!app) return { ok: false, display: tr(`没找到应用「${str(p.name)}」`, `App not found: "${str(p.name)}"`) };
      if (ctx.dryRun) return plan(ctx, tr(`切换到 ${app}`, `switch to ${app}`));
      const r = await osa(ctx, 'on run argv\ntell application (item 1 of argv) to activate\nend run', [app]);
      return r.ok ? { ok: true, display: tr(`已切换到 ${app}`, `Switched to ${app}`) } : { ok: false, display: tr(`切换失败：${r.err}`, `Failed to switch: ${r.err}`) };
    },
  },
  quit_app: {
    description: '退出某个 App（会先弹窗确认，防止丢未保存内容）。params: {name: App 名或中文名}',
    async exec(p, ctx) {
      const app = resolveApp(str(p.name));
      if (!app) return { ok: false, display: tr(`没找到应用「${str(p.name)}」`, `App not found: "${str(p.name)}"`) };
      const what = tr(`退出 ${app}`, `quit ${app}`);
      const c = await confirmOrPlan(ctx, tr(`确定要退出 ${app} 吗？未保存的内容可能丢失。`, `Quit ${app}? Unsaved changes may be lost.`), what);
      if (c === 'dry') return { ok: true, display: tr(`（演练）确认后${what}`, `(dry run) after confirmation: ${what}`), dryRun: true };
      if (c === 'no') return { ok: true, display: tr(`已取消：${what}`, `Cancelled: ${what}`) };
      const r = await osa(ctx, 'on run argv\ntell application (item 1 of argv) to quit\nend run', [app]);
      return r.ok ? { ok: true, display: tr(`已退出 ${app}`, `Quit ${app}`) } : { ok: false, display: tr(`退出失败：${r.err}`, `Failed to quit: ${r.err}`) };
    },
  },
  finder_open: {
    description: '在访达打开目录。params: {dir: "downloads" | "documents" | "desktop"}',
    async exec(p, ctx) {
      const dir = dirPath(ctx, p.dir);
      if (!dir) return { ok: false, display: tr(`不支持的目录：${str(p.dir)}`, `Unsupported folder: ${str(p.dir)}`) };
      if (ctx.dryRun) return plan(ctx, `open ${dir}`);
      const r = await ctx.run('open', [dir]);
      return r.code === 0 ? { ok: true, display: tr(`已打开 ${dir.replace(ctx.home, '~')}`, `Opened ${dir.replace(ctx.home, '~')}`) } : { ok: false, display: tr(`打开失败：${r.stderr}`, `Failed to open: ${r.stderr}`) };
    },
  },
};

const asIds = Object.keys(APPLESCRIPT_ACTIONS);

export const applescriptTool: ToolSpec = {
  name: 'applescript',
  description: `执行预定义的系统动作（不能写任意脚本）。action 可选：${asIds.map((k) => `${k}（${APPLESCRIPT_ACTIONS[k].description}）`).join('；')}`,
  parameters: obj({
    action: { type: 'string', enum: asIds },
    params: { type: 'object', description: '该动作的参数对象，没有参数就传 {}' },
  }, ['action']),
  readOnly: false,
  // 提醒是一次性的（「明天 9 点提醒我交材料」回放 = 再建一条重复提醒），不缓存
  cachePolicy: (a) => (a.action === 'create_reminder' ? 'never' : 'auto'),
  // quit_app asks for confirmation itself (confirmOrPlan)
  needsConfirm: (a) => a.action === 'quit_app',
  confirmHandled: true,
  async exec(a, ctx) {
    const act = APPLESCRIPT_ACTIONS[str(a.action)];
    if (!act) return { ok: false, display: tr(`不支持的动作：${str(a.action)}`, `Unsupported action: ${str(a.action)}`) };
    const p = (a.params && typeof a.params === 'object' && !Array.isArray(a.params) ? a.params : {}) as Args;
    return act.exec(p, ctx);
  },
};
