import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileCache, migrate } from '../src/cache.ts';
import type { CacheData } from '../src/cache.ts';
import { withFileLockSync, LockTimeoutError } from '../src/fsutil.ts';

const WRITER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'concurrent-writer.ts');

function runWriters(mode: string, target: string, n: number): Promise<number[]> {
  const startAt = Date.now() + 600; // 等所有进程都起来再同时开写
  return Promise.all(Array.from({ length: n }, (_, i) => new Promise<number>((res) => {
    const p = spawn(process.execPath, ['--no-warnings', WRITER, mode, target, String(i), String(startAt)], { stdio: ['ignore', 'ignore', 'inherit'] });
    p.on('exit', (code) => res(code ?? -1));
  })));
}

test('并发：10 个进程同时写同一个 cache.json，条目一条不丢、候选一条不丢、hits 都记上', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'va-cc-'));
  const path = join(dir, 'cache.json');
  const codes = await runWriters('cache', path, 10);
  assert.deepEqual(codes, Array(10).fill(0));
  const d = JSON.parse(readFileSync(path, 'utf8')) as CacheData;
  assert.equal(d.v, 2);
  assert.equal(Object.keys(d.entries).length, 10, `entries: ${Object.keys(d.entries).join(',')}`);
  assert.equal(Object.keys(d.candidates).length, 10);
  for (let i = 0; i < 10; i++) assert.equal(d.entries[`key-${i}`]?.hits, 1);
  assert.deepEqual(readdirSync(dir).filter((f) => f !== 'cache.json'), [], '不留 .tmp / .lock');
});

test('并发：10 个进程同时 setAlias，aliases.json 10 个别名都在', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'va-al-'));
  const codes = await runWriters('alias', dir, 10);
  assert.deepEqual(codes, Array(10).fill(0));
  const a = JSON.parse(readFileSync(join(dir, 'aliases.json'), 'utf8')) as Record<string, string>;
  assert.equal(Object.keys(a).length, 10);
});

test('FileCache：写入前重读——另一个实例在中间写过的条目不会被覆盖掉', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'va-rr-')), 'cache.json');
  const a = new FileCache(path);
  const b = new FileCache(path); // b 加载时文件还是空的
  a.set('甲', { sample: '甲', actions: [], createdAt: '', hits: 0, toolsVersion: 't' });
  b.set('乙', { sample: '乙', actions: [], createdAt: '', hits: 0, toolsVersion: 't' });
  const d = JSON.parse(readFileSync(path, 'utf8')) as CacheData;
  assert.deepEqual(Object.keys(d.entries).sort(), ['乙', '甲']);
});

test('旧缓存迁移：v1 条目（无工具表版本号）整体作废；v2 里的测试句（测试autoenter916）读时剔除', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'va-mg-')), 'cache.json');
  writeFileSync(path, JSON.stringify({
    打开飞书: { sample: '打开飞书', actions: [{ name: 'open_app', args: { name: '飞书' } }], createdAt: '', hits: 3 },
    测试autoenter916: { sample: '测试 autoenter916', actions: [{ name: 'run_shell', args: { command_id: 'network_status' } }], createdAt: '', hits: 0 },
  }));
  const c = new FileCache(path);
  assert.equal(c.get('打开飞书'), undefined, 'v1 旧条目不能回放');
  assert.equal(c.getCandidate('打开飞书'), undefined);
  const e = { sample: 's', actions: [], createdAt: '', hits: 0, toolsVersion: 't' };
  const d = migrate({ v: 2, entries: { 打开飞书: e, 测试autoenter916: { ...e, sample: '测试 autoenter916' } }, candidates: { x: { ...e, sample: 'selftest' } } });
  assert.deepEqual(Object.keys(d.entries), ['打开飞书']);
  assert.deepEqual(d.candidates, {});
  assert.deepEqual(migrate(null), { v: 2, entries: {}, candidates: {} });
});

test('文件锁：持有者已死的悬空锁会被回收；活锁超时抛 LockTimeoutError', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'va-lk-')), 'x.json');
  writeFileSync(`${path}.lock`, '999999'); // 不存在的 pid
  assert.equal(withFileLockSync(path, () => 42), 42);
  writeFileSync(`${path}.lock`, String(process.pid)); // 自己（活着）
  assert.throws(() => withFileLockSync(path, () => 0, { timeoutMs: 100 }), LockTimeoutError);
});
