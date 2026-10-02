// WO-20261003-002: retrieval quality — nouns first, time words filter, title and context scored apart, no filler candidates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery } from '../src/query.ts';
import { decide, nameDate, searchSaved, shortlist } from '../src/saved.ts';
import { defaultConfig, parseConfig, setConfig } from '../src/config.ts';
import { handle } from '../src/router.ts';
import { MemoryCache } from '../src/cache.ts';
import { memoryStore } from '../src/saved.ts';
import type { SavedItem } from '../src/indexer.ts';
import type { ExecContext } from '../src/types.ts';

setConfig(defaultConfig('/x'));
const NOW = new Date(2026, 9, 3, 10, 0, 0); // 2026-10-03 10:00 local (Saturday)
const day = (d: number, h = 12) => new Date(2026, 9, d, h, 0, 0).toISOString();
const sep = (d: number, h = 12) => new Date(2026, 8, d, h, 0, 0).toISOString();

const item = (p: Partial<SavedItem> & { key: string; title: string; kind: SavedItem['kind']; url: string }): SavedItem => ({
  variants: [p.url], titleSource: 'html', contexts: [], count: 1, firstSeen: sep(20), lastSeen: sep(20), ...p,
});
const top = (q: string, items: SavedItem[]) => decide(searchSaved(q, items, {}, NOW))?.item.key ?? null;

test('parseQuery：功能词、时间词不算名词；类型词单独拿出来；同义词带上', () => {
  const p = parseQuery('打开上周那个交易大盘', NOW);
  assert.deepEqual(p.nouns.map((n) => n.text), ['交易']);
  assert.deepEqual(p.types, ['dashboard']);
  assert.equal(p.time?.word, '上周');
  assert.deepEqual(parseQuery('芝麻图标比稿', NOW).nouns.map((n) => n.text), ['芝麻', '图标', '比稿']);
  assert.ok(parseQuery('Sesame 原型', NOW).nouns.find((n) => n.text === '原型')?.alts.includes('prototype'));
  const r = parseQuery('昨天做的那个页面', NOW);
  assert.deepEqual([r.nouns.length, r.types, r.made], [0, ['page'], true]);
  assert.deepEqual(parseQuery('open the inventory dashboard', NOW).nouns.map((n) => n.text), ['inventory']);
});

test('名字里的日期比「什么时候出现」更可信：layer_2026-10-01 是 10-01 的，weekly_2026-W39 是 9-21 那一周', () => {
  const d = nameDate({ kind: 'file', url: '/r/layer_2026-10-01.md', title: 'layer_2026-10-01.md' });
  assert.equal(d?.from.getDate(), 1);
  const w = nameDate({ kind: 'file', url: '/r/weekly_2026-W39.md', title: 'weekly_2026-W39.md' });
  assert.deepEqual([w?.from.getMonth(), w?.from.getDate(), w?.to.getDate()], [8, 21, 28]);
  assert.equal(nameDate({ kind: 'file', url: '/r/notes.md', title: 'notes.md' }), null);
});

const REVIEWS = [
  // written at 23:40 the day before yesterday: its name says 10-01, so it is not "yesterday's"
  item({ key: 'f:layer', kind: 'file', url: '/home/u/work/reviews/layer_2026-10-01.md', title: 'layer_2026-10-01.md', firstSeen: day(1, 23), lastSeen: day(1, 23) }),
  item({ key: 'f:monthly', kind: 'file', url: '/home/u/work/reviews/thesis_monthly_2026-10.md', title: 'thesis_monthly_2026-10.md', firstSeen: day(2, 10), lastSeen: day(2, 10) }),
  item({ key: 'f:readme', kind: 'file', url: '/home/u/app/README.md', title: 'README.md', firstSeen: day(2, 16), lastSeen: day(2, 16) }),
  item({ key: 'f:w39', kind: 'file', url: '/home/u/work/reviews/weekly_2026-W39.md', title: 'weekly_2026-W39.md', firstSeen: sep(27), lastSeen: sep(27) }),
  item({ key: 'f:w38', kind: 'file', url: '/home/u/work/reviews/weekly_2026-W38.md', title: 'weekly_2026-W38.md', firstSeen: sep(20), lastSeen: sep(20) }),
  item({ key: 'web:news', kind: 'web', url: 'https://news.example.net/weekly', title: '时代周报 2025-08-19', count: 3, firstSeen: sep(25), lastSeen: sep(25) }),
];

