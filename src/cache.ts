import { readJsonSync, updateJsonSync, LockTimeoutError } from './fsutil.ts';
import type { ToolCall } from './types.ts';

export interface CacheEntry {
  /** 第一次写入时的原话（仅供人看） */
  sample: string;
  actions: ToolCall[];
  createdAt: string;
  hits: number;
  lastHitAt?: string;
  /** 写入时的工具表版本号（TOOLS_VERSION）；与当前不一致 = 作废 */
  toolsVersion?: string;
}

/** 缓存文件格式 v2：entries = 可回放；candidates = 只出现过一次的规划，第二次得到相同规划才转正 */
export interface CacheData {
  v: 2;
  entries: Record<string, CacheEntry>;
  candidates: Record<string, CacheEntry>;
}

export type ProposeResult = 'confirmed' | 'candidate';

export interface CacheStore {
  get(key: string): CacheEntry | undefined;
  /** 直接写入为已确认（测试/迁移用；正常路径用 propose） */
  set(key: string, entry: CacheEntry): void;
  /** 记一次规划：已有相同候选 → 转正（confirmed）；否则记为候选（覆盖旧候选） */
  propose(key: string, entry: CacheEntry): ProposeResult;
  getCandidate(key: string): CacheEntry | undefined;
  touch(key: string, at: string): void;
  delete(key: string): void;
  keys(): string[];
}

/** 规划签名：动作名 + 参数（含 open_saved 选中项 key），键顺序无关 */
export function planSignature(actions: ToolCall[]): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(stable(actions));
}

const emptyData = (): CacheData => ({ v: 2, entries: {}, candidates: {} });

/** 测试/自检句：不管新旧格式都不许留在缓存里 */
export const POLLUTION_RE = /测试|test|autoenter|selftest|^__va/i;

/**
 * 读盘内容 → v2。v1（扁平 Record）的旧条目一律丢弃：它们没有工具表版本号、且都是「只见过一次就写入」的
 * （含 测试autoenter916 这类测试污染），按新规则本来就不该存在；常用句再说两次就会重新进缓存。
 * v2 里如果混进了测试/自检句（POLLUTION_RE），读的时候也顺手剔掉。
 */
export function migrate(raw: unknown): CacheData {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyData();
  const r = raw as Record<string, unknown>;
  if (r.v !== 2 || !r.entries || typeof r.entries !== 'object' || !r.candidates || typeof r.candidates !== 'object') return emptyData();
  const d = r as unknown as CacheData;
  const clean = (m: Record<string, CacheEntry>) => Object.fromEntries(Object.entries(m).filter(([k, e]) => !POLLUTION_RE.test(k) && !POLLUTION_RE.test(e?.sample ?? '')));
  return { v: 2, entries: clean(d.entries), candidates: clean(d.candidates) };
}

/** 一次改动 = 一个作用于 CacheData 的函数；内存实现直接作用于 this.data，文件实现在锁内作用于盘上最新内容 */
type Op<R> = (d: CacheData) => R;

const sameEntry = (a: CacheEntry | undefined, b: CacheEntry): boolean =>
  a !== undefined && a.toolsVersion === b.toolsVersion && planSignature(a.actions) === planSignature(b.actions);

const ops = {
  set: (key: string, entry: CacheEntry): Op<void> => (d) => {
    d.entries[key] = entry;
    delete d.candidates[key];
  },
  propose: (key: string, entry: CacheEntry): Op<ProposeResult> => (d) => {
    if (sameEntry(d.entries[key], entry)) return 'confirmed';
    const cand = d.candidates[key];
    if (sameEntry(cand, entry)) {
      d.entries[key] = { ...entry, sample: cand?.sample || entry.sample };
      delete d.candidates[key];
      return 'confirmed';
    }
    d.candidates[key] = entry;
    return 'candidate';
  },
  touch: (key: string, at: string): Op<void> => (d) => {
    const e = d.entries[key];
    if (!e) return;
    e.hits += 1;
    e.lastHitAt = at;
  },
  delete: (key: string): Op<void> => (d) => {
    delete d.entries[key];
  },
};

export class MemoryCache implements CacheStore {
  protected data: CacheData;
  /** initial：v1 扁平格式（视为已确认条目，测试用）或 v2 */
  constructor(initial: Record<string, CacheEntry> | CacheData = {}) {
    const r = initial as Partial<CacheData>;
    this.data = r.v === 2 ? migrate(initial) : { v: 2, entries: { ...(initial as Record<string, CacheEntry>) }, candidates: {} };
  }
  protected apply<R>(op: Op<R>): R {
    return op(this.data);
  }
  get(key: string): CacheEntry | undefined {
    return Object.hasOwn(this.data.entries, key) ? this.data.entries[key] : undefined;
  }
  getCandidate(key: string): CacheEntry | undefined {
    return Object.hasOwn(this.data.candidates, key) ? this.data.candidates[key] : undefined;
  }
  set(key: string, entry: CacheEntry): void {
    this.apply(ops.set(key, entry));
  }
  propose(key: string, entry: CacheEntry): ProposeResult {
    return this.apply(ops.propose(key, entry));
  }
  touch(key: string, at: string): void {
    this.apply(ops.touch(key, at));
  }
  delete(key: string): void {
    this.apply(ops.delete(key));
  }
  keys(): string[] {
    return Object.keys(this.data.entries);
  }
  candidateKeys(): string[] {
    return Object.keys(this.data.candidates);
  }
}

/** 文件缓存：每次写都「加锁 → 重读 → 合并本次改动 → pid 临时文件 + rename」，并发进程互不覆盖 */
export class FileCache extends MemoryCache {
  private readonly path: string;
  constructor(path: string) {
    super();
    this.path = path;
    this.data = migrate(readJsonSync<unknown>(path, null));
  }
  protected override apply<R>(op: Op<R>): R {
    try {
      const { result, data } = updateJsonSync<unknown, R>(this.path, () => null, (cur) => {
        const d = migrate(cur);
        const result = op(d);
        return { data: d, result };
      });
      this.data = migrate(data);
      return result;
    } catch (e) {
      // 缓存是锦上添花：锁超时就只改内存、不写盘，绝不阻塞或拖垮这次指令
      if (e instanceof LockTimeoutError) {
        process.stderr.write(`[va] 缓存写入跳过：${e.message}\n`);
        return op(this.data);
      }
      throw e;
    }
  }
}
