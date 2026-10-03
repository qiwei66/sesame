/**
 * User configuration. Lives OUTSIDE the repo:
 *   $VA_CONFIG_DIR  or  $XDG_CONFIG_HOME/voice-agent  or  ~/.config/voice-agent
 *     config.yaml      main settings (see docs/config.md)
 *     commands.yaml    custom whitelisted shell commands (see docs/commands.md)
 *     skills/*.ts      user skills (tool plugins, see docs/skills.md)
 * Missing files = defaults (a "blank" stranger setup). Nothing here is ever sent to the model except
 * the prompt-facing fields (user_name, known_urls, prompt_rules, command descriptions).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseYaml } from './yaml.ts';
import type { YamlValue } from './yaml.ts';
import type { LocaleSetting } from './i18n.ts';

export const APP_ID = 'voice-agent';

export interface KnownUrl { name: string; url: string }

export interface KeySource {
  env?: string;
  file?: string;
  keychain?: { service: string; account?: string };
}

export interface ProviderConfig {
  base_url?: string;
  model?: string;
  /** Tried in order; first one that yields a non-empty key wins */
  key?: KeySource[];
  /** Extra JSON merged into the request body (e.g. DeepSeek `thinking`) */
  extra_body?: Record<string, unknown>;
  /** Price per 1M tokens, used only for the cost label. Unset = cost shown as unknown */
  price?: { input?: number; cached_input?: number; output?: number; currency?: string };
  max_tokens?: number;
}

export interface Config {
  /** Where config was read from (for doctor / RPC) */
  dir: string;
  locale: LocaleSetting;
  /** Name used in the system prompt ("You are <user_name>'s Mac voice assistant"); empty = generic */
  user_name: string;
  /** macOS `say -v` voice; empty = system default voice */
  voice: string;
  /** Read results aloud by default */
  speak: boolean;
  /** Active provider profile name (deepseek | openai | ollama | lmstudio | any key under `providers`) */
  provider: string;
  providers: Record<string, ProviderConfig>;
  /** URLs the model may open by name (personal bookmarks) */
  known_urls: KnownUrl[];
  /** Extra numbered rules appended to the system prompt */
  prompt_rules: string[];
  /** Conversation sources to index: claude, codex */
  sources: string[];
  /** Hostnames/IPs that are THIS machine (e.g. its Tailscale IP): local services seen on them open via 127.0.0.1 */
  self_hosts: string[];
  /** Extra spoken-name → App name aliases (on top of auto-discovered localized names) */
  app_aliases: Record<string, string>;
  /** List localized app names in the prompt ("Lark（飞书）"); false = bundle names only */
  prompt_localized_app_names: boolean;
  /** Override the index / cache / log directory (default: the repo root) */
  data_dir?: string;
  /** Index directory (default <data_dir>/index); env VA_INDEX_DIR wins */
  index_dir?: string;
  /** Run-log directory (default <data_dir>/logs); env VA_LOG_DIR wins */
  log_dir?: string;
  /** Language of output that has no input sentence (doctor, CLI usage): auto (system language) | zh | en */
  ui_locale: LocaleSetting;
  /** Personal search vocabulary: groups of words that mean the same thing to you (`- [库存, inventory]`), src/query.ts */
  synonyms: string[][];
}

export interface VaPaths { appRoot: string; dataDir: string; indexDir: string; logDir: string }

/** Marker written by `make install` into an installed core (CORE_DIR). Its presence moves the default data dir out of the core dir. */
export const INSTALL_MARKER = '.sesame-install';

/**
 * Default data dir when config has no data_dir:
 *  - an installed core (`make install`, marker file present): ~/Library/Application Support/Sesame on macOS,
 *    $XDG_DATA_HOME/sesame (or ~/.local/share/sesame/data) elsewhere — reinstalling the core (rsync --delete) never wipes the index
 *  - env VA_INSTALLED=1 counts as installed too: the Claude Code plugin runs the core from its plugin cache and must
 *    share the app's index (and never keep data in a cache dir that is replaced on every plugin update)
 *  - a git checkout: the repo root (unchanged behavior for developers)
 */
export function defaultDataDir(appRoot: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir(), platform: string = process.platform): string {
  if (env.VA_INSTALLED !== '1' && !existsSync(join(appRoot, INSTALL_MARKER))) return appRoot;
  if (platform === 'darwin') return join(home, 'Library/Application Support/Sesame');
  return env.XDG_DATA_HOME ? join(env.XDG_DATA_HOME, 'sesame') : join(home, '.local/share/sesame/data');
}

/** Where data lives. Precedence: env (VA_INDEX_DIR / VA_LOG_DIR) > config (index_dir / log_dir) > <data_dir>/{index,logs} > default data dir (see defaultDataDir) */
export function resolvePaths(cfg: Config, appRoot: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): VaPaths {
  const dataDir = cfg.data_dir ? expandHome(cfg.data_dir, home) : defaultDataDir(appRoot, env, home);
  return {
    appRoot,
    dataDir,
    indexDir: env.VA_INDEX_DIR || (cfg.index_dir ? expandHome(cfg.index_dir, home) : join(dataDir, 'index')),
    logDir: env.VA_LOG_DIR || (cfg.log_dir ? expandHome(cfg.log_dir, home) : join(dataDir, 'logs')),
  };
}

