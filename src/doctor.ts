/**
 * va doctor：只读体检。每项输出 ✅/⚠️/❌ + 一行修法。
 * 只读铁律：不改任何文件/设置；不打印密钥内容；不碰 TCC.db / tccutil。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Runner } from './types.ts';
import { tr } from './i18n.ts';
import { expandHome, loadConfig } from './config.ts';
import { readProviderKey, resolveProvider } from './providers.ts';

export type Level = 'ok' | 'warn' | 'fail';
export interface Check { name: string; level: Level; detail: string; fix?: string }

const ICON: Record<Level, string> = { ok: '✅', warn: '⚠️ ', fail: '❌' };
const COLOR: Record<Level, number> = { ok: 32, warn: 33, fail: 31 };

export function formatCheck(c: Check, color: boolean): string {
  const line = `${ICON[c.level]} ${c.name}${tr('：', ': ')}${c.detail}`;
  const out = color ? `\x1b[${COLOR[c.level]}m${line}\x1b[0m` : line;
  return c.level === 'ok' || !c.fix ? out : tr(`${out}\n     修法：${c.fix}`, `${out}\n     fix: ${c.fix}`);
}

const APPKIT_MODIFIERS = 0x1e0000;
const CARBON_MODIFIERS = 0x1b00;

/** Missing Spotlight preferences mean macOS's enabled ⌘Space default, as in SymbolicHotKeys.swift. */
export function spotlightHotkeyEnabled(output: string | null): boolean {
  if (!output) return true;
  let sawSpotlight = false;
  // defaults' OpenStep dictionaries: each numeric entry contains at most one nested value dictionary.
  for (const entry of output.matchAll(/"?(\d+)"?\s*=\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)) {
    const [, id, body] = entry;
    if (id === '64') sawSpotlight = true;
    if (!/\benabled\s*=\s*1\s*;/.test(body)) continue;
    const params = body.match(/\bparameters\s*=\s*\(([^)]*)\)/)?.[1].split(',').map((s) => Number(s.trim()));
    if (!params || params.length < 3) {
      if (id === '64') return true;
    } else if (params[1] === 49 && (params[2] & APPKIT_MODIFIERS) === 0x100000) return true;
  }
  return !sawSpotlight;
}

function defaultsString(output: string | null): string {
  return (output ?? '').trim().replace(/^"(.*)"$/s, '$1');
}

/** Raycast's saved modifier names and virtual key code; missing means its default ⌥Space. */
export function raycastHotkeyEnabled(output: string | null): boolean {
  return /^(?:command|cmd)-49$/i.test(defaultsString(output));
}

/** Alfred's hotkey/prefs.plist default dictionary, with either AppKit or Carbon modifiers. */
export function alfredHotkeyEnabled(output: string | null): boolean {
  const key = output?.match(/\bkey\s*=\s*(\d+)\s*;/)?.[1];
  const mod = output?.match(/\bmod\s*=\s*(\d+)\s*;/)?.[1];
  if (key !== '49' || mod === undefined) return false;
  const flags = Number(mod);
  return flags <= 0xffff ? (flags & CARBON_MODIFIERS) === 0x100 : (flags & APPKIT_MODIFIERS) === 0x100000;
}

export interface HotkeyDefaults {
  spotlight: string | null;
  alfred: readonly (string | null)[];
  raycast: string | null;
  sesameHotkey: string | null;
  sesameCommandSpace: string | null;
}

