/**
 * Shared helpers for builtin and user skills (tools). Skills import from here, never from each other.
 */
import { join } from 'node:path';
import type { ExecContext, Json, ToolResult } from './types.ts';
import { getConfig } from './config.ts';
import { tr } from './i18n.ts';

/** 允许打开的目录（search_files / finder_open / trash_files 共用）——禁止全 home */
export const DIRS = { downloads: 'Downloads', documents: 'Documents', desktop: 'Desktop' } as const;
export type DirKey = keyof typeof DIRS;
export const DIR_KEYS = Object.keys(DIRS) as DirKey[];

export function dirPath(ctx: ExecContext, key: unknown): string | null {
  if (typeof key !== 'string' || !(DIR_KEYS as string[]).includes(key)) return null;
  return join(ctx.home, DIRS[key as DirKey]);
}


export const str = (v: Json | undefined): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
export const num = (v: Json | undefined, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** 用 on run argv 传参，杜绝 AppleScript 注入 */
export async function osa(ctx: ExecContext, script: string, argv: string[] = []): Promise<{ ok: boolean; out: string; err: string }> {
  const r = await ctx.run('osascript', ['-e', script, ...argv], { timeoutMs: 120_000 });
  return { ok: r.code === 0, out: r.stdout.trim(), err: r.stderr.trim() };
}

export function plan(ctx: ExecContext, what: string): ToolResult {
  ctx.print(tr(`[DRY-RUN] 将执行：${what}`, `[DRY-RUN] would run: ${what}`));
  return { ok: true, display: tr(`（演练）${what}`, `(dry run) ${what}`), dryRun: true };
}

export async function confirmOrPlan(ctx: ExecContext, question: string, what: string): Promise<'dry' | 'yes' | 'no'> {
  if (ctx.dryRun) {
    ctx.print(tr(`[DRY-RUN] 不可逆操作，将先弹窗确认：「${question}」`, `[DRY-RUN] irreversible: would ask first: "${question}"`));
    ctx.print(tr(`[DRY-RUN] 用户确认后将执行：${what}`, `[DRY-RUN] after confirmation would run: ${what}`));
    return 'dry';
  }
  return (await ctx.confirm(question)) ? 'yes' : 'no';
}

export const obj = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object' as const, properties, required, additionalProperties: false as const });

/** `say` arguments honoring config.voice (empty = system default voice) */
export function sayArgs(text: string): string[] {
  const v = getConfig().voice;
  return v ? ['-v', v, text] : [text];
}

export async function notifyNow(ctx: ExecContext, text: string): Promise<void> {
  await ctx.run('osascript', ['-e', 'on run argv\ndisplay notification (item 1 of argv) with title (item 2 of argv)\nend run', text.slice(0, 900), 'Sesame']);
}
