import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grams, queryCore, searchSaved, obviousWinner, describeForModel, memoryStore, specificHits } from '../src/saved.ts';
import { openSaved, saveAlias } from '../src/tools.ts';
import type { SavedItem } from '../src/indexer.ts';
import type { ExecContext } from '../src/types.ts';

const item = (p: Partial<SavedItem> & { key: string; title: string; kind: SavedItem['kind']; url: string }): SavedItem => ({
  variants: [p.url], titleSource: 'html', contexts: [], count: 1, firstSeen: '2026-09-20T00:00:00Z', lastSeen: '2026-09-28T00:00:00Z', ...p,
});

const ITEMS: SavedItem[] = [
  item({ key: 'local:host:8787', kind: 'local', url: 'http://127.0.0.1:8787', title: '库存看板', contexts: ['手机 Tailscale 内 本机'], count: 14 }),
  item({ key: 'file:/x/dashboard/index.html', kind: 'file', url: '/x/dashboard/index.html', title: '库存看板' }),
  item({ key: 'artifact:B6DM', kind: 'artifact', url: 'https://claude.ai/artifact/B6DMcSVZiYk69VEtYTpAkn', title: '期权作战手册', count: 5 }),
  item({ key: 'file:/v.mp4', kind: 'file', url: '/v.mp4', title: '期权作战手册 · 讲解视频 11:46', titleSource: 'description' }),
  item({ key: 'artifact:P8W', kind: 'artifact', url: 'https://claude.ai/artifact/P8WUx2jC8eCTKn47B9yHk2', title: 'Nova 项目全景' }),
  item({ key: 'artifact:5ip', kind: 'artifact', url: 'https://claude.ai/artifact/5ipbDdGLGJ15icQcxrx6ed', title: '试听页', contexts: ['三角色 5候选音色'] }),
  item({ key: 'web:sina', kind: 'web', url: 'https://finance.sina.com.cn/x', title: '新浪财经-因子全景' }),
];

test('queryCore 去动词虚词；grams 中文 bigram + 英文整词', () => {
  assert.equal(queryCore('帮我打开那个库存看板！'), '库存看板');
  assert.deepEqual([...grams('Nova 项目全景')].sort(), ['nova', '全景', '目全', '项目'].sort());
});

test('检索：同名去重保留本机服务；精确标题胜过「标题包含」', () => {
  const c1 = searchSaved('打开库存看板', ITEMS, {});
  assert.equal(c1[0].item.url, 'http://127.0.0.1:8787');
  assert.ok(!c1.some((c) => c.item.kind === 'file' && c.item.title === '库存看板'), '同名文件被去重');
  const c2 = searchSaved('打开期权作战手册', ITEMS, {});
  assert.equal(c2[0].item.key, 'artifact:B6DM');
  assert.ok(c2[0].score > c2[1].score);
});

test('检索：近义词靠 bigram 部分重合进入候选（库存大盘 → 库存看板）', () => {
  const c = searchSaved('库存大盘', ITEMS, {});
  assert.ok(c.length > 0);
  assert.equal(c[0].item.key, 'local:host:8787');
});

test('检索：上下文关键词也参与（音色试听 → 试听页）', () => {
  const c = searchSaved('打开那个音色试听', ITEMS, {});
  assert.equal(c[0].item.key, 'artifact:5ip');
});

test('别名直达；obviousWinner 判定', () => {
  const c = searchSaved('大盘', ITEMS, { 大盘: 'local:host:8787' });
  assert.equal(c[0].aliasHit, true);
  assert.equal(obviousWinner(c)?.item.key, 'local:host:8787');
  assert.equal(obviousWinner(searchSaved('Nova 项目全景', ITEMS, {}))?.item.key, 'artifact:P8W');
});

