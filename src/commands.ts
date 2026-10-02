/**
 * Custom commands (commands.yaml) → run_shell whitelist entries.
 *
 *   commands:
 *     - id: quota_check                 # [a-z0-9_]+, what the model passes as command_id
 *       name: Disk quota                # human label
 *       description: Check my quota. args: ["home"] or ["work"]   # shown to the model
 *       examples: [check my quota, how much quota is left]        # appended to the description
 *       command: [python3, ~/bin/quota.py]                        # fixed argv, no shell, ~ expanded
 *       args: [[home, work]]            # allowed values per extra positional arg (optional)
 *       default_args: [home]            # used when the model passes none (optional)
 *       confirm: false                  # true → ask before running (and never run in dry-run)
 *       timeout_ms: 30000
 *       output:                         # optional: how to turn stdout into the one-line result
 *         json: true
 *         template: "Quota {host|map:work=Work,*=Home}: {left_gb|fixed:1} GB left"
 *
 * Only argv arrays are executed (execFile, no shell): the model can choose a command id and whitelisted
 * argument values, nothing else.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandHome } from './config.ts';
import { parseYaml } from './yaml.ts';
import type { YamlValue } from './yaml.ts';
import type { ShellCmd } from '../skills/builtin/shell.ts';
import type { ExecContext, Json, ToolResult } from './types.ts';

export interface CommandDef {
  id: string;
  name: string;
  description: string;
  examples: string[];
  command: string[];
  args: string[][];
  default_args: string[];
  confirm: boolean;
  timeout_ms: number;
  output: { json: boolean; template?: string };
}

const s = (v: YamlValue | undefined): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const arr = (v: YamlValue | undefined): YamlValue[] => (Array.isArray(v) ? v : []);

export function parseCommands(raw: YamlValue): CommandDef[] {
  const root = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.commands : raw;
  const out: CommandDef[] = [];
  for (const c of arr(root)) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    const id = s(c.id);
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(id)) throw new Error(`commands.yaml: invalid id "${id}" (use [a-z][a-z0-9_]*)`);
    const command = arr(c.command).map(s).filter(Boolean);
    if (command.length === 0) throw new Error(`commands.yaml: ${id}: command must be a non-empty argv list`);
    const o = c.output && typeof c.output === 'object' && !Array.isArray(c.output) ? c.output : {};
    out.push({
      id,
      name: s(c.name) || id,
      description: s(c.description) || s(c.name) || id,
      examples: arr(c.examples).map(s).filter(Boolean),
      command,
      args: arr(c.args).map((a) => arr(a).map(s)),
      default_args: arr(c.default_args).map(s),
      confirm: c.confirm === true,
      timeout_ms: typeof c.timeout_ms === 'number' ? c.timeout_ms : 30_000,
      output: { json: o.json === true, ...(o.template ? { template: s(o.template) } : {}) },
    });
  }
  return out;
}

function getPath(data: unknown, path: string): unknown {
  let cur = data;
  for (const k of path.split('.')) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[k] : undefined;
  return cur;
}

/**
 * `{field|filter:arg|...}` templates. Filters:
 *   fixed:N        number with N decimals
 *   slice:A:B      String(v).slice(A, B)
 *   map:k=v,*=d    value mapping, `*` = default
 * Unknown fields render as empty string.
 */
export function renderTemplate(tpl: string, data: unknown): string {
  return tpl.replace(/\{([^{}]+)\}/g, (_m, expr: string) => {
    const [field, ...filters] = expr.split('|');
    let v: unknown = getPath(data, field.trim());
    for (const f of filters) {
      const [name, ...rest] = f.split(':');
      const argStr = rest.join(':');
      if (name === 'fixed') v = Number(v).toFixed(Number(argStr || 0));
      else if (name === 'slice') { const [a, b] = argStr.split(':').map((x) => (x === '' ? undefined : Number(x))); v = String(v ?? '').slice(a, b); }
      else if (name === 'map') {
        const pairs = Object.fromEntries(argStr.split(',').map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));
        v = pairs[String(v)] ?? pairs['*'] ?? v;
      }
    }
    return v === undefined || v === null ? '' : String(v);
  });
}

export function compileCommand(def: CommandDef, origin: string, home: string = homedir()): ShellCmd {
  const description = def.examples.length ? `${def.description}（例：${def.examples.join(' / ')}）` : def.description;
  return {
    description,
    allowedArgs: def.args,
    origin,
    needsConfirm: def.confirm,
    async exec(args: string[], ctx: ExecContext): Promise<ToolResult> {
      const extra = args.length ? args : def.default_args;
      const [bin, ...fixed] = def.command.map((x) => expandHome(x, ctx.home || home));
      const r = await ctx.run(bin, [...fixed, ...extra], { timeoutMs: def.timeout_ms });
      if (r.code !== 0) return { ok: false, display: `${def.name}失败（rc=${r.code}）：${r.stderr.trim().slice(0, 200)}` };
      const out = r.stdout.trim();
      if (!def.output.json) {
        const display = def.output.template ? renderTemplate(def.output.template, { stdout: out }) : `${def.name}：${out.slice(0, 300)}`;
        return { ok: true, display, data: { stdout: out.slice(0, 2000) } };
      }
      try {
        const data = JSON.parse(out) as Json;
        const display = def.output.template ? renderTemplate(def.output.template, data) : `${def.name}：${out.slice(0, 300)}`;
        return { ok: true, display, data };
      } catch {
        return { ok: false, display: `${def.name}输出解析失败：${out.slice(0, 200)}` };
      }
    },
  };
}

export function loadCommands(configDir: string, home: string = homedir()): Record<string, ShellCmd> {
  const p = join(configDir, 'commands.yaml');
  if (!existsSync(p)) return {};
  const defs = parseCommands(parseYaml(readFileSync(p, 'utf8')));
  return Object.fromEntries(defs.map((d) => [d.id, compileCommand(d, `command:${p}`, home)]));
}
