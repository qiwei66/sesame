/**
 * 多进程安全的 JSON 文件读写（Alfred 开了并发执行：同一时刻可能有多个 va 进程写同一个文件）。
 *  - 临时文件名带 pid（+ 随机后缀），两个进程不会写同一个 .tmp
 *  - 写入走「加锁 → 重读盘上最新内容 → 合并本次改动 → 写临时文件 → rename」，rename 是原子的
 *  - 锁是 O_EXCL 创建的 <file>.lock，内容为持有者 pid；持有者已死或锁超过 staleMs 视为悬空，直接回收
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync, statSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function tmpPathFor(path: string): string {
  return `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
}

export function readJsonSync<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** 原子写：pid 临时文件 + rename；mode 给了就同时设权限（索引类文件 600） */
export function atomicWriteJsonSync(path: string, data: unknown, opts: { mode?: number; indent?: number } = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tmpPathFor(path);
  try {
    writeFileSync(tmp, JSON.stringify(data, null, opts.indent ?? 2), opts.mode !== undefined ? { mode: opts.mode } : undefined);
    if (opts.mode !== undefined) chmodSync(tmp, opts.mode);
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* 临时文件可能根本没建出来 */ }
    throw e;
  }
}

export class LockTimeoutError extends Error {}

/** 同步文件锁：拿不到就每 10–30ms 重试，最多 timeoutMs；超时抛 LockTimeoutError */
export function withFileLockSync<T>(path: string, fn: () => T, opts: { timeoutMs?: number; staleMs?: number } = {}): T {
  const lock = `${path}.lock`;
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  const staleMs = opts.staleMs ?? 10_000;
  mkdirSync(dirname(path), { recursive: true });
  for (;;) {
    let fd: number | null = null;
    try {
      fd = openSync(lock, 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (fd !== null) {
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      try {
        return fn();
      } finally {
        try { unlinkSync(lock); } catch { /* 已被当作悬空锁回收 */ }
      }
    }
    // 锁被占：判断是否悬空
    let holder = 0;
    let age = 0;
    try {
      holder = Number(readFileSync(lock, 'utf8').trim());
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      continue; // 锁刚被释放，立刻重试
    }
    // holder 为 0 = 别的进程刚 open 还没写 pid，按年龄判断
    if ((holder && !pidAlive(holder)) || age > staleMs) {
      try { unlinkSync(lock); } catch { /* 别人先回收了 */ }
      continue;
    }
    if (Date.now() > deadline) throw new LockTimeoutError(`lock busy: ${lock} (pid ${holder})`);
    sleepSync(10 + Math.floor(Math.random() * 20));
  }
}

/** 加锁 → 重读盘上最新内容 → mutate 给出新内容 → 原子写回；返回 mutate 的 result 与写回的内容 */
export function updateJsonSync<T, R>(
  path: string,
  fallback: () => T,
  mutate: (cur: T) => { data: T; result: R },
  opts: { mode?: number; indent?: number; timeoutMs?: number } = {},
): { result: R; data: T } {
  return withFileLockSync(path, () => {
    const out = mutate(readJsonSync<T>(path, fallback()));
    atomicWriteJsonSync(path, out.data, opts);
    return out;
  }, { timeoutMs: opts.timeoutMs });
}
