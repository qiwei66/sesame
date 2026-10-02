/**
 * va doctor：只读体检。每项输出 ✅/⚠️/❌ + 一行修法。
 * 只读铁律：不改任何文件/设置（唯一的写是 Alfred 自检标记文件，检完即删）；不打印密钥内容；
 * Spotlight 快捷键只用 `defaults read`；不碰 TCC.db / tccutil。
 */
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Runner } from './types.ts';
import { tr } from './i18n.ts';
import { expandHome, INSTALL_MARKER, loadConfig } from './config.ts';
import { readProviderKey, resolveProvider } from './providers.ts';

export const SELFTEST_PREFIX = '__va_selftest__';
/** Signing identity of the helper app (bin/va-env reads it from ~/.config/voice-agent/env.sh); empty = first Apple Development identity */
export const SIGN_IDENTITY = process.env.VA_SIGN_IDENTITY ?? '';
/** launchd / Alfred / helper bundle id prefix (bin/va-env) */
export const BUNDLE_PREFIX = process.env.VA_BUNDLE_PREFIX ?? 'local.voice-agent';
const ALFRED_BUNDLE = `${BUNDLE_PREFIX}.voice-agent`;
const HELPER_BUNDLE = `${BUNDLE_PREFIX}.va-autoenter`;
const FALLBACK_UID = '6C1F7A10-2B7E-4C2A-9D11-0A1B2C3D4E01';

export function selftestMarkerPath(logDir: string, nonce: string): string {
  return join(logDir, `.selftest-${nonce.replace(/[^A-Za-z0-9_-]/g, '')}`);
}

/** Alfred 外部触发 → bin/va "__va_selftest__ <nonce>" → 只写这个标记文件 */
export function writeSelftestMarker(logDir: string, nonce: string): void {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(nonce)) return;
  mkdirSync(logDir, { recursive: true });
  writeFileSync(selftestMarkerPath(logDir, nonce), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ppid: process.ppid }));
}

export type Level = 'ok' | 'warn' | 'fail';
export interface Check { name: string; level: Level; detail: string; fix?: string }

const ICON: Record<Level, string> = { ok: '✅', warn: '⚠️ ', fail: '❌' };

export function formatCheck(c: Check, color: boolean): string {
  const red = (s: string) => (color ? `\x1b[31m${s}\x1b[0m` : s);
  const line = `${ICON[c.level]} ${c.name}${tr('：', ': ')}${c.detail}`;
  const out = c.level === 'fail' ? red(line) : line;
  return c.level === 'ok' || !c.fix ? out : tr(`${out}\n     修法：${c.fix}`, `${out}\n     fix: ${c.fix}`);
}

/** 证书到期判定：<0 天 / <60 天 → fail（标红），否则 ok */
export function certLevel(daysLeft: number): Level {
  return daysLeft < 60 ? 'fail' : 'ok';
}

