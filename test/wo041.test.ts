// WO-20261002-041: index title clean-up, service noise, first-run groups and sample, indexStatus groups, sample RPC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, extractUrlsFromText } from '../src/indexer.ts';
import type { SavedItem } from '../src/indexer.ts';
import { githubName, groupCounts, groupOf, isCleanTitle, isGenericTitle, isServiceNoise, nameFromContext, pickSample, refineTitle, trunk } from '../src/title-quality.ts';
import { searchSaved } from '../src/saved.ts';
import { IndexService } from '../src/index-service.ts';
import { runIndex } from '../src/index-run.ts';

const item = (o: Partial<SavedItem>): SavedItem => ({
  key: o.key ?? `web:${o.url}`, kind: 'web', url: 'https://a.example.net/x', variants: [], title: '', titleSource: 'context', contexts: [], count: 1,
  firstSeen: '2026-10-01T00:00:00Z', lastSeen: '2026-10-01T00:00:00Z', ...o,
});

test('本机代理、调试端口、模型 API、API 路径不收录；真服务照收', () => {
  for (const u of ['http://127.0.0.1:7890', 'http://127.0.0.1:7897', 'http://127.0.0.1:17891', 'http://127.0.0.1:9222/json/version',
    'http://localhost:11434/v1', 'http://127.0.0.1:9097/proxies', 'http://127.0.0.1:1', 'http://127.0.0.1:54321/functions/v1/persona-preview']) {
    assert.equal(classify(u), null, u);
  }
  assert.equal(classify('http://127.0.0.1:8787')?.kind, 'local');
  assert.equal(classify('http://localhost:5173')?.kind, 'local');
  assert.equal(isServiceNoise(new URL('http://127.0.0.1:3000/')), false);
});

test('全角括号结束 URL：PR 链接后面的「（OPEN」不再被吃进地址', () => {
  const hits = extractUrlsFromText('PR https://github.com/o/r/pull/628（OPEN）', '2026-10-01T00:00:00Z');
  assert.equal(hits[0].url, 'https://github.com/o/r/pull/628');
});

test('泛称标题识别', () => {
  for (const t of ['PR', 'link', 'URL', '来源', '链接', '打开 👉', '（来源', 'Source', '原文', '.md', 'default(', '仓库', '源']) assert.equal(isGenericTitle(t), true, t);
  for (const t of ['库存看板', 'PR #602', '期权作战手册', 'Sesame 原型']) assert.equal(isGenericTitle(t), false, t);
});

test('泛称标题补全：GitHub 用仓库 + 编号，网页用标签前的那段名字，补不了标 weak', () => {
  assert.equal(githubName('https://github.com/acme/web-app/pull/628'), 'web-app PR #628');
  assert.deepEqual(refineTitle(item({ url: 'https://github.com/acme/web-app/pull/628', title: 'PR' })), { title: 'web-app PR #628', weak: false });
  assert.deepEqual(refineTitle(item({ url: 'https://github.com/acme/web-app/issues/9', title: '' })), { title: 'web-app issue #9', weak: false });
  const blog = refineTitle(item({ title: 'link', contexts: ['Kerros The Matrioshka Fee Machine Behind the Capital 2026-05-13 · link cool stuff'] }));
  assert.equal(blog.title, 'Matrioshka Fee Machine Behind the Capital');
  assert.equal(nameFromContext(['abc 来源 xyz'], '来源'), null, '标签前没有像名字的片段');
  assert.deepEqual(refineTitle(item({ title: '来源', contexts: ['x 来源'] })), { title: '', weak: true });
  assert.deepEqual(refineTitle(item({ kind: 'file', url: '/tmp/a/report-2026.md', title: '.md' })), { title: 'report-2026.md', weak: false });
});