/** Pure check of saved settings, not a probe of live Carbon registrations. */
export function hotkeyCheck(settings: HotkeyDefaults): Check {
  const holders = [
    ...(spotlightHotkeyEnabled(settings.spotlight) ? ['Spotlight'] : []),
    ...(settings.alfred.some(alfredHotkeyEnabled) ? ['Alfred'] : []),
    ...(raycastHotkeyEnabled(settings.raycast) ? ['Raycast'] : []),
  ];
  const stored = defaultsString(settings.sesameHotkey).match(/^(\d+):(\d+)$/);
  const custom = stored && Number(stored[1]) <= 0xffffffff && Number(stored[2]) <= 0xffffffff
    && !(Number(stored[1]) === 49 && Number(stored[2]) === 0x800) ? stored : null;
  // Match HotKeyPlan.choose: custom wins; automatic mode falls back while ⌘Space is held.
  const wantsCommandSpace = /^(?:1|true|yes)$/i.test(defaultsString(settings.sesameCommandSpace));
  const code = custom ? Number(custom[1]) : 49;
  const mods = custom ? Number(custom[2]) & CARBON_MODIFIERS : wantsCommandSpace && !holders.length ? 0x100 : 0xa00;
  const active = `${mods & 0x1000 ? '⌃' : ''}${mods & 0x800 ? '⌥' : ''}${mods & 0x200 ? '⇧' : ''}${mods & 0x100 ? '⌘' : ''}${code === 49 ? 'Space' : `#${code}`}`;
  const clash = code === 49 && mods === 0x100 && holders.length > 0;
  const occupancy = holders.length
    ? tr(`⌘Space 已被 ${holders.join(' / ')} 设置为热键`, `⌘Space is assigned to ${holders.join(' / ')}`)
    : tr('Spotlight / Alfred / Raycast 均未设置 ⌘Space', '⌘Space is not assigned to Spotlight / Alfred / Raycast');
  return {
    name: tr('热键', 'Hot key'), level: clash ? 'warn' : 'ok',
    detail: tr(`Sesame 使用 ${active}；${occupancy}`, `Sesame uses ${active}; ${occupancy}`),
    ...(clash ? { fix: tr('设置 › 热键：换一个快捷键，或在占用应用的设置中关闭 ⌘Space', 'Settings › Hot key: choose another shortcut, or disable ⌘Space in the named app’s settings') } : {}),
  };
}

async function readDefault(run: Runner, domain: string, key: string): Promise<string | null> {
  try {
    const result = await run('defaults', ['read', domain, key], { timeoutMs: 2000 });
    return result.code === 0 ? result.stdout : null;
  } catch { return null; }
}

async function readAlfredHotkeys(home: string, run: Runner): Promise<(string | null)[]> {
  const sync = defaultsString(await readDefault(run, 'com.runningwithcrayons.Alfred-Preferences', 'syncfolder'));
  const roots = [join(home, 'Library/Application Support/Alfred/Alfred.alfredpreferences')];
  if (sync) roots.unshift(join(expandHome(sync, home), 'Alfred.alfredpreferences'));
  for (const root of roots) {
    const local = join(root, 'preferences/local');
    let hosts: string[];
    try { hosts = readdirSync(local); } catch { continue; }
    const outputs = await Promise.all(hosts.map((host) => readDefault(run, join(local, host, 'hotkey/prefs'), 'default')));
    if (outputs.some((output) => output !== null)) return outputs;
  }
  return [];
}