test('发给模型的候选描述不含 URL', () => {
  const d = describeForModel([...searchSaved('库存看板', ITEMS, {}), { item: item({ key: 'f', kind: 'file', url: '/a/b.png', title: '截图 · 下打开 http://100.64.0.7:8787', contexts: ['见 /home/tester/x/y.png'] }), score: 1, aliasHit: false }]);
  assert.doesNotMatch(d, /https?:|127\.0\.0\.1|\//);
});

function ctxWith(store: ReturnType<typeof memoryStore>, extra: Partial<ExecContext> = {}) {
  const ran: Array<{ cmd: string; args: string[] }> = [];
  const printed: string[] = [];
  const ctx: ExecContext = {
    dryRun: false, print: (l) => printed.push(l), confirm: async () => false, home: '/h', now: () => new Date('2026-10-01T00:00:00Z'),
    run: async (cmd, args) => { ran.push({ cmd, args }); return { code: 0, stdout: '', stderr: '' }; },
    saved: store, ...extra,
  };
  return { ctx, ran, printed };
}

test('openSaved：模型挑选 → 打开对应 URL，并记住「刚才那个」；把它记成别名', async () => {
  const store = memoryStore([
    ...ITEMS,
    item({ key: 'artifact:ys1', kind: 'artifact', url: 'https://claude.ai/artifact/YS1YS1YS1YS1', title: '预算看板 甲' }),
    item({ key: 'artifact:ys2', kind: 'artifact', url: 'https://claude.ai/artifact/YS2YS2YS2YS2', title: '预算看板 乙' }),
  ]);
  let seenCands = '';
  const { ctx, ran } = ctxWith(store, { pick: async (_q, c) => { seenCands = c; return { index: 1, usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 } }; } });
  const r = await openSaved('预算看板', ctx);
  assert.equal(r.ok, true);
  assert.equal(ran[0].cmd, 'open');
  assert.equal(r.usage?.total_tokens, 101, '模型挑选的 token 计入');
  assert.doesNotMatch(seenCands, /127\.0\.0\.1/);
  const a = await saveAlias('大盘', '', ctx);
  assert.equal(a.ok, true);
  assert.equal(store._aliases['大盘'], (r.data as { key: string }).key);
});

test('openSaved：模型分不清 → 弹列表让用户选；都没有 → 失败提示', async () => {
  const store = memoryStore(ITEMS);
  const { ctx, ran } = ctxWith(store, { pick: async () => ({ index: 0 }), choose: async (_p, opts) => opts.findIndex((o) => o.includes('讲解视频')) });
  const r = await openSaved('作战手册', ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(ran[0].args, ['/v.mp4']);
  const none = await openSaved('完全不存在的产物xyz', ctxWith(memoryStore(ITEMS)).ctx);
  assert.equal(none.ok, false);
});

test('openSaved：没命中先按需刷新索引再查一次', async () => {
  const items: SavedItem[] = [];
  const store = memoryStore(items);
  let refreshed = 0;
  const { ctx, ran } = ctxWith(store, {
    refreshSaved: async () => { refreshed += 1; items.push(item({ key: 'artifact:new', kind: 'artifact', url: 'https://claude.ai/artifact/NEWNEWNEWNEW', title: '刚发的周报' })); return true; },
  });
  const r = await openSaved('刚发的周报', ctx);
  assert.equal(refreshed, 1);
  assert.equal(r.ok, true);
  assert.deepEqual(ran[0].args, ['https://claude.ai/artifact/NEWNEWNEWNEW']);
});

test('听写错字 + 官网：泛词降权，具体词（门店）命中的网站排第一；模型说都不像时仍弹列表让用户选', async () => {
  const items: SavedItem[] = [
    item({ key: 'web:prod', kind: 'web', url: 'https://nova.example.cn', title: '09-07 助手 官网已上生产', count: 96 }),
    item({ key: 'web:dxyz', kind: 'web', url: 'https://destiny.example.com', title: 'Destiny Tech100 官网', count: 3 }),
    item({ key: 'web:d2', kind: 'web', url: 'https://d2-shop-booking-demo.vercel.app', title: 'Demo', count: 11, sessionKeywords: '小店小程序 · 门店页、预约、AI 客服 示例公司 · 门店预约与 AI 客服 · 价目' }),
    item({ key: 'file:start', kind: 'file', url: '/x/d2-local/demo/public/start/index.html', title: '小店小程序 · 门店页、预约、AI 客服' }),
  ];
  const c = searchSaved('门店夜的官网', items, {});
  assert.equal(c[0].item.key, 'web:d2', '官网请求 + 门店具体词 → 网站排第一，文件靠后');
  const store = memoryStore(items);
  let offered: string[] = [];
  const { ctx, ran } = ctxWith(store, { pick: async () => ({ index: -1 }), choose: async (_p, opts) => { offered = opts; return 0; } });
  const r = await openSaved('门店夜的官网', ctx);
  assert.equal(r.ok, true);
  assert.ok(offered.length >= 1 && offered.every((o) => /门店|Demo/.test(o)), '只列出具体词对得上的候选');
  assert.match(offered[0], /d2-shop-booking-demo\.vercel\.app/, '列表里带域名方便辨认');
  assert.deepEqual(ran[0].args, ['https://d2-shop-booking-demo.vercel.app']);
});

test('specificHits：只靠泛词（官网）对上的候选不算', () => {
  const items: SavedItem[] = [item({ key: 'web:prod', kind: 'web', url: 'https://a.cn', title: '官网已上生产' })];
  assert.equal(specificHits('门店夜的官网', searchSaved('门店夜的官网', items, {})).length, 0);
});

test('obviousWinner：标题与查询完全一致且唯一 → 直接打开', () => {
  const c = searchSaved('期权作战手册', ITEMS, {});
  assert.equal(obviousWinner(c, queryCore('期权作战手册'))?.item.key, 'artifact:B6DM');
});
