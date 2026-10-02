/**
 * Model providers: anything that speaks OpenAI-compatible `POST {base_url}/chat/completions` with tools.
 * A provider = base_url + model + where to read the key (env / macOS Keychain / file). Keys are only
 * read into memory and put in the Authorization header — never printed, logged or returned over RPC.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Config, KeySource, ProviderConfig } from './config.ts';
import { expandHome } from './config.ts';
import { readApiKey } from './llm.ts';
import type { Runner } from './types.ts';

export interface ResolvedProvider {
  name: string;
  base_url: string;
  model: string;
  key: KeySource[];
  /** Local servers (ollama / lmstudio) work without a key */
  keyOptional: boolean;
  extra_body: Record<string, unknown>;
  price?: ProviderConfig['price'];
  max_tokens: number;
}

/**
 * Presets. Base URLs are the providers' documented OpenAI-compatible endpoints:
 *  - DeepSeek  https://api.deepseek.com (/chat/completions); thinking disabled to save tokens and
 *              avoid the reasoning_content round-trip requirement when tools are used
 *  - OpenAI    https://api.openai.com/v1
 *  - Ollama    http://127.0.0.1:11434/v1   (OpenAI compatibility layer, no key)
 *  - LM Studio http://127.0.0.1:1234/v1    (local server, no key; set `model` to the loaded model id)
 * Default models are starting points — override `model` in config.yaml.
 */
export const PRESETS: Record<string, Omit<ResolvedProvider, 'name'>> = {
  deepseek: {
    base_url: 'https://api.deepseek.com', model: 'deepseek-flash', key: [{ env: 'DEEPSEEK_API_KEY' }, { keychain: { service: 'voice-agent.deepseek' } }],
    keyOptional: false, extra_body: { thinking: { type: 'disabled' } }, max_tokens: 400,
  },
  openai: {
    base_url: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', key: [{ env: 'OPENAI_API_KEY' }, { keychain: { service: 'voice-agent.openai' } }],
    keyOptional: false, extra_body: {}, max_tokens: 400,
  },
  ollama: { base_url: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', key: [], keyOptional: true, extra_body: {}, max_tokens: 400, price: { input: 0, cached_input: 0, output: 0, currency: '¥' } },
  lmstudio: { base_url: 'http://127.0.0.1:1234/v1', model: 'local-model', key: [], keyOptional: true, extra_body: {}, max_tokens: 400, price: { input: 0, cached_input: 0, output: 0, currency: '¥' } },
};

export function resolveProvider(cfg: Config, env: NodeJS.ProcessEnv = process.env): ResolvedProvider {
  const name = env.VA_PROVIDER || cfg.provider || 'deepseek';
  const preset = PRESETS[name];
  const user = cfg.providers[name] ?? {};
  if (!preset && !user.base_url) throw new Error(`unknown provider "${name}" (presets: ${Object.keys(PRESETS).join(', ')}; or define providers.${name}.base_url)`);
  const base = preset ?? { base_url: '', model: '', key: [], keyOptional: true, extra_body: {}, max_tokens: 400 };
  const key: KeySource[] = [...(user.key ?? base.key)];
  // Back-compat env overrides
  if (env.VA_KEY_FILE) key.unshift({ file: env.VA_KEY_FILE });
  return {
    name,
    base_url: (env.VA_BASE_URL || (name === 'deepseek' ? env.VA_DEEPSEEK_BASE : '') || user.base_url || base.base_url).replace(/\/+$/, ''),
    model: env.VA_MODEL || (name === 'deepseek' ? env.VA_DEEPSEEK_MODEL : '') || user.model || base.model,
    key,
    keyOptional: base.keyOptional && !user.key,
    extra_body: { ...base.extra_body, ...(user.extra_body ?? {}) },
    price: user.price ?? base.price,
    max_tokens: user.max_tokens ?? base.max_tokens,
  };
}

/** Where the key came from, for doctor output (never the value) */
export interface KeyResult { key: string | null; from: string | null; tried: string[] }

export async function readProviderKey(p: ResolvedProvider, run: Runner, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Promise<KeyResult> {
  const tried: string[] = [];
  for (const s of p.key) {
    if (s.env) {
      tried.push(`env ${s.env}`);
      const v = env[s.env]?.trim();
      if (v) return { key: v, from: `env ${s.env}`, tried };
    }
    if (s.file) {
      const f = expandHome(s.file, home);
      tried.push(`file ${s.file}`);
      if (existsSync(f)) {
        try {
          return { key: readApiKey(f), from: `file ${s.file}`, tried };
        } catch {
          // empty file → try next source
        }
      }
    }
    if (s.keychain?.service) {
      tried.push(`keychain ${s.keychain.service}`);
      const args = ['find-generic-password', '-s', s.keychain.service, ...(s.keychain.account ? ['-a', s.keychain.account] : []), '-w'];
      const r = await run('security', args, { timeoutMs: 5000 });
      const v = r.code === 0 ? r.stdout.trim() : '';
      if (v) return { key: v, from: `keychain ${s.keychain.service}`, tried };
    }
  }
  return { key: null, from: null, tried };
}

/** ¥ estimate for one run; null when the provider has no price configured */
export function estimateCost(p: Pick<ResolvedProvider, 'price'>, u: { prompt_tokens: number; completion_tokens: number; prompt_cache_hit_tokens?: number }): { amount: number; currency: string } | null {
  const pr = p.price;
  if (!pr || !Number.isFinite(pr.input) || !Number.isFinite(pr.output)) return null;
  const hit = u.prompt_cache_hit_tokens ?? 0;
  const cachedPrice = Number.isFinite(pr.cached_input) ? (pr.cached_input as number) : (pr.input as number);
  const amount = ((u.prompt_tokens - hit) * (pr.input as number) + hit * cachedPrice + u.completion_tokens * (pr.output as number)) / 1_000_000;
  return { amount: Math.round(amount * 1e8) / 1e8, currency: pr.currency || '¥' };
}
