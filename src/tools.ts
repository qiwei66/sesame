/**
 * Tool (skill) registry: builtin skills (skills/builtin/*.ts) + user skills (~/.config/voice-agent/skills)
 * + custom commands (commands.yaml, compiled into the run_shell whitelist).
 * TOOLS / TOOL_MAP / TOOLS_VERSION are live bindings: installUserTools() / installCommands() update them.
 */
import { createHash } from 'node:crypto';
import type { ToolCall, ToolSpec } from './types.ts';
import { builtinSkills } from '../skills/builtin/index.ts';
import { installCommands as installShell, SHELL_WHITELIST, BUILTIN_SHELL } from '../skills/builtin/shell.ts';
import type { ShellCmd } from '../skills/builtin/shell.ts';
import type { Locale } from './i18n.ts';

// Re-exports (stable import surface for tests, cli and user skills)
export { resolveApp } from './apps.ts';
export { DIRS, confirmOrPlan, notifyNow } from './tool-helpers.ts';
export type { DirKey } from './tool-helpers.ts';
export { SHELL_WHITELIST, BUILTIN_SHELL };
export type { ShellCmd };
export { APPLESCRIPT_ACTIONS, reminderDate } from '../skills/builtin/applescript.ts';
export { buildMdfindQuery } from '../skills/builtin/files.ts';
export { openSaved, replaySaved, saveAlias } from '../skills/builtin/saved.ts';

export const TOOLS: ToolSpec[] = builtinSkills();
export const TOOL_MAP: Record<string, ToolSpec> = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

/** 缓存格式代号：回放语义变了（如 open_saved 改存选中 key）就手动 +1 */
const CACHE_SEMANTICS = 'v2-savedkey';

/** 这个调用能不能进缓存（cachePolicy / 旧的 noCache，可按参数判断） */
export function isNoCache(call: ToolCall): boolean {
  const spec = TOOL_MAP[call.name];
  if (!spec) return false;
  if (spec.cachePolicy !== undefined) {
    const p = typeof spec.cachePolicy === 'function' ? spec.cachePolicy(call.args) : spec.cachePolicy;
    if (p === 'never') return true;
  }
  const nc = spec.noCache;
  return typeof nc === 'function' ? nc(call.args) : Boolean(nc);
}

/** 这个调用执行前要不要用户确认（给 RPC 意图预览 / router 通用确认用） */
export function needsConfirm(call: ToolCall): boolean {
  const nc = TOOL_MAP[call.name]?.needsConfirm;
  return typeof nc === 'function' ? nc(call.args) : Boolean(nc);
}

/** OpenAI 兼容 tools 参数；locale 给定时只给该语言可用的工具 */
export function toolDefinitions(locale?: Locale): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> {
  return TOOLS.filter((t) => !locale || !t.locale || t.locale === 'all' || t.locale === locale)
    .map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/**
 * 工具表版本号：工具定义（名字/描述/参数 schema，含白名单 id 列表）+ 缓存语义代号的哈希。
 * 缓存条目带它，工具定义一变旧缓存自动作废。
 */
export function toolsVersionOf(defs: unknown = toolDefinitions()): string {
  return createHash('sha256').update(CACHE_SEMANTICS).update(JSON.stringify(defs)).digest('hex').slice(0, 12);
}
export let TOOLS_VERSION = toolsVersionOf();

function refreshVersion(): void {
  TOOLS_VERSION = toolsVersionOf();
}

/** commands.yaml → run_shell whitelist (user commands listed first) */
export function installCommands(user: Record<string, ShellCmd>): void {
  installShell(user);
  refreshVersion();
}

/** User skills: appended after builtins; a user skill may not shadow a builtin name */
export function installUserTools(specs: ToolSpec[]): string[] {
  const skipped: string[] = [];
  for (const s of specs) {
    if (TOOL_MAP[s.name]?.origin === 'builtin' || !/^[a-z][a-z0-9_]{0,40}$/.test(s.name)) { skipped.push(s.name); continue; }
    const i = TOOLS.findIndex((t) => t.name === s.name);
    if (i >= 0) TOOLS[i] = s; else TOOLS.push(s);
    TOOL_MAP[s.name] = s;
  }
  refreshVersion();
  return skipped;
}

/** Tests: back to builtins only */
export function resetTools(): void {
  TOOLS.splice(0, TOOLS.length, ...builtinSkills());
  for (const k of Object.keys(TOOL_MAP)) delete TOOL_MAP[k];
  for (const t of TOOLS) TOOL_MAP[t.name] = t;
  installShell({});
  refreshVersion();
}
