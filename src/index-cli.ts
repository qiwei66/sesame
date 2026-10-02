import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, mkdirSync } from 'node:fs';
import { runIndex } from './index-run.ts';
import { loadConfig, resolvePaths, setConfig } from './config.ts';
import { resolveSources } from './sources/index.ts';
import { INDEX_USAGE, isHelpArgs } from './help.ts';

if (isHelpArgs(process.argv.slice(2))) {
  process.stdout.write(INDEX_USAGE);
  process.exit(0);   // print usage only: no config read, no index run
}

const CFG = loadConfig();
setConfig(CFG);
const PATHS = resolvePaths(CFG, join(dirname(fileURLToPath(import.meta.url)), '..'));
const LOG = join(PATHS.logDir, 'va-index.log');
/** --progress-json: stdout carries only JSON lines ({progress} / {done} / {skipped}); log lines go to stderr (used by `va serve` index runs) */
const JSON_OUT = process.argv.includes('--progress-json');
const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);

function log(s: string): void {
  mkdirSync(PATHS.logDir, { recursive: true });
  const line = `${new Date().toISOString()} ${s}`;
  appendFileSync(LOG, `${line}\n`);
  (JSON_OUT ? process.stderr : process.stdout).write(`${line}\n`);
}

const full = process.argv.includes('--full');
runIndex(
  { sources: resolveSources(CFG.sources, homedir()), indexDir: PATHS.indexDir },
  { full, log, ...(JSON_OUT ? { onProgress: (p) => out({ progress: p }) } : {}) },
).then((s) => {
  if (s) log(`ok full=${full} scanned=${s.scannedFiles} changed=${s.changedFiles} readBytes=${s.newBytes} items=${s.items} byKind=${JSON.stringify(s.byKind)} localTitled=${s.titledLocal} ${s.durationMs}ms`);
  if (JSON_OUT) out(s ? { done: { items: s.items, durationMs: s.durationMs, changedFiles: s.changedFiles } } : { skipped: 'another index run holds the lock' });
  process.exit(0);
}, (e: unknown) => {
  log(`FAIL ${(e as Error).stack ?? String(e)}`);
  if (JSON_OUT) out({ failed: String((e as Error).message ?? e).slice(0, 200) });
  process.exit(1);
});