/** 最近 24 小时的错误数：logs/*.jsonl 里 layer=error 或带 error 字段的行 */
export function countRecentErrors(logDir: string, now: Date): { errors: number; total: number; samples: string[] } {
  const since = now.getTime() - 86_400_000;
  let errors = 0;
  let total = 0;
  const samples: string[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(logDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-2);
  } catch {
    return { errors: 0, total: 0, samples };
  }
  for (const f of files) {
    for (const line of readFileSync(join(logDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let d: { ts?: string; layer?: string; error?: string; input?: string };
      try { d = JSON.parse(line); } catch { continue; }
      if (!d.ts || Date.parse(d.ts) < since) continue;
      total += 1;
      if (d.layer === 'error' || d.error) {
        errors += 1;
        if (samples.length < 3) samples.push(`${String(d.error ?? d.layer).slice(0, 60)}`);
      }
    }
  }
  return { errors, total, samples };
}

export interface DoctorEnv {
  /** Data dir (default for the index and log dirs) */
  root: string;
  /** Repo / core dir (kept for callers; not read by any check now) */
  appRoot?: string;
  /** Index dir (VA_INDEX_DIR / config index_dir; default <root>/index) */
  indexDir?: string;
  /** va run logs (VA_LOG_DIR / config log_dir; default <root>/logs) */
  logDir?: string;
  home: string; run: Runner; now?: () => Date; color?: boolean; print?: (s: string) => void }

export async function collectChecks(env: DoctorEnv): Promise<Check[]> {
  const { root, home, run } = env;
  const indexDir = env.indexDir ?? join(root, 'index');
  const logDir = env.logDir ?? join(root, 'logs');
  const now = env.now?.() ?? new Date();
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  // 1. node
  const [maj, min] = process.versions.node.split('.').map(Number);
  add(maj > 22 || (maj === 22 && min >= 18)
    ? { name: tr('Node 版本', 'Node version'), level: 'ok', detail: tr(`v${process.versions.node}（需要 ≥22.18，原生跑 .ts）`, `v${process.versions.node} (needs ≥22.18 to run .ts natively)`) }
    : { name: tr('Node 版本', 'Node version'), level: 'fail', detail: tr(`v${process.versions.node} 太旧`, `v${process.versions.node} is too old`), fix: tr('装 Node 22.18+（nvm / fnm / volta / Homebrew 都行），找不到就在 ~/.config/voice-agent/env.sh 写 export VA_NODE=<node 路径>', 'Install Node 22.18+ (nvm / fnm / volta / Homebrew); if it cannot be found, put export VA_NODE=<path to node> in ~/.config/voice-agent/env.sh') });

  // 2. 模型 provider + key：只看来源与是否存在，不读出、不打印内容
  try {
    const cfg = loadConfig();
    const p = resolveProvider(cfg);
    const k = await readProviderKey(p, run, process.env, home);
    if (k.key) add({ name: tr('模型', 'Model'), level: 'ok', detail: tr(`${p.name} · ${p.model} · ${p.base_url}；key 来自 ${k.from}（内容不显示）`, `${p.name} · ${p.model} · ${p.base_url}; key from ${k.from} (value not shown)`) });
    else if (p.keyOptional) add({ name: tr('模型', 'Model'), level: 'ok', detail: tr(`${p.name} · ${p.model} · ${p.base_url}（本地服务，不需要 key）`, `${p.name} · ${p.model} · ${p.base_url} (local server, no key needed)`) });
    else add({ name: tr('模型', 'Model'), level: 'fail', detail: tr(`${p.name}：没找到 key（试过 ${k.tried.join('；')}）`, `${p.name}: no key found (tried ${k.tried.join('; ')})`), fix: tr(`在 ${cfg.dir}/config.yaml 的 providers.${p.name}.key 写 env / keychain / file 来源，或 export ${p.key.find((x) => x.env)?.env ?? 'API_KEY'}=…`, `set an env / keychain / file source under providers.${p.name}.key in ${cfg.dir}/config.yaml, or export ${p.key.find((x) => x.env)?.env ?? 'API_KEY'}=…`) });
    const missing = k.from?.startsWith('file ') ? expandHome(k.from.slice(5), home) : null;
    if (missing) {
      const mode = (statSync(missing).mode & 0o777).toString(8);
      if (mode !== '600') add({ name: tr('key 文件权限', 'Key file permissions'), level: 'warn', detail: tr(`权限 ${mode}`, `mode ${mode}`), fix: `chmod 600 ${missing}` });
    }
  } catch (e) {
    add({ name: tr('模型', 'Model'), level: 'fail', detail: (e as Error).message, fix: tr('config.yaml 的 provider 写 deepseek / openai / ollama / lmstudio 之一，或在 providers 下自定义 base_url', 'set provider in config.yaml to deepseek / openai / ollama / lmstudio, or define base_url under providers') });
  }

  // 3. 索引新鲜度
  try {
    const st = JSON.parse(readFileSync(join(indexDir, 'state.json'), 'utf8')) as { lastRun?: string };
    const items = JSON.parse(readFileSync(join(indexDir, 'items.json'), 'utf8')) as unknown[];
    const ageMin = st.lastRun ? Math.round((now.getTime() - Date.parse(st.lastRun)) / 60_000) : Infinity;
    const level: Level = ageMin <= 90 ? 'ok' : ageMin <= 24 * 60 ? 'warn' : 'fail';
    add({ name: tr('索引新鲜度', 'Index freshness'), level, detail: tr(`上次 ${st.lastRun ?? '从未'}（${ageMin} 分钟前），${items.length} 条`, `last run ${st.lastRun ?? 'never'} (${ageMin} min ago), ${items.length} items`), fix: tr('Sesame 启动时和每 30 分钟会自动整理；也可以手动跑 va-index', 'Sesame indexes on launch and every 30 minutes; you can also run va-index') });
  } catch {
    add({ name: tr('索引新鲜度', 'Index freshness'), level: 'fail', detail: tr(`${indexDir}/state.json 或 items.json 读不了`, `cannot read ${indexDir}/state.json or items.json`), fix: tr('打开 Sesame 会自动建索引；或手动跑 va-index --full', 'Opening Sesame builds the index; or run va-index --full') });
  }

  // 4. 最近 24 小时错误
  const e = countRecentErrors(logDir, now);
  add({
    name: tr('最近 24 小时错误', 'Errors in the last 24h'), level: e.errors === 0 ? 'ok' : 'warn',
    detail: tr(`va 调用 ${e.total} 次，出错 ${e.errors} 次${e.samples.length ? `（${e.samples.join(' / ')}）` : ''}`, `${e.total} va runs, ${e.errors} errors${e.samples.length ? ` (${e.samples.join(' / ')})` : ''}`),
    fix: tr(`看 ${logDir}/<今天>.jsonl 里 layer=error 的行`, `look for layer=error lines in ${logDir}/<today>.jsonl`),
  });
  // 5. 热键：只用 defaults read；不注册热键，不改系统或启动器设置。
  const [spotlight, alfred, raycast, sesameHotkey, sesameCommandSpace] = await Promise.all([
    readDefault(run, 'com.apple.symbolichotkeys', 'AppleSymbolicHotKeys'),
    readAlfredHotkeys(home, run),
    readDefault(run, 'com.raycast.macos', 'raycastGlobalHotkey'),
    readDefault(run, 'io.github.sesame.app', 'hotKey'),
    readDefault(run, 'io.github.sesame.app', 'commandSpace'),
  ]);
  add(hotkeyCheck({ spotlight, alfred, raycast, sesameHotkey, sesameCommandSpace }));
  return checks;
}

export async function runDoctor(env: DoctorEnv): Promise<number> {
  const print = env.print ?? ((s: string) => process.stdout.write(`${s}\n`));
  const color = (env.color ?? Boolean(process.stdout.isTTY)) && !process.env.NO_COLOR;
  print(tr('va doctor（只读体检）', 'va doctor (read-only health check)'));
  const checks = await collectChecks(env);
  for (const c of checks) print(formatCheck(c, color));
  const fail = checks.filter((c) => c.level === 'fail').length;
  const warn = checks.filter((c) => c.level === 'warn').length;
  print(tr(`—— ${checks.length} 项：✅ ${checks.length - fail - warn} · ⚠️ ${warn} · ❌ ${fail}`, `—— ${checks.length} checks: ✅ ${checks.length - fail - warn} · ⚠️ ${warn} · ❌ ${fail}`));
  return fail ? 1 : 0;
}
