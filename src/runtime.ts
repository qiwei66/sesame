/**
 * Process setup shared by the CLI (`va "<text>"`) and the JSON-RPC server (`va serve --stdio`):
 * config → commands → user skills → provider/key → exec context → handle().
 */
import { execFile, spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FileCache } from './cache.ts';
import type { CacheStore } from './cache.ts';
import { getConfig, loadConfig, resolvePaths, setConfig } from './config.ts';
import type { Config, VaPaths } from './config.ts';
import { loadCommands } from './commands.ts';
import { loadUserSkills } from './skills.ts';
import { installCommands, installUserTools, notifyNow } from './tools.ts';
import { installedApps, setAppsCachePath } from './apps.ts';
import { makeChat } from './llm.ts';
import type { ChatFn } from './llm.ts';
import { estimateCost, readProviderKey, resolveProvider } from './providers.ts';
import type { ResolvedProvider } from './providers.ts';
import { fileStore } from './saved.ts';
import { runIndex, IndexAborted } from './index-run.ts';
import { resolveSources } from './sources/index.ts';
import { handle } from './router.ts';
import { shortForSpeech } from './speech.ts';
import { sayArgs } from './tool-helpers.ts';
import { setDefaultOutputLocale, tr, uiLocale } from './i18n.ts';
import type { Locale } from './i18n.ts';
import type { ExecContext, PickResult, RunReport, Runner } from './types.ts';

export const runner: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: opts.timeoutMs ?? 15_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? (err ? err.message : '')) });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });

// argv: message, title, cancel label, confirm label
const CONFIRM_SCRIPT = `on run argv
try
display dialog (item 1 of argv) with title (item 2 of argv) buttons {(item 3 of argv), (item 4 of argv)} default button (item 3 of argv) cancel button (item 3 of argv) with icon caution giving up after 60
if gave up of result then return "timeout"
return button returned of result
on error
return "cancel"
end try
end run`;

// argv: message, title, button label
export const RESULT_DIALOG = `on run argv
display dialog (item 1 of argv) with title (item 2 of argv) buttons {(item 3 of argv)} default button (item 3 of argv)
end run`;

/** System-prompt suffix: installed app list (bundle names; optionally with localized names) */
export function appsSuffix(cfg: Config, locale: Locale): string {
  const names = new Set<string>();
  for (const d of ['/Applications', '/System/Applications', '/System/Applications/Utilities']) {
    try {
      for (const f of readdirSync(d)) if (f.endsWith('.app')) names.add(f.slice(0, -4));
    } catch {
      // unreadable dir → skip
    }
  }
  let list = [...names].sort();
  if (cfg.prompt_localized_app_names) {
    const loc = new Map(installedApps(true).map((a) => [a.app, a.names.filter((n) => n !== a.app)]));
    list = list.map((n) => { const extra = loc.get(n) ?? []; return extra.length ? `${n}（${extra.slice(0, 2).join('/')}）` : n; });
  }
  return locale === 'en' ? `Installed apps: ${list.join(', ')}` : `本机已安装 App：${list.join('、')}`;
}

export interface Runtime {
  cfg: Config;
  root: string;
  dataDir: string;
  paths: VaPaths;
  home: string;
  provider: ResolvedProvider | null;
  providerError?: string;
  keyFrom: string | null;
  chat: ChatFn | null;
  ctx: ExecContext;
  cache: CacheStore;
  skillErrors: Array<{ file: string; error: string }>;
  run(input: string, opts?: RunOptions): Promise<RunReport>;
}

export interface RunOptions {
  feedback?: (text: string, attention: boolean) => Promise<void>;
  /** Per-request overrides of the exec context (RPC: no chooser dialog, in-panel confirmation, cancel signal) */
  ctx?: Partial<ExecContext>;
}