test('「昨天的报告」：时间词真正过滤，类型词过滤；README 不是报告；只剩一个就直接打开', () => {
  assert.equal(top('昨天的报告', REVIEWS), 'f:monthly');
  assert.equal(top('打开昨天的报告', REVIEWS), 'f:monthly');
});

test('「上周的周报」：上周那一份周报（文件名 weekly），不是上上周的，也不是外部新闻「时代周报」', () => {
  assert.equal(top('上周的周报', REVIEWS), 'f:w39');
});

const PRS = [
  item({ key: 'web:pr686', kind: 'web', url: 'https://github.com/acme/app/pull/686', title: 'app PR #686', contexts: ['已开 PR 挂 automerge'], firstSeen: day(2, 23), lastSeen: day(2, 23) }),
  item({ key: 'web:pr689', kind: 'web', url: 'https://github.com/acme/app/pull/689', title: 'app PR #689', contexts: ['PR squash 已挂'], firstSeen: day(2, 23) + '', lastSeen: new Date(2026, 9, 2, 23, 31).toISOString() }),
  // someone else's PR, read later: not one we made
  item({ key: 'web:ext', kind: 'web', url: 'https://github.com/other/lib/pull/39', title: 'lib PR 39', contexts: ['参考来源'], count: 13, firstSeen: day(1), lastSeen: new Date(2026, 9, 2, 23, 50).toISOString() }),
];

test('「最近的 PR」：最新开出的那个（「squash 已挂」也算我们开的），不是后来才读到的别人的 PR', () => {
  PRS[1].firstSeen = new Date(2026, 9, 2, 23, 31).toISOString();
  assert.equal(top('最近的 PR', PRS), 'web:pr689');
  assert.equal(top('打开最近做的 PR', PRS), 'web:pr689');
});

const PAGES = [
  item({ key: 'art:plan', kind: 'artifact', url: 'https://claude.ai/artifact/PLANPLANPLAN', title: '发布作战图', count: 5, firstSeen: day(2, 0), lastSeen: day(2, 11) }),
  item({ key: 'f:plan', kind: 'file', url: '/home/u/x/launch-plan.html', title: '发布作战图', firstSeen: day(2, 0), lastSeen: day(2, 0) }),
  item({ key: 'f:tut', kind: 'file', url: '/home/u/shop/tutorial.html', title: '小店教程', firstSeen: day(2, 1), lastSeen: day(2, 1) }),
  item({ key: 'art:old', kind: 'artifact', url: 'https://claude.ai/artifact/OLDOLDOLDOLD', title: '期权手册', count: 8, firstSeen: sep(22), lastSeen: day(2, 6) }),
];

test('「昨天做的那个页面」：昨天新做、用得最多的页面；「做的」按第一次出现算，昨天只是又打开过的旧页面不算', () => {
  assert.equal(top('昨天做的那个页面', PAGES), 'art:plan');
});

const BOARDS = [
  item({ key: 'f:logo', kind: 'file', url: '/home/u/app/design/png/logo-board.png', title: 'logo 四个方向比稿 + 成功态', firstSeen: day(1, 23), lastSeen: day(1, 23) }),
  item({ key: 'f:shot', kind: 'file', url: '/home/u/app/design/png/03-success.png', title: 'logo 四个方向比稿 + 成功态', firstSeen: day(1, 23), lastSeen: day(1, 23) }),
  item({ key: 'f:seed3', kind: 'file', url: '/home/u/app/design/png/logo-sesame-v3-board.png', title: '芝麻 v3', count: 2, firstSeen: day(2, 0), lastSeen: day(2, 0) }),
  item({ key: 'f:proto', kind: 'file', url: '/home/u/app/design/prototype.html', title: 'Sesame 高保真预览', fullTitle: 'Sesame 高保真预览：最后是可交互原型', firstSeen: day(1, 22), lastSeen: day(1, 22) }),
  item({ key: 'f:png6', kind: 'file', url: '/home/u/app/design/png/06-candidates.png', title: 'Sesame 高保真预览', fullTitle: 'Sesame 高保真预览：最后是可交互原型', count: 2, firstSeen: day(1, 22), lastSeen: day(1, 23) }),
];

