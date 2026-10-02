/** 并发测试用子进程：node concurrent-writer.ts <cache|alias> <file/dir> <id> —— 等到 <startAt> 毫秒时间戳同时开写 */
import { FileCache } from '../../src/cache.ts';
import { fileStore } from '../../src/saved.ts';

const [mode, target, id, startAt] = process.argv.slice(2);
const wait = Number(startAt) - Date.now();
if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
if (mode === 'cache') {
  const c = new FileCache(target);
  c.set(`key-${id}`, { sample: `句子${id}`, actions: [{ name: 'open_app', args: { name: `App${id}` } }], createdAt: new Date().toISOString(), hits: 0, toolsVersion: 't' });
  // 再来一次 propose + touch，制造更多交错写
  c.propose(`cand-${id}`, { sample: `候选${id}`, actions: [{ name: 'open_app', args: { name: `C${id}` } }], createdAt: '', hits: 0, toolsVersion: 't' });
  c.touch(`key-${id}`, new Date().toISOString());
} else {
  fileStore(target).setAlias(`别名${id}`, `web:k${id}`);
}
