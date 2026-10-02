/**
 * Codex transcripts: ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<session uuid>.jsonl
 * Format (inspected on disk 2026-10-01, Codex CLI 0.98 → 0.153; same shape throughout):
 *   {"timestamp": "...", "type": "session_meta", "payload": {"id": "<uuid>", "cwd": "...", ...}}
 *   {"timestamp": "...", "type": "response_item", "payload": {"type": "message", "role": "user"|"assistant"|"developer",
 *       "content": [{"type": "input_text"|"output_text", "text": "..."}]}}
 *   other payload types: reasoning (encrypted), function_call / custom_tool_call (+ _output), event_msg, turn_context …
 * We only read user/assistant message text (like the Claude source reads conversation text, not tool output).
 * User messages that are injected context (start with "<", e.g. <environment_context>, or carry AGENTS.md
 * instructions) are skipped — they are not artifacts the user or the agent produced.
 */
import { join } from 'node:path';
import { extractUrlsFromText } from '../indexer.ts';
import type { LineResult } from '../indexer.ts';
import type { IndexSource } from './types.ts';

interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: { type?: string; role?: string; content?: Array<{ type?: string; text?: string }> };
}

const INJECTED = /^\s*</;

export function processCodexLine(line: string): LineResult {
  const res: LineResult = { hits: [], titles: [], files: [] };
  if (!line.includes('http') || !line.includes('"response_item"')) return res;
  let d: CodexLine;
  try {
    d = JSON.parse(line) as CodexLine;
  } catch {
    return res;
  }
  const p = d.payload;
  if (d.type !== 'response_item' || p?.type !== 'message' || (p.role !== 'user' && p.role !== 'assistant')) return res;
  const ts = d.timestamp ?? '';
  for (const b of p.content ?? []) {
    if (!b || typeof b.text !== 'string') continue;
    if (b.type !== 'input_text' && b.type !== 'output_text') continue;
    if (p.role === 'user' && (INJECTED.test(b.text) || b.text.includes('AGENTS.md instructions'))) continue;
    res.hits.push(...extractUrlsFromText(b.text, ts));
  }
  return res;
}

/** rollout-2026-10-01T16-06-35-<uuid>.jsonl → <uuid> */
export function codexSessionId(path: string): string {
  const f = (path.split('/').pop() ?? path).replace(/\.jsonl$/, '');
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(f);
  return m ? m[1] : f;
}

export const codexSource: IndexSource = {
  id: 'codex',
  defaultDir: (home) => join(home, '.codex', 'sessions'),
  accept: (p) => /\/rollout-[^/]*\.jsonl$/.test(p),
  processLine: (line) => processCodexLine(line),
  sessionIdOf: codexSessionId,
};
