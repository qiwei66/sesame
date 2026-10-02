/**
 * Background index runs for the menu-bar app (`va serve` methods `index` / `indexStatus`).
 * The run happens in a child process (`node src/index-cli.ts --progress-json`) so a 60-second full index never
 * blocks `handle` / `search`; paths come from the same config/env as the server (resolvePaths), never from the app.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { IndexProgress } from './index-run.ts';
import { groupCounts, madeCount } from './title-quality.ts';
import type { Group } from './title-quality.ts';
import type { SavedItem } from './indexer.ts';

export interface IndexStatus {
  running: boolean;
  /** live progress while running */
  progress: IndexProgress | null;
  /** items in the index (live count while running, else items.json) */
  items: number;
  /** last finished run (state.json lastRun), ISO; null = never indexed */
  updatedAt: string | null;
  /** last run outcome: done | skipped (another run held the lock) | failed | null (none since the server started) */
  last: 'done' | 'skipped' | 'failed' | null;
  lastError: string | null;
  /** the first-run panel's six counts (dashboard / report / deck / site / pr / file); live while running */
  groups: Record<Group, number>;
  /** what the AI made (= sum of groups); `items` also counts links that were only mentioned */
  made: number;
}

interface Cached<T> { mtimeMs: number; size: number; value: T }

export class IndexService {
  private child: ChildProcess | null = null;
  private progress: IndexProgress | null = null;
  private last: IndexStatus['last'] = null;
  private lastError: string | null = null;
  private itemsCache: Cached<{ n: number; groups: Record<Group, number>; made: number }> | null = null;
  private stateCache: Cached<string | null> | null = null;
  private waiters: Array<() => void> = [];
  private finishHooks: Array<() => void> = [];

  /** Called after every run (va serve warms the search memo so the next keystroke is fast) */
  onFinish(f: () => void): void { this.finishHooks.push(f); }

  private o: { root: string; indexDir: string; env?: NodeJS.ProcessEnv; node?: string; script?: string };
  constructor(o: { root: string; indexDir: string; env?: NodeJS.ProcessEnv; node?: string; script?: string }) { this.o = o; }

  /** Start a run unless one is already running (from here). Returns the status right away. */
  start(full = false): IndexStatus {
    if (this.child) return this.status();
    const script = this.o.script ?? join(this.o.root, 'src/index-cli.ts');
    const args = ['--no-warnings', script, '--progress-json', ...(full ? ['--full'] : [])];
    const child = spawn(this.o.node ?? process.execPath, args, { env: this.o.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.progress = { phase: 'scan', filesDone: 0, filesTotal: 0, items: this.readItems().n, groups: this.readItems().groups };
    this.lastError = null;
    let outcome: IndexStatus['last'] = null;
    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      try {
        const m = JSON.parse(line) as { progress?: IndexProgress; done?: unknown; skipped?: string; failed?: string };
        if (m.progress) this.progress = m.progress;
        if (m.done) outcome = 'done';
        if (m.skipped) outcome = 'skipped';
        if (m.failed) { outcome = 'failed'; this.lastError = m.failed; }
      } catch { /* not a protocol line */ }
    });
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[va-index] ${String(d)}`));
    const end = (code: number | null, err?: Error) => {
      if (this.child !== child) return;
      this.child = null;
      this.progress = null;
      this.last = outcome ?? (code === 0 ? 'done' : 'failed');
      if (this.last === 'failed' && !this.lastError) this.lastError = err?.message ?? `exit ${code}`;
      const w = this.waiters; this.waiters = [];
      for (const f of w) f();
      for (const f of this.finishHooks) { try { f(); } catch { /* a warm-up must never break the server */ } }
    };
    child.on('error', (e) => end(null, e));
    child.on('close', (code) => end(code));
    return this.status();
  }

  /** Resolves when the current run (if any) has finished */
  wait(): Promise<void> {
    if (!this.child) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  status(): IndexStatus {
    const running = this.child !== null;
    return {
      running,
      progress: running ? this.progress : null,
      items: running && this.progress ? Math.max(this.progress.items, 0) : this.readItems().n,
      updatedAt: this.readUpdatedAt(),
      last: this.last,
      lastError: this.lastError,
      groups: running && this.progress?.groups ? this.progress.groups : this.readItems().groups,
      made: running && this.progress?.groups ? Object.values(this.progress.groups).reduce((a, b) => a + b, 0) : this.readItems().made,
    };
  }

  private cached<T>(path: string, slot: 'itemsCache' | 'stateCache', parse: (raw: string) => T, fallback: T): T {
    try {
      const st = statSync(path);
      const c = this[slot] as Cached<T> | null;
      if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.value;
      const value = parse(readFileSync(path, 'utf8'));
      (this as unknown as Record<string, Cached<T>>)[slot] = { mtimeMs: st.mtimeMs, size: st.size, value };
      return value;
    } catch {
      return fallback;
    }
  }

  private readItems(): { n: number; groups: Record<Group, number>; made: number } {
    const empty = { n: 0, groups: groupCounts([]), made: 0 };
    return this.cached(join(this.o.indexDir, 'items.json'), 'itemsCache', (raw) => {
      const v = JSON.parse(raw) as unknown;
      return Array.isArray(v) ? { n: v.length, groups: groupCounts(v as SavedItem[]), made: madeCount(v as SavedItem[]) } : empty;
    }, empty);
  }

  private readUpdatedAt(): string | null {
    return this.cached(join(this.o.indexDir, 'state.json'), 'stateCache', (raw) => (JSON.parse(raw) as { lastRun?: string }).lastRun ?? null, null);
  }
}