test('整句当标题：截取主干', () => {
  assert.equal(trunk('做了什么 ：PR #602'), 'PR #602');
  assert.equal(trunk('开 PR + 挂 automerge ：✅'), '开 PR + 挂 automerge');
  assert.equal(trunk('另外：外网入口是 Tailscale Funnel'), '外网入口是 Tailscale Funnel');
  assert.equal(trunk('品牌片 v2（新三幕叙事，42 秒，后 15 秒留真机录屏，暂无配音）'), '品牌片 v2');
  assert.equal(trunk('Sesame 高保真预览：缓存命中（'), 'Sesame 高保真预览');
  assert.equal(trunk('通过微信认证验证主体身份，需支付300元认证费'), '通过微信认证验证主体身份');
  assert.equal(trunk('库存看板'), '库存看板');
  assert.equal(trunk('「我的」页修前/修后对比：真机'), '「我的」页修前/修后对比');
  assert.equal(trunk('我的」页修前/修后对比'), '我的页修前/修后对比');
  // idempotent
  const once = refineTitle(item({ title: '品牌片 v2（新三幕叙事，42 秒）' }));
  assert.equal(once.full, '品牌片 v2（新三幕叙事，42 秒）', '原句留给检索用');
  assert.equal(refineTitle(item({ title: once.title })).title, once.title);
  assert.equal(refineTitle(item({ title: once.title })).full, undefined);
});

test('页面自己的 <title> 不截（30 字以内）', () => {
  assert.equal(refineTitle(item({ title: 'Inventory Dashboard · GPU 用量', titleSource: 'html' })).title, 'Inventory Dashboard · GPU 用量');
});

test('weak 标题在检索里降权：同样对得上，正常标题排前', () => {
  const a = item({ key: 'a', title: '', weakTitle: true, contexts: ['交易大盘 链接'], count: 3 });
  const b = item({ key: 'b', title: '', contexts: ['交易大盘 链接'], count: 3 });
  const r = searchSaved('交易大盘', [a, b], {}, new Date('2026-10-02T00:00:00Z'));
  assert.equal(r[0].item.key, 'b');
});

test('开场分组：每条只进一组，六组之和 = 总数', () => {
  const items = [
    item({ url: 'https://github.com/o/r/pull/1', title: 'r PR #1' }),
    item({ kind: 'local', url: 'http://127.0.0.1:8787', title: '库存看板' }),
    item({ kind: 'artifact', url: 'https://claude.ai/artifact/abcdefgh', title: '交易大盘' }),
    item({ kind: 'file', url: '/home/u/Documents/x/周报.md', title: '周报.md' }),
    item({ kind: 'file', url: '/home/u/Documents/x/deck.pptx', title: 'deck.pptx' }),
    item({ title: '门店官网' }),
    item({ kind: 'file', url: '/home/u/Documents/x/a.png', title: 'a.png' }),
  ];
  assert.deepEqual(items.map(groupOf), ['pr', 'dashboard', 'dashboard', 'report', 'deck', 'site', 'file']);
  const g = groupCounts(items);
  // only what the AI made counts: the PR without "opened / pushed" words and the plain web page are left out
  assert.equal(Object.values(g).reduce((a, b) => a + b, 0), items.length - 2);
  assert.equal(g.pr, 0);
  assert.equal(g.site, 0);
});

test('开场示例：7 天内、标题干净、像看板/报告/页面；挑不到返回 null', () => {
  const now = new Date('2026-10-02T12:00:00Z');
  const recent = '2026-10-01T10:00:00Z';
  const old = '2026-09-10T10:00:00Z';
  const pick = pickSample([
    item({ key: 'old', kind: 'artifact', title: '交易大盘', lastSeen: old }),
    item({ key: 'dirty', kind: 'artifact', title: 'WO-029 返工：参考', lastSeen: recent }),
    item({ key: 'port', kind: 'local', title: 'localhost:7341', lastSeen: recent }),
    item({ key: 'good', kind: 'local', title: '库存看板', lastSeen: recent, count: 5 }),
    item({ key: 'web', kind: 'web', title: '门店官网', lastSeen: recent }),
  ], now);
  assert.equal(pick?.key, 'good');
  assert.equal(pickSample([item({ key: 'x', title: 'Telecoms crash', lastSeen: recent })], now), null, '普通网页、不像看板/报告 → 不出示例');
  assert.equal(pickSample([], now), null);
  assert.equal(isCleanTitle('库存看板'), true);
  assert.equal(isCleanTitle('feedback_side_tasks.md'), false);
});

