/** run_shell: whitelisted read-only commands (builtin + commands.yaml, compiled to fixed argv) */
import { outLocale, tr } from '../../src/i18n.ts';
import type { ExecContext, ToolResult, ToolSpec } from '../../src/types.ts';
import { confirmOrPlan, obj, str } from '../../src/tool-helpers.ts';

export interface ShellCmd {
  description: string;
  allowedArgs?: string[][]; // 每个位置允许的取值
  exec: (args: string[], ctx: ExecContext) => Promise<ToolResult>;
  /** builtin | command:<file> */
  origin?: string;
  needsConfirm?: boolean;
}

/** Builtin read-only queries. User commands (commands.yaml) are merged in front of these at startup. */
export const BUILTIN_SHELL: Record<string, ShellCmd> = {
  disk_free: {
    description: '查本机磁盘剩余空间',
    async exec(_args, ctx) {
      const r = await ctx.run('df', ['-k', '/System/Volumes/Data']);
      const line = r.stdout.trim().split('\n').pop() ?? '';
      const cols = line.split(/\s+/);
      const total = Number(cols[1]) / 1024 / 1024;
      const avail = Number(cols[3]) / 1024 / 1024;
      if (r.code !== 0 || !Number.isFinite(avail)) return { ok: false, display: tr(`磁盘查询失败：${r.stderr.trim()}`, `Disk query failed: ${r.stderr.trim()}`) };
      return { ok: true, display: tr(`磁盘剩余 ${avail.toFixed(1)} GB / 共 ${total.toFixed(0)} GB（已用 ${cols[4]}）`, `Disk: ${avail.toFixed(1)} GB free of ${total.toFixed(0)} GB (${cols[4]} used)`), data: { avail_gb: +avail.toFixed(1), total_gb: +total.toFixed(0) } };
    },
  },
  battery: {
    description: '查电量与充电状态',
    async exec(_args, ctx) {
      const r = await ctx.run('pmset', ['-g', 'batt']);
      const m = r.stdout.match(/(\d+)%;\s*([^;]+);/);
      if (!m) return { ok: false, display: tr(`电量查询失败：${r.stdout.trim().slice(0, 120)}`, `Battery query failed: ${r.stdout.trim().slice(0, 120)}`) };
      const stateMap: Record<string, string> = outLocale() === 'en'
        ? { charging: 'charging', discharging: 'on battery', charged: 'fully charged', 'AC attached': 'on AC, not charging', finishing: 'almost full' }
        : { charging: '充电中', discharging: '使用电池', charged: '已充满', 'AC attached': '接通电源未充电', finishing: '即将充满' };
      const st = stateMap[m[2].trim()] ?? m[2].trim();
      return { ok: true, display: tr(`电量 ${m[1]}%，${st}`, `Battery ${m[1]}%, ${st}`), data: { percent: Number(m[1]), state: m[2].trim() } };
    },
  },
  ip_info: {
    description: '查本机内网 IP 与公网出口 IP',
    async exec(_args, ctx) {
      let local = '';
      for (const ifc of ['en0', 'en1']) {
        const r = await ctx.run('ipconfig', ['getifaddr', ifc]);
        if (r.code === 0 && r.stdout.trim()) { local = r.stdout.trim(); break; }
      }
      const pub = await ctx.run('curl', ['-s', '-m', '6', 'https://api.ipify.org']);
      const pubIp = pub.code === 0 && /^[\d.:a-f]+$/i.test(pub.stdout.trim()) ? pub.stdout.trim() : '获取失败';
      return { ok: Boolean(local) || pubIp !== '获取失败', display: tr(`内网 IP ${local || '无'}，公网出口 IP ${pubIp}`, `Local IP ${local || 'none'}, public IP ${pubIp === '获取失败' ? 'unavailable' : pubIp}`), data: { local, public: pubIp } };
    },
  },
  network_status: {
    description: '查网络是否通（默认网卡 + 国内站点连通性）',
    async exec(_args, ctx) {
      const route = await ctx.run('route', ['-n', 'get', 'default']);
      const ifc = route.stdout.match(/interface:\s*(\S+)/)?.[1] ?? '无';
      const r = await ctx.run('curl', ['-s', '-o', '/dev/null', '-m', '6', '-w', '%{http_code}', 'https://www.baidu.com']);
      const ok = r.stdout.trim().startsWith('2') || r.stdout.trim().startsWith('3');
      return { ok: true, display: tr(`默认网卡 ${ifc}，访问百度${ok ? '正常' : `失败（${r.stdout.trim() || r.code}）`}`, `Default interface ${ifc}, baidu.com ${ok ? 'reachable' : `unreachable (${r.stdout.trim() || r.code})`}`), data: { interface: ifc, baidu_http: r.stdout.trim() } };
    },
  },
};

