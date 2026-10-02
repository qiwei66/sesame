import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunReport } from './types.ts';

const pad = (n: number) => String(n).padStart(2, '0');

export function logFilePath(logDir: string, d: Date): string {
  return join(logDir, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`);
}

/** 防御性脱敏：任何形似 API key 的串一律打码（key 本身从不进 report，这是第二道闸） */
export function redact(s: string): string {
  return s.replace(/sk-[A-Za-z0-9]{16,}/g, 'sk-***').replace(/Bearer\s+\S+/g, 'Bearer ***');
}

export function writeLog(logDir: string, report: RunReport, at: Date): string {
  mkdirSync(logDir, { recursive: true });
  const path = logFilePath(logDir, at);
  appendFileSync(path, `${redact(JSON.stringify({ ts: at.toISOString(), ...report }))}\n`);
  return path;
}