test('indexStatus 带 groups；sample 走 RPC', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wo041-'));
  writeFileSync(join(dir, 'items.json'), JSON.stringify([
    item({ url: 'https://github.com/o/r/pull/1', title: 'r PR #1', contexts: ['已开 PR 挂 automerge'] }),
    item({ kind: 'local', url: 'http://127.0.0.1:8787', title: '库存看板', lastSeen: new Date().toISOString() }),
    item({ url: 'https://news.example.net/a', title: '某条新闻' }),
  ]));
  const svc = new IndexService({ root: process.cwd(), indexDir: dir });
  const st = svc.status();
  assert.equal(st.items, 3);
  assert.equal(st.made, 2, '新闻只是被提到，不算 AI 做的');
  assert.deepEqual(st.groups, { dashboard: 1, report: 0, deck: 0, site: 0, pr: 1, file: 0 });

  const { dispatch } = await import('../src/rpc.ts');
  const { fileStore } = await import('../src/saved.ts');
  const deps = { root: process.cwd(), home: dir, run: async () => ({ code: 0, stdout: '', stderr: '' }), write: () => {},
    runtime: async () => ({ ctx: { saved: fileStore(dir) } }) } as unknown as Parameters<typeof dispatch>[1];
  const r = await dispatch({ jsonrpc: '2.0', id: 1, method: 'sample' }, deps) as { result: { sample: { title: string; url: string } | null } };
  assert.equal(r.result.sample?.title, '库存看板');
  assert.equal(r.result.sample?.url, 'http://127.0.0.1:8787');
});

test('增量索引也会清掉旧索引里的代理端口、补全泛称标题', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wo041-run-'));
  const proj = mkdtempSync(join(tmpdir(), 'wo041-proj-'));
  writeFileSync(join(dir, 'items.json'), JSON.stringify([
    item({ key: 'local:host:7890', kind: 'local', url: 'http://127.0.0.1:7890', title: '本机 HTTP PROXY' }),
    item({ key: 'web:github.com/o/r/pull/5', url: 'https://github.com/o/r/pull/5', title: 'PR' }),
  ]));
  const s = await runIndex({ indexDir: dir, projectsDir: proj }, { fetchTitles: false });
  assert.equal(s?.items, 1);
  const { readFileSync } = await import('node:fs');
  const out = JSON.parse(readFileSync(join(dir, 'items.json'), 'utf8')) as SavedItem[];
  assert.equal(out[0].title, 'r PR #5');
});

test('旧索引里带「（OPEN」尾巴的 PR 地址：截掉并并入干净的那条', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wo041-fw-'));
  const proj = mkdtempSync(join(tmpdir(), 'wo041-fwp-'));
  writeFileSync(join(dir, 'items.json'), JSON.stringify([
    item({ key: 'web:github.com/o/r/pull/7', url: 'https://github.com/o/r/pull/7', title: 'PR', count: 2 }),
    item({ key: 'web:github.com/o/r/pull/7%EF%BC%88OPEN', url: 'https://github.com/o/r/pull/7%EF%BC%88OPEN', title: 'PR', count: 3 }),
    item({ key: 'web:github.com/o/r/pull/8%EF%BC%88', url: 'https://github.com/o/r/pull/8%EF%BC%88', title: 'PR', count: 1 }),
  ]));
  await runIndex({ indexDir: dir, projectsDir: proj }, { fetchTitles: false });
  const { readFileSync } = await import('node:fs');
  const out = (JSON.parse(readFileSync(join(dir, 'items.json'), 'utf8')) as SavedItem[]).sort((a, b) => a.url.localeCompare(b.url));
  assert.deepEqual(out.map((i) => [i.url, i.count, i.title]), [['https://github.com/o/r/pull/7', 5, 'r PR #7'], ['https://github.com/o/r/pull/8', 1, 'r PR #8']]);
});

test('截短的标题：原句仍参与检索（「原型」只在原句里）', () => {
  const a = item({ key: 'a', kind: 'file', url: '/tmp/p.html', title: 'Sesame 高保真预览', fullTitle: 'Sesame 高保真预览：缓存命中、候选列表，最后是可交互原型' });
  const r = searchSaved('Sesame 原型', [a], {}, new Date('2026-10-02T00:00:00Z'));
  assert.equal(r[0]?.item.key, 'a');
});

