import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, cleanUrl, mergeHit, preferUrl, processLine, readLinesFrom, scrubText, extractUrlsFromText } from '../src/indexer.ts';
import { runIndex } from '../src/index-run.ts';
import type { SavedItem } from '../src/indexer.ts';

test('cleanUrl：密钥参数去掉整串并标记需鉴权；user:pass 与 sk- 整条不收', () => {
  assert.deepEqual(cleanUrl('http://127.0.0.1:8787/?token=abc123&x=1'), { url: 'http://127.0.0.1:8787', needsAuth: true });
  assert.equal(cleanUrl('https://e.tb.cn/h.x?tk=SECRET')?.needsAuth, true);
  assert.equal(cleanUrl('https://e.tb.cn/h.x?tk=SECRET')?.url.includes('SECRET'), false);
  assert.equal(cleanUrl('https://a.com/x?k=1')?.url, 'https://a.com/x');
  assert.equal(cleanUrl('https://user:pw@a.com/'), null);
  assert.equal(cleanUrl('https://a.com/sk-abcdefghijkl'), null);
  assert.equal(cleanUrl('https://a.com/page?id=3')?.needsAuth, false);
});

test('classify：降噪（API、文档站、github 根与搜索、raw）', () => {
  assert.equal(classify('https://api.deepseek.com/models'), null);
  assert.equal(classify('https://example.org/v1/chat'), null);
  assert.equal(classify('https://raw.githubusercontent.com/a/b/c'), null);
  assert.equal(classify('https://docs.anthropic.com/x'), null);
  assert.equal(classify('https://github.com'), null);
  assert.equal(classify('https://github.com/search?q=x'), null);
  assert.equal(classify('https://github.com/octo/demo-repo')?.kind, 'web');
  assert.equal(classify('https://claude.ai/chat/123'), null, 'claude.ai 只收 artifact');
  assert.equal(classify('https://claude.ai/artifact/B6DMcSVZiYk69VEtYTpAkn')?.key, 'artifact:B6DMcSVZiYk69VEtYTpAkn');
  assert.equal(classify('https://claude.ai/code/artifact/ce30bcd2-1691-4aa7-a392-f14dcd2f3ec5')?.kind, 'artifact');
});

test('去重：127.0.0.1 / 100.64.0.7 / localhost 同端口合并为一条，打开优先 127.0.0.1', () => {
  const a = classify('http://100.64.0.7:8787');
  const b = classify('http://127.0.0.1:8787/');
  const c = classify('http://localhost:8787');
  assert.ok(a && b && c);
  assert.equal(a.key, b.key);
  assert.equal(b.key, c.key);
  const items = new Map<string, SavedItem>();
  mergeHit(items, { ...a, context: '手机', ts: '2026-09-01T00:00:00Z' });
  mergeHit(items, { ...b, context: '本机', ts: '2026-09-02T00:00:00Z' });
  const it = [...items.values()][0];
  assert.equal(items.size, 1);
  assert.equal(it.count, 2);
  assert.equal(it.url, 'http://127.0.0.1:8787');
  assert.equal(it.lastSeen, '2026-09-02T00:00:00Z');
  assert.equal(preferUrl(['http://100.64.0.7:9000/x'], ['100.64.0.7']), 'http://127.0.0.1:9000/x', 'config.self_hosts 里的本机地址改走 127.0.0.1');
  assert.equal(preferUrl(['http://100.64.0.9:9000/x'], ['100.64.0.7']), 'http://100.64.0.9:9000/x', '别的机器的 Tailscale 地址不改写');
});

test('scrubText：上下文里的密钥样式片段被抹掉', () => {
  const s = scrubText('key=abcdef token: zzz sk-1234567890abc 正常文字 task-board');
  assert.doesNotMatch(s, /k=|token=|key=|sk-/);
  assert.match(s, /正常文字/);
});

test('extractUrlsFromText：markdown 链接文字 / 同行前缀当标题，带上下文', () => {
  const hits = extractUrlsFromText('看板做好了：\n- 本机：http://127.0.0.1:8787\n- [Nova 项目全景](https://claude.ai/artifact/P8WUx2jC8eCTKn47B9yHk2)', 't');
  assert.equal(hits.length, 2);
  assert.equal(hits[0].title, '本机');
  assert.equal(hits[1].title, 'Nova 项目全景');
  assert.match(hits[0].context, /看板/);
});

test('processLine：Artifact 发布结果 + Read 到的 <title> + SendUserFile', () => {
  const st = { toolInputs: new Map() };
  processLine(JSON.stringify({ type: 'assistant', timestamp: 't1', message: { content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/tmp/x/index.html' } }] } }), st);
  const r1 = processLine(JSON.stringify({ type: 'user', timestamp: 't1', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: '3\t<title>期权作战手册</title>' }] } }), st);
  assert.deepEqual(r1.titles, [['/tmp/x/index.html', '期权作战手册']]);
  processLine(JSON.stringify({ type: 'assistant', timestamp: 't2', message: { content: [{ type: 'tool_use', id: 'a1', name: 'Artifact', input: { file_path: '/tmp/x/index.html', description: '九章期权教学' } }] } }), st);
  const r2 = processLine(JSON.stringify({ type: 'user', timestamp: 't2', message: { content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'Published /tmp/x/index.html at https://claude.ai/artifact/B6DMcSVZiYk69VEtYTpAkn (Version 1)' }] } }), st);
  assert.equal(r2.hits[0].kind, 'artifact');
  assert.equal(r2.hits[0].sourcePath, '/tmp/x/index.html');
  assert.match(r2.hits[0].context, /九章/);
  const r3 = processLine(JSON.stringify({ type: 'assistant', timestamp: 't3', message: { content: [{ type: 'tool_use', id: 's1', name: 'SendUserFile', input: { files: ['/tmp/a.mp4'], caption: '讲解视频' } }] } }), st);
  assert.deepEqual(r3.files.map((f) => f.path), ['/tmp/a.mp4']);
});