export function configDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (env.VA_CONFIG_DIR) return env.VA_CONFIG_DIR;
  const xdg = env.XDG_CONFIG_HOME || join(home, '.config');
  return join(xdg, APP_ID);
}

export function defaultConfig(dir: string): Config {
  return {
    dir, locale: 'auto', user_name: '', voice: '', speak: false, provider: 'deepseek', providers: {},
    known_urls: [], prompt_rules: [], sources: ['claude', 'codex'], self_hosts: [], app_aliases: {}, prompt_localized_app_names: true, ui_locale: 'auto', synonyms: [],
  };
}

/** `~` / `~/x` / `$HOME/x` → absolute */
export function expandHome(p: string, home: string = homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p.replace(/^\$HOME(?=\/|$)/, home);
}

const asStr = (v: YamlValue | undefined, d = ''): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : d);
const asObj = (v: YamlValue | undefined): Record<string, YamlValue> => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const asArr = (v: YamlValue | undefined): YamlValue[] => (Array.isArray(v) ? v : []);

function keySources(v: YamlValue | undefined): KeySource[] | undefined {
  if (v === undefined || v === null) return undefined;
  const list = Array.isArray(v) ? v : [v];
  return list.map((x) => {
    const o = asObj(x);
    const kc = asObj(o.keychain);
    const ks: KeySource = {};
    if (o.env) ks.env = asStr(o.env);
    if (o.file) ks.file = asStr(o.file);
    if (o.keychain) ks.keychain = typeof o.keychain === 'string' ? { service: o.keychain } : { service: asStr(kc.service), ...(kc.account ? { account: asStr(kc.account) } : {}) };
    return ks;
  });
}

function toJson(v: YamlValue): unknown {
  return v;
}

export function parseConfig(raw: YamlValue, dir: string): Config {
  const c = defaultConfig(dir);
  const o = asObj(raw);
  if (o.locale === 'zh' || o.locale === 'en' || o.locale === 'auto') c.locale = o.locale;
  c.user_name = asStr(o.user_name);
  c.voice = asStr(o.voice);
  c.speak = o.speak === true;
  if (o.provider) c.provider = asStr(o.provider);
  for (const [name, pv] of Object.entries(asObj(o.providers))) {
    const p = asObj(pv);
    const price = asObj(p.price);
    c.providers[name] = {
      ...(p.base_url ? { base_url: asStr(p.base_url) } : {}),
      ...(p.model ? { model: asStr(p.model) } : {}),
      ...(p.key !== undefined ? { key: keySources(p.key) } : {}),
      ...(p.extra_body ? { extra_body: toJson(p.extra_body) as Record<string, unknown> } : {}),
      ...(p.price ? { price: { input: Number(price.input ?? NaN), cached_input: Number(price.cached_input ?? NaN), output: Number(price.output ?? NaN), currency: asStr(price.currency, '¥') } } : {}),
      ...(typeof p.max_tokens === 'number' ? { max_tokens: p.max_tokens } : {}),
    };
  }
  c.known_urls = asArr(o.known_urls).map((u) => ({ name: asStr(asObj(u).name), url: asStr(asObj(u).url) })).filter((u) => u.name && /^https?:\/\//.test(u.url));
  c.prompt_rules = asArr(o.prompt_rules).map((r) => asStr(r)).filter(Boolean);
  if (Array.isArray(o.sources)) c.sources = o.sources.map((s) => asStr(s)).filter(Boolean);
  c.self_hosts = asArr(o.self_hosts).map((s) => asStr(s)).filter(Boolean);
  c.app_aliases = Object.fromEntries(Object.entries(asObj(o.app_aliases)).map(([k, v]) => [k, asStr(v)]));
  if (o.prompt_localized_app_names === false) c.prompt_localized_app_names = false;
  if (o.data_dir) c.data_dir = asStr(o.data_dir);
  if (o.index_dir) c.index_dir = asStr(o.index_dir);
  if (o.log_dir) c.log_dir = asStr(o.log_dir);
  if (o.ui_locale === 'zh' || o.ui_locale === 'en' || o.ui_locale === 'auto') c.ui_locale = o.ui_locale;
  c.synonyms = asArr(o.synonyms).map((g) => asArr(g).map((w) => asStr(w)).filter(Boolean)).filter((g) => g.length >= 2);
  return c;
}

export function loadConfig(dir: string = configDir()): Config {
  const p = join(dir, 'config.yaml');
  if (!existsSync(p)) return defaultConfig(dir);
  return parseConfig(parseYaml(readFileSync(p, 'utf8')), dir);
}

// ── process-wide active config (set once at startup by cli / rpc; tests set their own) ──
let active: Config = defaultConfig(configDir());

export function getConfig(): Config {
  return active;
}

export function setConfig(c: Config): void {
  active = c;
}