test('边打字边出结果：只留名字里对得上的；一两个字也能在标题里找到；同名只出一行；对不上返回空（界面显示回退行）', async () => {
  const { searchLive } = await import('../src/saved.ts');
  const now = new Date('2026-10-02T00:00:00Z');
  const items = [
    item({ key: 'a', kind: 'local', url: 'http://127.0.0.1:7341', title: '交易大盘', count: 4 }),
    item({ key: 'a2', kind: 'file', url: '/tmp/交易大盘.html', title: '交易大盘' }),
    item({ key: 'b', kind: 'artifact', url: 'https://claude.ai/artifact/abcdefgh1', title: '年度大事记' }),
    item({ key: 'c', title: '品牌片 v2', contexts: ['交易 大盘 v2 讨论'] }),
  ];
  assert.deepEqual(searchLive('大', items, {}, now).map((c) => c.item.key).sort(), ['a', 'b']);
  assert.deepEqual(searchLive('交易大', items, {}, now).map((c) => c.item.key), ['a']);
  assert.deepEqual(searchLive('交易大盘 v2', items, {}, now).map((c) => c.item.key), ['a'], '「交易大盘」占了一半以上');
  assert.deepEqual(searchLive('汇率换算 v9', items, {}, now), []);
});

test('AI 做的 vs 只是提到的：服务/页面/文件算；PR 要有开了/推了的字样；部署站要有部署字样；新闻文档不算', async () => {
  const { madeByAI } = await import('../src/title-quality.ts');
  assert.equal(madeByAI(item({ kind: 'local', url: 'http://127.0.0.1:8787' })), true);
  assert.equal(madeByAI(item({ kind: 'artifact', url: 'https://claude.ai/artifact/abcdefgh1' })), true);
  assert.equal(madeByAI(item({ kind: 'file', url: '/tmp/a.md' })), true);
  assert.equal(madeByAI(item({ url: 'https://github.com/o/r/pull/9', contexts: ['已开 PR 挂 automerge'] })), true);
  assert.equal(madeByAI(item({ url: 'https://github.com/supabase/auth/pull/2365', contexts: ['源码结构直接决定的'] })), false);
  assert.equal(madeByAI(item({ url: 'https://demo-x.vercel.app', contexts: ['已部署到 vercel 预览'] })), true);
  assert.equal(madeByAI(item({ url: 'https://abc.feishu.cn/docx/KJop', contexts: ['文档已建好且验收通过'] })), true);
  assert.equal(madeByAI(item({ url: 'https://www.cnblogs.com/x/articles/1', contexts: ['注册企业账号必看'] })), false);
  assert.equal(madeByAI(item({ url: 'https://github.com/hardikpandya/stop-slop' })), false);
});

test('打字列表只给 AI 做的；说了「网页/链接/文章」才把外部网页放进来（放最后）', async () => {
  const { searchLive } = await import('../src/saved.ts');
  const now = new Date('2026-10-02T00:00:00Z');
  const items = [
    item({ key: 'dash', kind: 'local', url: 'http://127.0.0.1:8787', title: '库存看板', count: 1 }),
    item({ key: 'blog', url: 'https://www.cnblogs.com/a/1', title: '注册企业账号必看', count: 30 }),
    item({ key: 'news', url: 'https://news.example.net/b', title: '游民星空 看天下', count: 30 }),
  ];
  assert.deepEqual(searchLive('看', items, {}, now).map((c) => c.item.key), ['dash']);
  assert.deepEqual(searchLive('看 网页', items, {}, now).map((c) => c.item.key)[0], 'dash', '要网页时 AI 的仍在前');
  assert.ok(searchLive('看 网页', items, {}, now).some((c) => c.item.key === 'blog'));
  assert.deepEqual(searchLive('必看', items, {}, now), [], 'AI 的一条都没对上也不拿外部网页兜底（WO-20261003-040）');
  assert.deepEqual(searchLive('必看 网页', items, {}, now).map((c) => c.item.key), ['blog'], '明说要网页时才给');
});