/** 从 `defaults read com.apple.symbolichotkeys AppleSymbolicHotKeys` 文本里取 64（聚焦搜索 ⌘Space）是否启用 */
export function spotlightHotkeyEnabled(defaultsText: string): boolean | null {
  const m = /\n\s*64\s*=\s*\{\s*enabled\s*=\s*(\d)/.exec(`\n${defaultsText}`);
  return m ? m[1] === '1' : null;
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

function plistJson(run: Runner, path: string): Promise<Record<string, unknown> | null> {
  return run('plutil', ['-convert', 'json', '-o', '-', path]).then((r) => {
    if (r.code !== 0) return null;
    try { return JSON.parse(r.stdout) as Record<string, unknown>; } catch { return null; }
  });
}

export interface DoctorEnv {
  /** Data dir (selftest marker, Alfred error log; helper app + its log live under appRoot) */
  root: string;
  /** Repo dir with bin/VA AutoEnter.app and logs/va-autoenter.log (default: root) */
  appRoot?: string;
  /** Index dir (VA_INDEX_DIR / config index_dir; default <root>/index) */
  indexDir?: string;
  /** va run logs (VA_LOG_DIR / config log_dir; default <root>/logs) */
  logDir?: string;
  home: string; run: Runner; now?: () => Date; color?: boolean; print?: (s: string) => void; skipAlfredTrigger?: boolean;
  /** Which front end this install uses. sesame = the menu-bar app (no Alfred / AutoEnter / launchd checks); default: detectProfile */
  profile?: Profile }

export type Profile = 'sesame' | 'alfred';

/**
 * alfred = this checkout drives the Alfred workflow (it has the AutoEnter helper or a launchd index job of its own);
 * otherwise sesame (installed by `make install`, used from the menu-bar app).
 */
export function detectProfile(appRoot: string): Profile {
  if (existsSync(join(appRoot, INSTALL_MARKER))) return 'sesame';
  if (existsSync(join(appRoot, 'bin/VA AutoEnter.app'))) return 'alfred';
  return 'sesame';
}

export async function collectChecks(env: DoctorEnv): Promise<Check[]> {
  const { root, home, run } = env;
  const appRoot = env.appRoot ?? root;
  const indexDir = env.indexDir ?? join(root, 'index');
  const logDir = env.logDir ?? join(root, 'logs');
  const now = env.now?.() ?? new Date();
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const profile: Profile = env.profile ?? detectProfile(appRoot);

  // 1. node
  const [maj, min] = process.versions.node.split('.').map(Number);
  add(maj > 22 || (maj === 22 && min >= 18)
    ? { name: tr('Node 版本', 'Node version'), level: 'ok', detail: tr(`v${process.versions.node}（需要 ≥22.18，原生跑 .ts）`, `v${process.versions.node} (needs ≥22.18 to run .ts natively)`) }
    : { name: tr('Node 版本', 'Node version'), level: 'fail', detail: tr(`v${process.versions.node} 太旧`, `v${process.versions.node} is too old`), fix: tr('装 Node 22.18+（nvm / fnm / volta / Homebrew 都行），Alfred 里找不到就在 ~/.config/voice-agent/env.sh 写 export VA_NODE=<node 路径>', 'Install Node 22.18+ (nvm / fnm / volta / Homebrew); if Alfred cannot find it, put export VA_NODE=<path to node> in ~/.config/voice-agent/env.sh') });

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

  // 3–7: the Alfred front end only (launchd jobs, AutoEnter helper, signing, Alfred prefs, Spotlight hot key)
  if (profile === 'alfred') {
    // 3. launchd
    const uid = process.getuid?.() ?? 501;
    for (const [label, wantRunning] of [[`${BUNDLE_PREFIX}.va-index`, false], [HELPER_BUNDLE, true]] as const) {
      const r = await run('launchctl', ['print', `gui/${uid}/${label}`]);
      if (r.code !== 0) { add({ name: `launchd ${label}`, level: 'fail', detail: tr('未加载', 'not loaded'), fix: 'bin/va-setup' }); continue; }
      const state = /^\s*state = (.+)$/m.exec(r.stdout)?.[1]?.trim() ?? '?';
      const lastExit = /^\s*last exit code = (.+)$/m.exec(r.stdout)?.[1]?.trim() ?? '?';
      const pid = /^\s*pid = (\d+)/m.exec(r.stdout)?.[1];
      if (wantRunning) {
        add(state === 'running'
          ? { name: `launchd ${label}`, level: 'ok', detail: tr(`常驻运行中（pid ${pid}）`, `running (pid ${pid})`) }
          : { name: `launchd ${label}`, level: 'fail', detail: tr(`state=${state}，last exit=${lastExit}`, `state=${state}, last exit=${lastExit}`), fix: tr(`launchctl kickstart -k gui/${uid}/${label}；仍不行跑 bin/va-setup`, `launchctl kickstart -k gui/${uid}/${label}; if that fails run bin/va-setup`) });
      } else {
        const okExit = lastExit === '0' || lastExit === '(never exited)';
        add({ name: `launchd ${label}`, level: okExit ? 'ok' : 'warn', detail: tr(`已加载（定时任务，当前 ${state}，上次退出码 ${lastExit}）`, `loaded (scheduled job, now ${state}, last exit ${lastExit})`), fix: tr('看 logs/va-index.log 末尾的 FAIL 行', 'see the FAIL lines at the end of logs/va-index.log') });
      }
    }

    // 4. 辅助功能授权（以助手自己写的最新日志为准）
    const axLog = join(appRoot, 'logs/va-autoenter.log');
    const axLine = existsSync(axLog) ? readFileSync(axLog, 'utf8').split('\n').filter((l) => l.includes('accessibility_trusted=')).pop() : undefined;
    if (!axLine) add({ name: tr('辅助功能授权', 'Accessibility permission'), level: 'fail', detail: tr('日志里没有 accessibility_trusted 记录', 'no accessibility_trusted line in the helper log'), fix: tr('bin/va-setup（会重启助手并写日志）', 'bin/va-setup (restarts the helper, which logs its status)') });
    else {
      const trusted = /accessibility_trusted=true/.test(axLine);
      const at = axLine.split(' ')[0];
      add(trusted
        ? { name: tr('辅助功能授权', 'Accessibility permission'), level: 'ok', detail: tr(`accessibility_trusted=true（${at}）`, `accessibility_trusted=true (${at})`) }
        : { name: tr('辅助功能授权', 'Accessibility permission'), level: 'fail', detail: tr(`accessibility_trusted=false（${at}）`, `accessibility_trusted=false (${at})`), fix: tr('运行 va-autoenter-setup，把 VA AutoEnter 拖进 辅助功能 列表并打开开关', 'run va-autoenter-setup, drag VA AutoEnter into the Accessibility list and switch it on') });
    }

    // 5. 签名证书到期 + 已装 bundle 的 DR
    const cert = await run('/bin/sh', ['-c', `security find-certificate -c "$1" -p | openssl x509 -noout -enddate`, 'sh', SIGN_IDENTITY || 'Apple Development']);
    const end = /notAfter=(.+)/.exec(cert.stdout)?.[1];
    if (!end) add({ name: tr('签名证书', 'Signing certificate'), level: 'fail', detail: tr(`钥匙串里找不到「${SIGN_IDENTITY || 'Apple Development'}」`, `"${SIGN_IDENTITY || 'Apple Development'}" not found in the keychain`), fix: tr('Xcode → Settings → Accounts → Manage Certificates 建 Apple Development 证书，再 VA_SIGN_IDENTITY=... bin/va-setup', 'create an Apple Development certificate in Xcode → Settings → Accounts → Manage Certificates, then VA_SIGN_IDENTITY=... bin/va-setup') });
    else {
      const days = Math.floor((Date.parse(end) - now.getTime()) / 86_400_000);
      add({ name: tr('签名证书', 'Signing certificate'), level: certLevel(days), detail: tr(`到期 ${new Date(Date.parse(end)).toISOString().slice(0, 10)}，剩 ${days} 天${days < 60 ? '（少于 60 天）' : ''}`, `expires ${new Date(Date.parse(end)).toISOString().slice(0, 10)}, ${days} days left${days < 60 ? ' (less than 60 days)' : ''}`), fix: tr('续期证书 → bin/va-setup 重签 → 证书 CN 变了要重新授权一次（va-autoenter-setup）', 'renew the certificate → bin/va-setup to re-sign → if the certificate CN changed, grant permission again (va-autoenter-setup)') });
    }
    const app = join(appRoot, 'bin/VA AutoEnter.app');
    const dr = await run('codesign', ['-d', '-r-', app]);
    const drText = `${dr.stdout}${dr.stderr}`;
    if (dr.code !== 0) add({ name: tr('助手签名', 'Helper signature'), level: 'fail', detail: tr('bin/VA AutoEnter.app 不存在或未签名', 'bin/VA AutoEnter.app is missing or unsigned'), fix: 'npm run build:autoenter' });
    else if (/cdhash/.test(drText) || !drText.includes(`identifier "${HELPER_BUNDLE}"`)) add({ name: tr('助手签名', 'Helper signature'), level: 'fail', detail: tr('designated requirement 不是「identifier + 证书」', 'designated requirement is not "identifier + certificate"'), fix: tr('npm run build:autoenter（禁止 ad-hoc）', 'npm run build:autoenter (never ad-hoc)') });
    else add({ name: tr('助手签名', 'Helper signature'), level: 'ok', detail: tr(`DR = identifier ${HELPER_BUNDLE} + 证书`, `DR = identifier ${HELPER_BUNDLE} + certificate`) });

    // 6. Alfred：fallback 第一位、主热键 ⌘Space
    let prefsRoot = join(home, 'Library/Application Support/Alfred/Alfred.alfredpreferences');
    try {
      const cur = (JSON.parse(readFileSync(join(home, 'Library/Application Support/Alfred/prefs.json'), 'utf8')) as { current?: string }).current;
      if (cur) prefsRoot = cur;
    } catch { /* 用默认路径 */ }
    let wfUuid: string | null = null;
    try {
      for (const d of readdirSync(join(prefsRoot, 'workflows'))) {
        const info = await plistJson(run, join(prefsRoot, 'workflows', d, 'info.plist'));
        if (info?.bundleid === ALFRED_BUNDLE) { wfUuid = d.replace('user.workflow.', ''); break; }
      }
    } catch { /* 没有 workflows 目录 */ }
    if (!wfUuid) add({ name: 'Alfred workflow', level: 'fail', detail: tr('没装', 'not installed'), fix: 'bin/va-setup' });
    else {
      const dr2 = await plistJson(run, join(prefsRoot, 'preferences/features/defaultresults/prefs.plist'));
      const fbs = (dr2?.fallbacks as string[] | undefined) ?? [];
      const want = `user.workflow.${wfUuid}.${FALLBACK_UID}`;
      add(fbs[0] === want
        ? { name: 'Alfred fallback', level: 'ok', detail: tr('语音助手排第一', 'voice agent is first') }
        : { name: 'Alfred fallback', level: 'fail', detail: fbs.includes(want) ? tr(`排第 ${fbs.indexOf(want) + 1}`, `position ${fbs.indexOf(want) + 1}`) : tr('不在 fallback 列表', 'not in the fallback list'), fix: tr('bin/va-setup（或 Alfred → Features → Default Results → Setup fallback results 拖到第一）', 'bin/va-setup (or drag it to the top in Alfred → Features → Default Results → Setup fallback results)') });
    }
    let hashes: string[] = [];
    try { hashes = readdirSync(join(prefsRoot, 'preferences/local')); } catch { hashes = []; }
    if (hashes.length !== 1) add({ name: tr('Alfred 主热键', 'Alfred hotkey'), level: 'warn', detail: tr(`preferences/local 下有 ${hashes.length} 个机器目录，无法自动判断`, `${hashes.length} machine folders under preferences/local, cannot tell automatically`), fix: tr('Alfred 偏好 → General → Alfred Hotkey 设 ⌘Space', 'Alfred Preferences → General → Alfred Hotkey: set ⌘Space') });
    else {
      const hk = await plistJson(run, join(prefsRoot, 'preferences/local', hashes[0], 'hotkey/prefs.plist'));
      const d = hk?.default as { key?: number; mod?: number } | undefined;
      add(d?.key === 49 && d?.mod === 1048576
        ? { name: tr('Alfred 主热键', 'Alfred hotkey'), level: 'ok', detail: '⌘Space' }
        : { name: tr('Alfred 主热键', 'Alfred hotkey'), level: 'fail', detail: tr(`当前 key=${d?.key} mod=${d?.mod}`, `current key=${d?.key} mod=${d?.mod}`), fix: tr('bin/va-setup（会退出 Alfred 改 prefs 再打开）', 'bin/va-setup (quits Alfred, edits prefs, reopens)') });
    }

    // 7. Spotlight ⌘Space（只用 defaults read）
    const sp = await run('defaults', ['read', 'com.apple.symbolichotkeys', 'AppleSymbolicHotKeys']);
    const spOn = sp.code === 0 ? spotlightHotkeyEnabled(sp.stdout) : null;
    add(spOn === false
      ? { name: 'Spotlight ⌘Space', level: 'ok', detail: tr('已关闭（不会和 Alfred 抢）', 'disabled (no clash with Alfred)') }
      : spOn === true
        ? { name: 'Spotlight ⌘Space', level: 'fail', detail: tr('仍开启，会和 Alfred 抢 ⌘Space', 'still enabled, clashes with Alfred on ⌘Space'), fix: tr('系统设置 → 键盘 → 键盘快捷键 → 聚焦 → 取消勾选「显示聚焦搜索」（脚本不改系统设置）', 'System Settings → Keyboard → Keyboard Shortcuts → Spotlight → uncheck "Show Spotlight search" (scripts never change system settings)') }
        : { name: 'Spotlight ⌘Space', level: 'warn', detail: tr('读不到快捷键 64 的配置（多半是从没改过 = 默认开启）', 'cannot read shortcut 64 (usually never changed = enabled by default)'), fix: tr('系统设置 → 键盘 → 键盘快捷键 → 聚焦 → 取消勾选「显示聚焦搜索」', 'System Settings → Keyboard → Keyboard Shortcuts → Spotlight → uncheck "Show Spotlight search"') });
  }

  // 8. 索引新鲜度
  try {
    const st = JSON.parse(readFileSync(join(indexDir, 'state.json'), 'utf8')) as { lastRun?: string };
    const items = JSON.parse(readFileSync(join(indexDir, 'items.json'), 'utf8')) as unknown[];
    const ageMin = st.lastRun ? Math.round((now.getTime() - Date.parse(st.lastRun)) / 60_000) : Infinity;
    const level: Level = ageMin <= 90 ? 'ok' : ageMin <= 24 * 60 ? 'warn' : 'fail';
    add({ name: tr('索引新鲜度', 'Index freshness'), level, detail: tr(`上次 ${st.lastRun ?? '从未'}（${ageMin} 分钟前），${items.length} 条`, `last run ${st.lastRun ?? 'never'} (${ageMin} min ago), ${items.length} items`), fix: profile === 'sesame' ? tr('Sesame 启动时和每 30 分钟会自动整理；也可以手动跑 va-index', 'Sesame indexes on launch and every 30 minutes; you can also run va-index') : tr(`bin/va-index；长期不更新查 launchd ${BUNDLE_PREFIX}.va-index 与 logs/va-index.log`, `bin/va-index; if it stays stale check launchd ${BUNDLE_PREFIX}.va-index and logs/va-index.log`) });
  } catch {
    add({ name: tr('索引新鲜度', 'Index freshness'), level: 'fail', detail: tr(`${indexDir}/state.json 或 items.json 读不了`, `cannot read ${indexDir}/state.json or items.json`), fix: profile === 'sesame' ? tr('打开 Sesame 会自动建索引；或手动跑 va-index --full', 'Opening Sesame builds the index; or run va-index --full') : 'bin/va-index --full' });
  }

  // 9. 最近 24 小时错误
  const e = countRecentErrors(logDir, now);
  const alfErr = join(root, 'logs/alfred-errors.log');
  let alfRecent = 0;
  if (profile === 'alfred' && existsSync(alfErr)) {
    for (const l of readFileSync(alfErr, 'utf8').split('\n')) {
      const t = /^(\d{4}-\d{2}-\d{2}T\S+)/.exec(l)?.[1];
      if (t && Date.parse(t) >= now.getTime() - 86_400_000) alfRecent += 1;
    }
  }
  add({
    name: tr('最近 24 小时错误', 'Errors in the last 24h'), level: e.errors === 0 && alfRecent === 0 ? 'ok' : 'warn',
    detail: tr(`va 调用 ${e.total} 次，出错 ${e.errors} 次${e.samples.length ? `（${e.samples.join(' / ')}）` : ''}${profile === 'alfred' ? `；Alfred 侧失败 ${alfRecent} 次` : ''}`, `${e.total} va runs, ${e.errors} errors${e.samples.length ? ` (${e.samples.join(' / ')})` : ''}${profile === 'alfred' ? `; ${alfRecent} Alfred-side failures` : ''}`),
    fix: profile === 'alfred' ? tr(`看 ${logDir}/<今天>.jsonl 里 layer=error 的行和 ${root}/logs/alfred-errors.log`, `look for layer=error lines in ${logDir}/<today>.jsonl and ${root}/logs/alfred-errors.log`) : tr(`看 ${logDir}/<今天>.jsonl 里 layer=error 的行`, `look for layer=error lines in ${logDir}/<today>.jsonl`),
  });

  // 10. Alfred 外部触发自检（dry-run：va 收到自检参数只写标记文件，不调模型、不执行动作）
  if (!env.skipAlfredTrigger && profile === 'alfred') checks.push(await alfredSelftest(root, run));
  return checks;
}

export async function alfredSelftest(root: string, run: Runner, waitMs = 8000): Promise<Check> {
  const nonce = `d${Date.now().toString(36)}${process.pid}`;
  const marker = selftestMarkerPath(join(root, 'logs'), nonce);
  const r = await run('osascript', ['-e', 'on run argv\ntell application id "com.runningwithcrayons.Alfred" to run trigger "va" in workflow "' + ALFRED_BUNDLE + '" with argument (item 1 of argv)\nend run', `${SELFTEST_PREFIX} ${nonce}`], { timeoutMs: 15_000 });
  if (r.code !== 0) return { name: tr('Alfred 外部触发自检', 'Alfred external-trigger self-test'), level: 'fail', detail: tr(`osascript 失败：${r.stderr.trim().slice(0, 120)}`, `osascript failed: ${r.stderr.trim().slice(0, 120)}`), fix: tr('Alfred 没在运行/没装 workflow → bin/va-setup；-1743 = 当前终端没有「自动化 → Alfred」权限，系统设置里允许一次', 'Alfred not running / workflow missing → bin/va-setup; -1743 = this terminal lacks Automation → Alfred permission, allow it once in System Settings') };
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    if (existsSync(marker)) {
      try { unlinkSync(marker); } catch { /* 已删 */ }
      return { name: tr('Alfred 外部触发自检', 'Alfred external-trigger self-test'), level: 'ok', detail: tr(`Alfred → workflow → bin/va 链路通（${Date.now() - t0}ms，自检参数只写标记，无副作用）`, `Alfred → workflow → bin/va works (${Date.now() - t0}ms; the self-test only writes a marker, no side effects)`) };
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  return { name: tr('Alfred 外部触发自检', 'Alfred external-trigger self-test'), level: 'fail', detail: tr(`触发成功但 ${waitMs}ms 内 bin/va 没回标记`, `triggered, but bin/va wrote no marker within ${waitMs}ms`), fix: tr('看 logs/alfred-errors.log；手动跑 bin/va "__va_selftest__ x1234" 看报错', 'see logs/alfred-errors.log; run bin/va "__va_selftest__ x1234" by hand to see the error') };
}

export async function runDoctor(env: DoctorEnv): Promise<number> {
  const print = env.print ?? ((s: string) => process.stdout.write(`${s}\n`));
  const color = env.color ?? Boolean(process.stdout.isTTY);
  print(tr('va doctor（只读体检）', 'va doctor (read-only health check)'));
  const checks = await collectChecks(env);
  for (const c of checks) print(formatCheck(c, color));
  const fail = checks.filter((c) => c.level === 'fail').length;
  const warn = checks.filter((c) => c.level === 'warn').length;
  print(tr(`—— ${checks.length} 项：✅ ${checks.length - fail - warn} · ⚠️ ${warn} · ❌ ${fail}`, `—— ${checks.length} checks: ✅ ${checks.length - fail - warn} · ⚠️ ${warn} · ❌ ${fail}`));
  return fail ? 1 : 0;
}