test('标题和文件名都算名字；原词胜过同义词：「logo 比稿」→ 比稿那张板，不是只靠 board 对上的 v3', () => {
  assert.equal(top('那个 logo 比稿', BOARDS), 'f:logo');
});

test('同名的几张图里，文件名也对得上（原型 = prototype）的那一个胜出', () => {
  assert.equal(top('Sesame 原型', BOARDS), 'f:proto');
});

const MIXED = [
  item({ key: 'local:8787', kind: 'local', url: 'http://127.0.0.1:8787', title: '库存看板', count: 27, contexts: ['拓扑页 基础设施 VPS 代理 Tailscale'], lastSeen: day(2) }),
  item({ key: 'f:vps', kind: 'file', url: '/home/u/infra/logs/vps-traffic-20260929.md', title: 'vps-traffic-20260929.md', firstSeen: sep(29), lastSeen: sep(29) }),
  item({ key: 'web:law', kind: 'web', url: 'https://gov.example.cn/case', title: '网络交易执法典型案例', count: 2 }),
  item({ key: 'art:try', kind: 'artifact', url: 'https://claude.ai/artifact/TRYTRYTRYTRY', title: '试听页', contexts: ['三角色 候选音色'], count: 6, lastSeen: day(1) }),
  item({ key: 'art:map', kind: 'artifact', url: 'https://claude.ai/artifact/MAPMAPMAPMAP', title: '项目全景', contexts: ['音色 试听 进度'], count: 5, lastSeen: day(1) }),
];

test('类型词把范围收窄后，名词在上下文里对上也能打开：「VPS 流量看板」→ 库存看板（只剩它一个看板）', () => {
  assert.equal(top('VPS 流量看板', MIXED), 'local:8787');
  assert.equal(top('open the inventory dashboard', MIXED), 'local:8787');
});

test('索引里没有这种产物就直接说没找到，不拿凑数的候选顶上：「上周那个交易大盘」', () => {
  const c = searchSaved('上周那个交易大盘', MIXED, {}, NOW);
  assert.equal(decide(c), null);
  assert.equal(shortlist(c).length, 0);
});

test('名字里有一个名词、上下文里有另一个，而且只有它名字里对上：「音色试听」→ 试听页', () => {
  assert.equal(top('那个音色试听', MIXED), 'art:try');
});

test('router 没配 key：分不出也没有完整对上的 → 回答没找到，不弹凑数的候选列表', async () => {
  const ran: string[][] = [];
  const ctx: ExecContext = {
    dryRun: false, print: () => {}, home: '/home/u', now: () => NOW, confirm: async () => false, saved: memoryStore(MIXED),
    run: async (cmd, args) => { ran.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '' }; },
  };
  const r = await handle('上周那个交易大盘', { cache: new MemoryCache(), chat: null, ctx, feedback: async () => {}, resolveApp: () => null });
  assert.equal(r.opened, undefined);
  assert.equal(r.candidates?.length ?? 0, 0);
  assert.match(r.result, /没找到/);
  assert.equal(ran.length, 0);
  const ok = await handle('那个音色试听', { cache: new MemoryCache(), chat: null, ctx, feedback: async () => {}, resolveApp: () => null });
  assert.equal(ok.opened?.key, 'art:try');
});

test('个人同义词来自 config.yaml synonyms（项目自己的词不进仓库）：设了才认，不设不认', () => {
  const items = [item({ key: 'local:9000', kind: 'local', url: 'http://127.0.0.1:9000', title: '采购看板', count: 3, lastSeen: day(2) })];
  assert.equal(top('open the procurement dashboard', items), null, '没配同义词：英文名对不上中文标题');
  setConfig({ ...defaultConfig('/x'), synonyms: [['采购', 'procurement']] });
  assert.equal(top('open the procurement dashboard', items), 'local:9000');
  setConfig(defaultConfig('/x'));
  assert.equal(top('open the procurement dashboard', items), null, '去掉后恢复');
  assert.deepEqual(parseConfig({ synonyms: [['采购', 'procurement'], ['单个词']] }, '/x').synonyms, [['采购', 'procurement']], '一组至少两个词');
});
