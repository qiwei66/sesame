/**
 * Installed-app discovery + fuzzy name matching (replaces a hand-written alias table).
 * For every /Applications/*.app (and system app dirs) we collect:
 *   - the bundle file name ("Lark")
 *   - Info.plist CFBundleDisplayName / CFBundleName ("Feishu")
 *   - localized CFBundleDisplayName / CFBundleName from <lang>.lproj/InfoPlist.strings ("飞书")
 * Plists are read with `plutil -convert json` (handles XML, binary and UTF-16 .strings); results are cached
 * in <stateDir>/apps-cache.json keyed by bundle path + mtime, so only new/updated apps are re-read.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { atomicWriteJsonSync } from './fsutil.ts';
import { getConfig } from './config.ts';

export const APP_DIRS = ['/Applications', '/System/Applications', '/System/Applications/Utilities', '/Applications/Utilities'];
const LPROJ = ['zh-Hans', 'zh_CN', 'zh-Hant', 'zh_TW', 'zh_HK', 'en', 'Base', 'English'];

export interface AppEntry {
  /** Bundle file name without .app — what `open -a` takes */
  app: string;
  names: string[];
}

interface CacheFile { v: 1; apps: Record<string, { mtimeMs: number; names: string[] }> }

function plistJson(path: string): Record<string, unknown> | null {
  try {
    const out = execFileSync('plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
    const v = JSON.parse(out) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Names of one bundle (exported for tests with a fake reader) */
export function bundleNames(appPath: string, read: (p: string) => Record<string, unknown> | null = plistJson): string[] {
  const names = new Set<string>();
  const add = (v: unknown) => { if (typeof v === 'string' && v.trim()) names.add(v.trim()); };
  const info = read(join(appPath, 'Contents', 'Info.plist'));
  add(info?.CFBundleDisplayName);
  add(info?.CFBundleName);
  const res = join(appPath, 'Contents', 'Resources');
  for (const l of LPROJ) {
    const f = join(res, `${l}.lproj`, 'InfoPlist.strings');
    if (!existsSync(f)) continue;
    const s = read(f);
    add(s?.CFBundleDisplayName);
    add(s?.CFBundleName);
  }
  return [...names];
}

export function scanApps(opts: { dirs?: string[]; cachePath?: string } = {}): AppEntry[] {
  const dirs = opts.dirs ?? APP_DIRS;
  let cache: CacheFile = { v: 1, apps: {} };
  if (opts.cachePath && existsSync(opts.cachePath)) {
    try { cache = JSON.parse(readFileSync(opts.cachePath, 'utf8')) as CacheFile; } catch { cache = { v: 1, apps: {} }; }
  }
  let dirty = false;
  const out: AppEntry[] = [];
  const seen = new Set<string>();
  for (const d of dirs) {
    let entries: string[];
    try { entries = readdirSync(d); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.app')) continue;
      const app = f.slice(0, -4);
      if (seen.has(app)) continue;
      seen.add(app);
      const p = join(d, f);
      let mtimeMs = 0;
      try { mtimeMs = statSync(p).mtimeMs; } catch { continue; }
      let c = cache.apps[p];
      if (!c || c.mtimeMs !== mtimeMs) {
        c = { mtimeMs, names: bundleNames(p) };
        cache.apps[p] = c;
        dirty = true;
      }
      out.push({ app, names: [...new Set([app, ...c.names])] });
    }
  }
  if (dirty && opts.cachePath) {
    try { atomicWriteJsonSync(opts.cachePath, cache, { mode: 0o600 }); } catch { /* cache is best-effort */ }
  }
  return out;
}

/** Comparable form: NFKC, lower-case, no spaces/punctuation, no trailing ".app" */
export function nameKey(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\.app$/, '').replace(/[\p{P}\p{S}\s]+/gu, '');
}

/**
 * Best matching app for a spoken name:
 *  1. explicit alias (config app_aliases) → that app if installed
 *  2. exact match on any known name (bundle / display / localized)
 *  3. unique prefix / containment match (≥2 chars), shortest name wins
 */
export function matchApp(spoken: string, apps: AppEntry[], aliases: Record<string, string> = {}): string | null {
  const q = nameKey(spoken);
  if (!q) return null;
  const aliasTarget = Object.entries(aliases).find(([k]) => nameKey(k) === q)?.[1];
  const pool = aliasTarget ? [nameKey(aliasTarget)] : [q];
  for (const k of pool) {
    const exact = apps.find((a) => a.names.some((n) => nameKey(n) === k));
    if (exact) return exact.app;
  }
  if (q.length < 2) return null;
  const scored: Array<{ app: string; len: number }> = [];
  for (const a of apps) {
    for (const n of a.names) {
      const nk = nameKey(n);
      if (nk.length >= 2 && (nk.startsWith(q) || q.startsWith(nk) || nk.includes(q))) { scored.push({ app: a.app, len: nk.length }); break; }
    }
  }
  if (scored.length === 0) return null;
  scored.sort((x, y) => x.len - y.len);
  return scored[0].app;
}

/** "Lark (飞书, Feishu)" style list for the system prompt */
export function describeApps(apps: AppEntry[]): string {
  return [...apps].sort((a, b) => (a.app < b.app ? -1 : 1)).map((a) => a.app).join('、');
}

// ── process-wide app list (lazy). Bundle names are cheap (readdir); localized names need plutil, so they
//    are only loaded when a spoken name does not match a bundle name directly. ──
let appsCachePath: string | undefined;
let bundleOnly: AppEntry[] | null = null;
let full: AppEntry[] | null = null;
let injected: AppEntry[] | null = null;

export function setAppsCachePath(p: string | undefined): void { appsCachePath = p; }
/** Tests / RPC: use a fixed app list instead of scanning the disk */
export function setApps(apps: AppEntry[] | null): void { injected = apps; bundleOnly = null; full = null; }

function listBundleOnly(): AppEntry[] {
  if (injected) return injected;
  if (bundleOnly) return bundleOnly;
  const out: AppEntry[] = [];
  const seen = new Set<string>();
  for (const d of APP_DIRS) {
    let entries: string[];
    try { entries = readdirSync(d); } catch { continue; }
    for (const f of entries) if (f.endsWith('.app') && !seen.has(f)) { seen.add(f); out.push({ app: f.slice(0, -4), names: [f.slice(0, -4)] }); }
  }
  return (bundleOnly = out);
}

export function installedApps(localized = false): AppEntry[] {
  if (injected) return injected;
  if (!localized) return listBundleOnly();
  return (full ??= scanApps({ cachePath: appsCachePath }));
}

/**
 * Spoken / written app name → installed bundle name, or null.
 * Order: config app_aliases → exact bundle name → localized/display names (飞书 → Lark) → fuzzy containment.
 */
export function resolveApp(name: string, aliases: Record<string, string> = getConfig().app_aliases): string | null {
  const n = name.trim().replace(/\.app$/i, '');
  if (!n) return null;
  const q = nameKey(n);
  const target = Object.entries(aliases).find(([k]) => nameKey(k) === q)?.[1];
  const bundles = installedApps(false);
  const direct = bundles.find((a) => nameKey(a.app) === nameKey(target ?? n));
  if (direct) return direct.app;
  return matchApp(n, installedApps(true), aliases);
}