/**
 * Live whitelist = user commands (commands.yaml, first) + builtins. Mutated in place by installCommands
 * so the run_shell description lists user commands first (stable order → stable TOOLS_VERSION).
 */
export const SHELL_WHITELIST: Record<string, ShellCmd> = { ...BUILTIN_SHELL };

export function installCommands(user: Record<string, ShellCmd>): void {
  for (const k of Object.keys(SHELL_WHITELIST)) delete SHELL_WHITELIST[k];
  for (const [k, v] of Object.entries(user)) if (!(k in BUILTIN_SHELL)) SHELL_WHITELIST[k] = v;
  for (const [k, v] of Object.entries(BUILTIN_SHELL)) SHELL_WHITELIST[k] = { ...v, origin: 'builtin' };
}

const shellIds = () => Object.keys(SHELL_WHITELIST);

export const runShellTool: ToolSpec = {
  name: 'run_shell',
  // getters: commands.yaml is merged into SHELL_WHITELIST at startup, after this module loads
  get description() {
    return `运行白名单里的只读查询命令。command_id 可选：${shellIds().map((k) => `${k}（${SHELL_WHITELIST[k].description}）`).join('；')}`;
  },
  get parameters() {
    return obj({
      command_id: { type: 'string', enum: shellIds() },
      args: { type: 'array', items: { type: 'string' }, description: '命令参数，只有部分命令需要' },
    }, ['command_id']);
  },
  readOnly: true,
  needsConfirm: (a) => Boolean(SHELL_WHITELIST[str(a.command_id)]?.needsConfirm),
  confirmHandled: true,
  async exec(a, ctx) {
    const id = str(a.command_id);
    const cmd = SHELL_WHITELIST[id];
    if (!cmd) return { ok: false, display: tr(`命令不在白名单：${id}`, `Command not in the whitelist: ${id}`) };
    const args = Array.isArray(a.args) ? a.args.map((x) => str(x)) : [];
    const allowed = cmd.allowedArgs ?? [];
    if (args.length > allowed.length) return { ok: false, display: tr(`${id} 不接受这么多参数`, `${id} does not take that many arguments`) };
    for (let i = 0; i < args.length; i++) {
      if (!allowed[i].includes(args[i])) return { ok: false, display: tr(`${id} 参数不在白名单：${args[i]}`, `${id} argument not allowed: ${args[i]}`) };
    }
    if (cmd.needsConfirm) {
      const what = tr(`运行 ${id}${args.length ? ` ${args.join(' ')}` : ''}`, `run ${id}${args.length ? ` ${args.join(' ')}` : ''}`);
      const c = await confirmOrPlan(ctx, tr(`确定要${what}吗？`, `Really ${what}?`), what);
      if (c === 'dry') return { ok: true, display: tr(`（演练）确认后${what}`, `(dry run) after confirmation: ${what}`), dryRun: true };
      if (c === 'no') return { ok: true, display: tr(`已取消：${what}`, `Cancelled: ${what}`), noCache: true };
    }
    return cmd.exec(args, ctx);
  },
};