test('readLinesFrom：只读 offset 之后；末行没写完不推进 offset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'va-'));
  const f = join(dir, 'a.jsonl');
  writeFileSync(f, 'line1\nline2\npartial');
  const seen: string[] = [];
  const off = await readLinesFrom(f, 0, (l) => seen.push(l));
  assert.deepEqual(seen, ['line1', 'line2']);
  assert.equal(off, 12);
  appendFileSync(f, '-done\nline4\n');
  const seen2: string[] = [];
  const off2 = await readLinesFrom(f, off, (l) => seen2.push(l));
  assert.deepEqual(seen2, ['partial-done', 'line4']);
  assert.equal(off2, readFileSync(f).length);
});

test('runIndex 增量：第二次只读新追加的字节；文件被替换（inode 变）从头重读', async () => {
  const root = mkdtempSync(join(tmpdir(), 'va-idx-'));
  const proj = join(root, 'projects', 'p');
  mkdirSync(join(proj, 'sub', 'subagents'), { recursive: true });
  const f = join(proj, 's.jsonl');
  const line = (t: string) => `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-01T00:00:00Z', message: { content: [{ type: 'text', text: t }] } })}\n`;
  writeFileSync(f, line('库存看板：http://127.0.0.1:65530'));
  writeFileSync(join(proj, 'sub', 'subagents', 'agent.jsonl'), line('[项目全景](https://claude.ai/artifact/AAAAAAAAAAAAAAAAAAAAAA)'));
  const paths = { projectsDir: join(root, 'projects'), indexDir: join(root, 'index') };
  const s1 = await runIndex(paths, { fetchTitles: false });
  assert.ok(s1);
  assert.equal(s1.items, 2);
  const firstBytes = s1.newBytes;
  const add = line('新的 https://news.example-site.cn/a');
  appendFileSync(f, add);
  const s2 = await runIndex(paths, { fetchTitles: false });
  assert.ok(s2);
  assert.equal(s2.changedFiles, 1);
  assert.equal(s2.newBytes, Buffer.byteLength(add), '只读追加部分');
  assert.equal(s2.items, 3);
  const s3 = await runIndex(paths, { fetchTitles: false });
  assert.equal(s3?.newBytes, 0);
  // 替换文件（新 inode，内容更短）→ 从头读
  const tmp = `${f}.new`;
  writeFileSync(tmp, line('换了 http://127.0.0.1:65531'));
  (await import('node:fs')).renameSync(tmp, f);
  const s4 = await runIndex(paths, { fetchTitles: false });
  assert.ok(s4 && s4.newBytes > 0 && s4.newBytes < firstBytes + Buffer.byteLength(add));
  const items = JSON.parse(readFileSync(join(paths.indexDir, 'items.json'), 'utf8')) as SavedItem[];
  assert.ok(items.some((i) => i.url === 'http://127.0.0.1:65531'));
  const mode = (await import('node:fs')).statSync(join(paths.indexDir, 'items.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('computeSessionKeywords：同会话时间相近的标题 + 上下文提到的项目目录下文档标题', async () => {
  const { computeSessionKeywords } = await import('../src/index-run.ts');
  const mk = (p: Partial<SavedItem> & { key: string; url: string; title: string; kind: SavedItem['kind'] }): SavedItem => ({
    variants: [p.url], titleSource: 'context', contexts: [], count: 1, firstSeen: '2026-10-01T10:00:00Z', lastSeen: '2026-10-01T10:00:00Z', ...p,
  });
  const all = [
    mk({ key: 'w', kind: 'web', url: 'https://d2.vercel.app', title: 'Demo', sessions: ['S'], contexts: ['已部署 home tester dev revenue-explore d2-local demo api'] }),
    mk({ key: 'f', kind: 'file', url: '/home/tester/dev/revenue-explore/d2-local/launch/quote.html', title: '门店预约与 AI 客服 · 价目', titleSource: 'html', sessions: ['T'], firstSeen: '2026-10-05T00:00:00Z' }),
    mk({ key: 'n', kind: 'web', url: 'https://near.cn', title: '附近的小店', sessions: ['S'], firstSeen: '2026-10-01T11:00:00Z' }),
    mk({ key: 'far', kind: 'web', url: 'https://far.cn', title: '很久以前的', sessions: ['S'], firstSeen: '2026-09-01T00:00:00Z' }),
  ];
  computeSessionKeywords(all);
  const w = all[0].sessionKeywords ?? '';
  assert.match(w, /门店预约/, '项目目录关联');
  assert.match(w, /附近的小店/, '同会话 3 小时内');
  assert.doesNotMatch(w, /很久以前/, '超出时间窗不算');
});

test('sessionIdOf：子代理文件归到主会话', async () => {
  const { sessionIdOf } = await import('../src/indexer.ts');
  assert.equal(sessionIdOf('/p/-home-tester/abc.jsonl'), 'abc');
  assert.equal(sessionIdOf('/p/-home-tester/abc/subagents/agent-1.jsonl'), 'abc');
});
