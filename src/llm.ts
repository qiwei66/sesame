import { readFileSync } from 'node:fs';
import type { Usage } from './types.ts';

/**
 * OpenAI-compatible Chat Completions client (DeepSeek / OpenAI / Ollama / LM Studio …, see providers.ts).
 * DeepSeek notes (official docs, checked 2026-10-01):
 *  - base_url https://api.deepseek.com, path /chat/completions, model deepseek-flash supports tool calls
 *  - thinking mode is on by default; {"thinking": {"type": "disabled"}} turns it off (with tools + thinking the
 *    reasoning_content must be sent back, else HTTP 400 — we disable thinking, which also saves tokens)
 *  https://api-docs.deepseek.com/guides/tool_calls · https://api-docs.deepseek.com/guides/thinking_mode
 */
export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface ChatResponse {
  message: ChatMessage;
  usage: Usage;
  finishReason: string;
}

export type ChatFn = (messages: ChatMessage[], tools: unknown[]) => Promise<ChatResponse>;

/** 密钥文件是单行裸 key（无 KEY= 前缀）；也兼容 KEY=VALUE。只读取，绝不打印 */
export function readApiKey(path: string): string {
  const raw = readFileSync(path, 'utf8');
  const line = raw.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '';
  const eq = line.indexOf('=');
  const key = (eq >= 0 && /^[A-Z_]+$/.test(line.slice(0, eq)) ? line.slice(eq + 1) : line).replace(/^["']|["']$/g, '').trim();
  if (!key) throw new Error(`key file is empty: ${path}`);
  return key;
}

export interface ChatEndpoint {
  base_url: string;
  model: string;
  /** null = no Authorization header (local servers) */
  apiKey: string | null;
  extra_body?: Record<string, unknown>;
  max_tokens?: number;
  /** Label used in error messages */
  name?: string;
}

export function makeChat(ep: ChatEndpoint, opts: { timeoutMs?: number } = {}): ChatFn {
  return async (messages, tools) => {
    const body = {
      model: ep.model,
      messages,
      ...(tools.length ? { tools } : {}),
      ...(ep.extra_body ?? {}),
      max_tokens: ep.max_tokens ?? 400,
      stream: false,
    };
    const res = await fetch(`${ep.base_url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(ep.apiKey ? { Authorization: `Bearer ${ep.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      // error body only, never request headers (keeps the key out of logs)
      throw new Error(`${ep.name ?? 'model'} HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const j = JSON.parse(text) as {
      choices: Array<{ message: ChatMessage; finish_reason: string }>;
      usage: Usage;
    };
    const choice = j.choices[0];
    return { message: { role: 'assistant', content: choice.message.content ?? null, tool_calls: choice.message.tool_calls }, usage: j.usage, finishReason: choice.finish_reason };
  };
}