test('标题去掉 @提及', async () => {
  const { stripMentions } = await import('../src/title-quality.ts');
  assert.equal(stripMentions('@张三 @李四 定价框架 v1 写好了'), '定价框架 v1 写好了');
  assert.equal(refineTitle(item({ title: '@张三 @李四 定价框架 v1 写好了' })).title, '定价框架 v1 写好了');
  assert.equal(stripMentions('邮箱 a@b.com 里的周报'), '邮箱 a@b.com 里的周报', '邮箱不是提及');
});

test('agent 的内部工作文件：能搜到，但不进开场计数和默认列表', async () => {
  const { isAgentWorkFile, isProduct, groupCounts: gc } = await import('../src/title-quality.ts');
  const { searchLive: live } = await import('../src/saved.ts');
  const home = '/home/someone';
  const f = (url: string) => item({ kind: 'file', url, title: url.split('/').pop()! });
  for (const u of ['/private/tmp/x/a.md', '/tmp/a.html', '/var/tmp/sp/scratchpad/WO-1/out.png', `${home}/.claude/projects/p/memory/x.md`,
    `${home}/.codex/briefs/a.md`, `${home}/dev/app/brief.md`, `${home}/dev/app/handoff-0928.md`, `${home}/dev/app/audit.md`, `${home}/dev/app/report.md`]) {
    assert.equal(isAgentWorkFile(f(u), home, '/var/folders/zz/T'), true, u);
  }
  for (const u of [`${home}/Desktop/报价单.pdf`, `${home}/dev/site/index.html`, `${home}/Documents/社区实践调研报告.md`]) {
    assert.equal(isAgentWorkFile(f(u), home, '/var/folders/zz/T'), false, u);
  }
  assert.equal(isProduct(f('/tmp/a.html')), false);
  const items = [f('/tmp/x/交易大盘.html'), item({ key: 'k', kind: 'local', url: 'http://127.0.0.1:7341', title: '交易大盘看板' })];
  assert.equal(Object.values(gc(items)).reduce((a, b) => a + b, 0), 1);
  const now = new Date('2026-10-02T00:00:00Z');
  assert.deepEqual(live('交易大盘', items, {}, now).map((c) => c.item.kind), ['local'], '默认列表不出工作文件');
  assert.equal(live('交易大盘', [items[0]], {}, now).length, 1, '只有它时仍能搜到');
  assert.equal(searchSaved('交易大盘', items, {}, now).length, 2, '完整流程照样能搜到');
});

test('--help / -h / help 单独出现：打印用法直接退出，不当一句话处理，va-index 也不建索引', async () => {
  const { isHelpArgs } = await import('../src/help.ts');
  for (const a of [['--help'], ['-h'], ['help'], ['HELP'], [' --help ']]) assert.equal(isHelpArgs(a), true, JSON.stringify(a));
  for (const a of [[], ['help', 'me'], ['打开', 'help'], ['--help', 'x'], ['帮助']]) assert.equal(isHelpArgs(a), false, JSON.stringify(a));
  const { spawnSync } = await import('node:child_process');
  const { existsSync, readdirSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'wo041-help-'));
  const env = { ...process.env, VA_CONFIG_DIR: join(dir, 'cfg'), VA_INDEX_DIR: join(dir, 'index'), VA_LOG_DIR: join(dir, 'logs'), VA_CACHE_FILE: join(dir, 'cache.json'), HOME: dir };
  for (const arg of ['--help', '-h', 'help']) {
    const r = spawnSync(join(process.cwd(), 'bin/va'), [arg], { env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 0, `va ${arg}: ${r.stderr}`);
    assert.match(r.stdout, /usage:/);
    const ri = spawnSync(join(process.cwd(), 'bin/va-index'), [arg], { env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(ri.status, 0, `va-index ${arg}: ${ri.stderr}`);
    assert.match(ri.stdout, /usage:\n {2}va-index/);
  }
  assert.equal(existsSync(join(dir, 'index', 'items.json')), false, 'va-index --help 没有建索引');
  assert.equal(existsSync(join(dir, 'logs')) ? readdirSync(join(dir, 'logs')).filter((f) => f.endsWith('.jsonl')).length : 0, 0, 'va --help 没有记成一次调用');
});