export interface RuntimeOptions {
  root: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
  /** dry-run plan lines */
  print?: (line: string) => void;
  /** Override confirmation (RPC: no dialogs unless the client allows them) */
  confirm?: (message: string) => Promise<boolean>;
  /** Override list chooser */
  choose?: (prompt: string, options: string[]) => Promise<number | null>;
  /** stderr-style diagnostics */
  diag?: (line: string) => void;
}

export async function createRuntime(o: RuntimeOptions): Promise<Runtime> {
  const env = o.env ?? process.env;
  const home = o.home ?? homedir();
  const cfg = loadConfig();
  setConfig(cfg);
  const paths = resolvePaths(cfg, o.root, env, home);
  const { dataDir, indexDir } = paths;
  setDefaultOutputLocale(uiLocale(cfg, env));
  const diag = o.diag ?? ((l: string) => process.stderr.write(`${l}\n`));
  setAppsCachePath(join(indexDir, 'apps-cache.json'));

  try {
    installCommands(loadCommands(cfg.dir, home));
  } catch (e) {
    diag(`[va] commands.yaml 无效，已忽略：${(e as Error).message}`);
  }
  const skills = await loadUserSkills(cfg.dir);
  const skipped = installUserTools(skills.specs);
  for (const s of skipped) diag(`[va] 用户技能 ${s} 与内置重名或名字不合法，已忽略`);
  for (const e of skills.errors) diag(`[va] 用户技能加载失败 ${e.file}：${e.error}`);

  const dryRun = o.dryRun ?? env.VA_DRY_RUN === '1';
  const print = o.print ?? ((line: string) => process.stdout.write(`${line}\n`));
  const sources = resolveSources(cfg.sources, home, env);
  const ctx: ExecContext = {
    saved: fileStore(indexDir),
    refreshSaved: async () => {
      // 限时 5 秒；超时 → abort：索引器在下一个文件边界停下、正式文件一个字节不写（回滚），并且等它真正退出再返回
      const t0 = Date.now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), Number(env.VA_REFRESH_TIMEOUT_MS ?? 5000));
      let r = false;
      try {
        r = (await runIndex({ indexDir, sources }, { fetchTitles: false, signal: ac.signal })) !== null;
      } catch (e) {
        if (!(e instanceof IndexAborted)) diag(`[va] 按需刷新索引出错：${(e as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
      diag(`[va] 按需刷新索引 ${r ? '完成' : ac.signal.aborted ? '超时（已放弃，索引未改动）' : '跳过（另一个索引在跑）'} ${Date.now() - t0}ms`);
      return r;
    },
    choose: o.choose ?? (async (prompt, options) => {
      const script = 'on run argv\nset t to item 1 of argv\nset p to item 2 of argv\nset opts to items 3 thru -1 of argv\nset r to choose from list opts with title t with prompt p\nif r is false then return ""\nreturn item 1 of r\nend run';
      const r = await runner('osascript', ['-e', script, 'Sesame', prompt, ...options], { timeoutMs: 600_000 });
      const i = options.indexOf(r.stdout.trim());
      return i >= 0 ? i : null;
    }),
    dryRun,
    print,
    run: runner,
    home,
    now: () => new Date(),
    confirm: o.confirm ?? (async (message) => {
      const ok = tr('确认', 'Confirm');
      const r = await runner('osascript', ['-e', CONFIRM_SCRIPT, message, tr('Sesame · 需要确认', 'Sesame · confirm'), tr('取消', 'Cancel'), ok], { timeoutMs: 70_000 });
      return r.stdout.trim() === ok;
    }),
  };

  const cachePath = env.VA_CACHE_FILE ?? join(dataDir, dryRun ? 'cache.dryrun.json' : 'cache.json');
  const cache = new FileCache(cachePath);

  let provider: ResolvedProvider | null = null;
  let providerError: string | undefined;
  let chat: ChatFn | null = null;
  let keyFrom: string | null = null;
  try {
    provider = resolveProvider(cfg, env);
    const k = await readProviderKey(provider, runner, env, home);
    keyFrom = k.from;
    if (k.key || provider.keyOptional) {
      chat = makeChat({ base_url: provider.base_url, model: provider.model, apiKey: k.key, extra_body: provider.extra_body, max_tokens: provider.max_tokens, name: provider.name });
    } else {
      providerError = `没有找到 ${provider.name} 的 key（试过：${k.tried.join('；') || '无'}）`;
      diag(`[va] 模型 key 不可用：${providerError}`);
    }
  } catch (e) {
    providerError = (e as Error).message;
    diag(`[va] 模型配置无效：${providerError}`);
  }
  if (chat) {
    const c = chat;
    ctx.pick = async (query, candidates): Promise<PickResult> => {
      const resp = await c([
        { role: 'system', content: '用户想打开以前交付过的一个产物。从候选里挑出就是用户要的那一项，只回一个整数：序号。规则：主体名词对得上（如「交易」「期权」「项目全景」）、只是叫法不同（大盘/看板/仪表盘，手册/教程/教学页，试听/试听页）算匹配；主体名词对不上、只共享「看板」「周报」这类泛词不算，都不对就回 -1；两项以上都可能、分不清就回 0。不要解释。' },
        { role: 'user', content: `用户原话：${query}\n候选：\n${candidates}` },
      ], []);
      const m = /-?\d+/.exec(resp.message.content ?? '');
      return { index: m ? Number(m[0]) : 0, usage: resp.usage };
    };
  }

  const speak = env.VA_SPEAK === '1' || (env.VA_SPEAK !== '0' && cfg.speak);
  const defaultFeedback = async (text: string, attention: boolean): Promise<void> => {
    const spoken = shortForSpeech(text);
    if (dryRun) {
      print(attention
        ? tr(`[DRY-RUN] 将弹出对话框（不自动关闭，按「好」关闭）：${text}`, `[DRY-RUN] would show a dialog (stays until you press OK): ${text}`)
        : tr(`[DRY-RUN] 将通知：${text}`, `[DRY-RUN] would notify: ${text}`));
      if (speak) print(tr(`[DRY-RUN] 将朗读：${spoken}`, `[DRY-RUN] would speak: ${spoken}`));
      return;
    }
    if (speak) {
      const p = spawn('say', sayArgs(spoken), { detached: true, stdio: 'ignore' });
      p.on('error', () => {});
      p.unref();
    }
    if (attention) await runner('osascript', ['-e', RESULT_DIALOG, text.slice(0, 1500), 'Sesame', tr('好', 'OK')], { timeoutMs: 24 * 3600_000 });
    else await notifyNow(ctx, text);
  };

  return {
    cfg: getConfig(), root: o.root, dataDir, paths, home, provider, providerError, keyFrom, chat, ctx, cache, skillErrors: skills.errors,
    run: (input, ro = {}) => handle(input, {
      cache, chat, ctx: ro.ctx ? { ...ctx, ...ro.ctx } : ctx,
      systemSuffix: (locale: Locale) => appsSuffix(cfg, locale),
      feedback: ro.feedback ?? defaultFeedback,
    }),
  };
}

/** Cost label for UIs: cache hit / tokens / ms / estimated money (null = provider has no price configured) */
export function costLabel(r: RunReport, p: ResolvedProvider | null): { cacheHit: boolean; tokens: number; promptCacheHitTokens: number; ms: number; estimate: { amount: number; currency: string } | null; provider: string | null; model: string | null } {
  return {
    cacheHit: r.layer === 'cache',
    tokens: r.usage.total_tokens,
    promptCacheHitTokens: r.usage.prompt_cache_hit_tokens ?? 0,
    ms: r.durationMs,
    estimate: r.usage.total_tokens === 0 ? { amount: 0, currency: p?.price?.currency || '¥' } : p ? estimateCost(p, r.usage) : null,
    provider: p?.name ?? null,
    model: p?.model ?? null,
  };
}
