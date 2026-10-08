/** WO-20261002-034：本地优先 / 没 key 可用 / opened 字段 / 面板内确认 / 取消 / 空标题回退 / 时间词 / 安装形态的数据目录 / doctor 形态 / 后台索引 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryCache } from '../src/cache.ts';
import { handle, openQuery } from '../src/router.ts';
import { memoryStore, searchSaved, displayTitle } from '../src/saved.ts';
import { extractTimeHint } from '../src/timewords.ts';
import { defaultConfig, resolvePaths, setConfig, INSTALL_MARKER } from '../src/config.ts';
import { collectChecks } from '../src/doctor.ts';
import { dispatch } from '../src/rpc.ts';
import { IndexService } from '../src/index-service.ts';
import { installUserTools, resetTools } from '../src/tools.ts';
import { resolveProvider } from '../src/providers.ts';
import type { Runtime } from '../src/runtime.ts';
import type { ChatFn } from '../src/llm.ts';
import type { ExecContext, RunOutput, ToolSpec } from '../src/types.ts';
import type { SavedItem } from '../src/indexer.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => mkdtempSync(join(tmpdir(), 'va-wo034-'));
const NOW = new Date(2026, 9, 2, 15, 0, 0); // 2026-10-02 15:00 local

const item = (p: Partial<SavedItem> & { key: string; title: string; kind: SavedItem['kind']; url: string }): SavedItem => ({
  variants: [p.url], titleSource: 'html', contexts: [], count: 3, firstSeen: '2026-09-20T00:00:00Z', lastSeen: '2026-09-28T00:00:00Z', ...p,
});

function makeCtx(items?: SavedItem[], runImpl?: (cmd: string, args: string[]) => RunOutput) {
  const ran: Array<{ cmd: string; args: string[] }> = [];
  const ctx: ExecContext = {
    dryRun: false,
    print: () => {},
    run: async (cmd, args) => { ran.push({ cmd, args }); return runImpl ? runImpl(cmd, args) : { code: 0, stdout: '', stderr: '' }; },
    confirm: async () => { throw new Error('the core must not ask for confirmation by itself in these tests'); },
    home: '/home/tester',
    now: () => NOW,
    saved: items ? memoryStore(items) : undefined,
  };
  return { ctx, ran };
}

const noApp = () => null;
const tc = (id: string, name: string, args: unknown) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });
function spyChat(reply: ReturnType<typeof tc>[]): { chat: ChatFn; calls: () => number } {
  let n = 0;
  return { calls: () => n, chat: async () => { n += 1; return { message: { role: 'assistant', content: null, tool_calls: reply }, usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }, finishReason: 'tool_calls' }; } };
}

const ITEMS = [
  item({ key: 'local:host:8787', kind: 'local', url: 'http://127.0.0.1:8787', title: '库存看板', count: 14 }),
  item({ key: 'artifact:B6DM', kind: 'artifact', url: 'https://claude.ai/artifact/B6DMcSVZiYk69VEtYTpAkn', title: '期权作战手册' }),
  item({ key: 'web:gov', kind: 'web', url: 'https://scjgj.beijing.gov.cn/case', title: '网络交易执法典型案例', count: 1 }),
];

// ── P0-2：本地优先，没 key 也能用 ──

test('openQuery：去掉「打开 / open」动词，没有动词时整句照旧', () => {
  assert.deepEqual(openQuery('打开库存看板'), { query: '库存看板', verb: true });
  assert.deepEqual(openQuery('帮我看一下期权作战手册'), { query: '期权作战手册', verb: true });
  assert.deepEqual(openQuery('open the inventory dashboard'), { query: 'the inventory dashboard', verb: true });
  assert.deepEqual(openQuery('库存看板'), { query: '库存看板', verb: false });
});

test('本地优先：说的就是标题 → 直接打开，不调模型；opened 是真正打开的那一项', async () => {
  setConfig(defaultConfig('/x'));
  const { ctx, ran } = makeCtx(structuredClone(ITEMS));
  const spy = spyChat([tc('1', 'open_saved', { query: '库存看板' })]);
  const r = await handle('打开库存看板', { cache: new MemoryCache(), chat: spy.chat, ctx, feedback: async () => {}, resolveApp: noApp });
  assert.equal(r.layer, 'local');
  assert.equal(spy.calls(), 0, '模型一次都没调');
  assert.equal(r.usage.total_tokens, 0);
  assert.deepEqual(ran.at(-1), { cmd: 'open', args: ['http://127.0.0.1:8787'] });
  assert.equal(r.opened?.title, '库存看板');
  assert.equal(r.opened?.url, 'http://127.0.0.1:8787');
  assert.equal(r.opened?.kind, 'local');
  // 不说「打开」、整句就是名称 → 同样本地直开
  const r2 = await handle('期权作战手册', { cache: new MemoryCache(), chat: spy.chat, ctx, feedback: async () => {}, resolveApp: noApp });
  assert.equal(r2.layer, 'local');
  assert.equal(r2.opened?.key, 'artifact:B6DM');
  assert.equal(spy.calls(), 0);
});

test('有 key、本地拿不准 → 仍然问模型（本地层不抢）', async () => {
  // two items carry 库存 in their name: the local layer does not pick one by itself when a model can
  const { ctx } = makeCtx([...structuredClone(ITEMS), item({ key: 'artifact:KC', kind: 'artifact', url: 'https://claude.ai/artifact/KCKCKCKCKCKC', title: '库存周报' })]);
  const spy = spyChat([tc('1', 'open_saved', { query: '库存' })]);
  const r = await handle('打开上次那个库存', { cache: new MemoryCache(), chat: spy.chat, ctx, feedback: async () => {}, resolveApp: noApp });
  assert.equal(r.layer, 'llm');
  assert.equal(spy.calls(), 1);
});

test('没配 key：明显领先 → 直接打开；分不清 → 候选交给界面（不弹系统列表）；App 名 → 打开 App', async () => {
  setConfig(defaultConfig('/x'));
  const two = [...structuredClone(ITEMS), item({ key: 'local:host:8788', kind: 'local', url: 'http://127.0.0.1:8788', title: '库存看板（测试版）', count: 14 })];
  const { ctx, ran } = makeCtx(two);
  const win = await handle('打开期权作战手册', { cache: new MemoryCache(), chat: null, ctx, feedback: async () => {}, resolveApp: noApp });
  assert.equal(win.layer, 'local');
  assert.equal(win.opened?.title, '期权作战手册');
  const amb = await handle('打开库存', { cache: new MemoryCache(), chat: null, ctx, feedback: async () => {}, resolveApp: noApp });
  assert.equal(amb.layer, 'local');
  assert.equal(amb.attention, true, '候选态要用户注意');
  assert.ok((amb.candidates?.length ?? 0) >= 2, '候选交回界面');
  assert.deepEqual(amb.candidates?.map((c) => c.key).sort(), ['local:host:8787', 'local:host:8788']);
  assert.ok(!ran.some((x) => x.cmd === 'osascript'), '没有弹任何系统对话框');
  const app = await handle('打开飞书', { cache: new MemoryCache(), chat: null, ctx, feedback: async () => {}, resolveApp: (n) => (n === '飞书' ? 'Lark' : null) });
  assert.equal(app.layer, 'local');
  assert.deepEqual(ran.at(-1), { cmd: 'open', args: ['-a', 'Lark'] });
  assert.equal(app.opened?.kind, 'app');
});

test('没配 key：错误文案是人话，不出现英文错误码，也不把用户原话再显示一遍', async () => {
  setConfig(defaultConfig('/x'));
  const { ctx } = makeCtx(structuredClone(ITEMS));
  const miss = await handle('打开汇率换算表', { cache: new MemoryCache(), chat: null, ctx, feedback: async () => {}, resolveApp: noApp });
  assert.equal(miss.layer, 'error');
  assert.equal(miss.result, '没找到「汇率换算表」');
  assert.match(miss.need ?? '', /没配模型也能用；配上后能听懂更模糊的说法/);
  const rt = fakeRuntime(structuredClone(ITEMS), null);
  const res = await dispatch({ jsonrpc: '2.0', id: 1, method: 'handle', params: { text: '打开汇率换算表' } }, deps(rt));
  const card = (res?.result as any).cards[0];
  assert.equal(card.title, '没找到「汇率换算表」');
  assert.match(card.detail, /没配模型也能用/);
  assert.doesNotMatch(JSON.stringify(card), /no model key|no_model|va doctor/);
  assert.notEqual(card.detail, '打开汇率换算表');
});

// ── P0-4：opened = 核心真正打开的那一项 ──

function fakeRuntime(items: SavedItem[], chat: ChatFn | null, runImpl?: (cmd: string, args: string[]) => RunOutput): Runtime & { ran: Array<{ cmd: string; args: string[] }> } {
  const { ctx, ran } = makeCtx(items, runImpl);
  const cache = new MemoryCache();
  return {
    ran,
    cfg: defaultConfig('/x'), root: '/r', dataDir: '/r', paths: { appRoot: '/r', dataDir: '/r', indexDir: '/r/index', logDir: '/r/logs' }, home: '/home/tester',
    provider: resolveProvider(defaultConfig('/x'), {}), keyFrom: null, chat, ctx, cache, skillErrors: [],
    run: (input, o = {}) => handle(input, { cache, chat, ctx: o.ctx ? { ...ctx, ...o.ctx } : ctx, feedback: o.feedback ?? (async () => {}), resolveApp: noApp }),
  };
}
const deps = (rt: Runtime) => ({ runtime: async () => rt, root: '/r', home: '/home/tester', run: rt.ctx.run, write: () => {} });

test('rpc handle：opened 是模型挑中的那一项（不是检索第一名），带 title/url/kind', async () => {
  setConfig(defaultConfig('/x'));
  // two dashboards both named 库存看板 …: search cannot tell them apart, the model picks the second one
  // (plain web pages here: what the AI made would rank first and open without asking the model)
  const items = [
    item({ key: 'web:kc1', kind: 'web', url: 'https://kc1.example.net', title: '库存看板 华东', count: 9, lastSeen: '2026-10-01T00:00:00Z' }),
    item({ key: 'web:compute', kind: 'web', url: 'https://compute.example.net', title: '库存看板 华南', count: 2 }),
  ];
  const chat = spyChat([tc('1', 'open_saved', { query: '库存大盘' })]).chat;
  const rt = fakeRuntime(items, chat);
  rt.ctx.pick = async (_q, list) => ({ index: list.split('\n').findIndex((l) => l.includes('华南')) + 1 });
  const top = searchSaved('库存大盘', items, {}, NOW)[0];
  assert.notEqual(top.item.key, 'web:compute', '前提：检索第一名不是华南那个');
  const res = await dispatch({ jsonrpc: '2.0', id: 2, method: 'handle', params: { text: '打开那个库存大盘' } }, deps(rt));
  const r = res?.result as any;
  assert.deepEqual({ title: r.opened.title, url: r.opened.url, kind: r.opened.kind, key: r.opened.key }, { title: '库存看板 华南', url: 'https://compute.example.net', kind: 'web', key: 'web:compute' });
  assert.deepEqual(rt.ran.at(-1), { cmd: 'open', args: ['https://compute.example.net'] });
});

test('rpc handle：没 key 分不清时返回 candidates（结构化，含空标题回退）', async () => {
  setConfig(defaultConfig('/x'));
  const items = [
    item({ key: 'local:host:8787', kind: 'local', url: 'http://127.0.0.1:8787', title: '库存看板', count: 5 }),
    item({ key: 'local:host:8788', kind: 'local', url: 'http://127.0.0.1:8788', title: '库存看板 v2', count: 5 }),
  ];
  const rt = fakeRuntime(items, null);
  const res = await dispatch({ jsonrpc: '2.0', id: 3, method: 'handle', params: { text: '打开库存' } }, deps(rt));
  const r = res?.result as any;
  assert.equal(r.layer, 'local');
  assert.equal(r.candidates.length, 2);
  assert.deepEqual(Object.keys(r.candidates[0]).filter((k) => ['key', 'title', 'url', 'kind'].includes(k)).sort(), ['key', 'kind', 'title', 'url']);
  assert.equal(r.opened, null);
  assert.ok(!rt.ran.some((x) => x.cmd === 'osascript'));
});

// ── P1：确认只在面板里做一次；Esc 取消 ──

test('rpc confirmed：不带 confirmed → 不弹系统框、不执行，返回 needsConfirmation；带 confirmed:true → 直接执行', async () => {
  let ran = 0;
  const spec: ToolSpec = {
    name: 'wipe_cache', description: 'wipe', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, readOnly: false, needsConfirm: true,
    async exec() { ran += 1; return { ok: true, display: 'wiped' }; },
  };
  installUserTools([spec]);
  try {
    const chat = spyChat([tc('1', 'wipe_cache', {})]).chat;
    const rt = fakeRuntime([], chat);
    const first = (await dispatch({ jsonrpc: '2.0', id: 4, method: 'handle', params: { text: 'wipe the cache' } }, deps(rt)))?.result as any;
    assert.equal(ran, 0);
    assert.match(first.needsConfirmation.message, /wipe_cache/);
    const second = (await dispatch({ jsonrpc: '2.0', id: 5, method: 'handle', params: { text: 'wipe the cache', confirmed: true } }, deps(rt)))?.result as any;
    assert.equal(ran, 1);
    assert.equal(second.needsConfirmation, null);
    assert.ok(!rt.ran.some((x) => x.cmd === 'osascript'), '核心没有弹 display dialog');
  } finally {
    resetTools();
  }
});

test('rpc cancel：面板关掉后取消，模型回来后不再打开任何产物', async () => {
  setConfig(defaultConfig('/x'));
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const chat: ChatFn = async () => { await gate; return { message: { role: 'assistant', content: null, tool_calls: [tc('1', 'open_saved', { query: '库存看板' })] }, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, finishReason: 'tool_calls' }; };
  const rt = fakeRuntime(structuredClone(ITEMS), chat);
  // a sentence the local index cannot answer: it waits for the model
  const pending = dispatch({ jsonrpc: '2.0', id: 77, method: 'handle', params: { text: '打开上次说的那个' } }, deps(rt));
  await new Promise((r) => setTimeout(r, 20));
  const c = await dispatch({ jsonrpc: '2.0', method: 'cancel', params: { id: 77 } }, deps(rt));
  assert.equal((c?.result as any).cancelled, true);
  release();
  const r = (await pending)?.result as any;
  assert.equal(r.cancelled, true);
  assert.ok(!rt.ran.some((x) => x.cmd === 'open'), '取消后没有 open');
});

// ── P1：空标题回退 ──

test('displayTitle：空标题 → 域名或文件名 → 路径最后一段', () => {
  assert.equal(displayTitle({ title: '  ', url: 'https://www.example.org/a/b?x=1', kind: 'web' }), 'example.org');
  assert.equal(displayTitle({ title: '', url: 'http://127.0.0.1:7341/', kind: 'local' }), 'localhost:7341');
  assert.equal(displayTitle({ title: '', url: '/home/x/Desktop/报价单.pdf', kind: 'file' }), '报价单.pdf');
  assert.equal(displayTitle({ title: '', url: 'https://claude.ai/artifact/B6DMcSVZ', kind: 'artifact' }), 'B6DMcSVZ');
  assert.equal(displayTitle({ title: '库存看板', url: 'http://127.0.0.1:8787', kind: 'local' }), '库存看板');
});

test('rpc search：空标题的结果也有可显示的标题', async () => {
  const rt = fakeRuntime([item({ key: 'web:ex', kind: 'web', url: 'https://docs.example.org/guide', title: '', contexts: ['部署指南 文档'], count: 3 })], null);
  const res = (await dispatch({ jsonrpc: '2.0', id: 6, method: 'search', params: { query: '部署指南' } }, deps(rt)))?.result as any;
  assert.equal(res.results[0].title, 'docs.example.org');
});

// ── P1：时间词 ──

test('extractTimeHint：昨天 / 前天 / 上周 / 最近 → 日期窗口或「最近」加权，并从查询里去掉', () => {
  const y = extractTimeHint('昨天的报告', NOW);
  assert.equal(y.hint?.word, '昨天');
  assert.equal(y.hint?.from?.getDate(), 1);
  assert.equal(y.hint?.to?.getDate(), 2);
  assert.match(y.query, /报告/);
  assert.doesNotMatch(y.query, /昨天/);
  const d2 = extractTimeHint('前天那个看板', NOW);
  assert.equal(d2.hint?.from?.getDate(), 30);
  const w = extractTimeHint('上周那个交易大盘', NOW);
  assert.equal(w.hint?.from?.getDay(), 1, '上周一');
  assert.equal(w.hint?.from?.getDate(), 21);
  const r = extractTimeHint('最近做的 PR', NOW);
  assert.equal(r.hint?.recent, true);
  assert.equal(r.query.replace(/\s/g, ''), 'PR');
  const en = extractTimeHint('the report from yesterday', NOW);
  assert.equal(en.hint?.word, 'yesterday');
  assert.equal(extractTimeHint('库存看板', NOW).hint, null);
});

test('「昨天的报告」：昨天出现过的报告排在更早的报告前面', () => {
  setConfig(defaultConfig('/x'));
  const items = [
    item({ key: 'file:/a/old.md', kind: 'file', url: '/a/old.md', title: '社区实践调研报告', count: 8, firstSeen: '2026-08-11T03:00:00Z', lastSeen: '2026-08-11T03:00:00Z' }),
    item({ key: 'file:/a/new.md', kind: 'file', url: '/a/new.md', title: '体验审计报告', count: 1, firstSeen: '2026-10-01T06:00:00Z', lastSeen: '2026-10-01T07:00:00Z' }),
  ];
  const r = searchSaved('昨天的报告', items, {}, NOW);
  assert.equal(r[0].item.key, 'file:/a/new.md');
});

test('「最近做的 PR」：GitHub PR 链接算作 PR，最新的排第一', () => {
  setConfig(defaultConfig('/x'));
  const items = [
    item({ key: 'web:pr567', kind: 'web', url: 'https://github.com/acme/app/pull/567', title: 'PR #567 修首页', count: 6, firstSeen: '2026-09-25T00:00:00Z', lastSeen: '2026-09-25T00:00:00Z' }),
    item({ key: 'web:pr624', kind: 'web', url: 'https://github.com/acme/app/pull/624', title: '开 PR + 挂 automerge', count: 1, firstSeen: '2026-10-02T05:05:00Z', lastSeen: '2026-10-02T05:05:00Z' }),
    item({ key: 'web:pr602', kind: 'web', url: 'https://github.com/acme/app/pull/602', title: '做了什么', count: 2, firstSeen: '2026-10-01T17:00:00Z', lastSeen: '2026-10-01T18:00:00Z' }),
  ];
  const r = searchSaved('最近做的 PR', items, {}, NOW);
  assert.equal(r[0].item.key, 'web:pr624');
  assert.ok(r.some((c) => c.item.key === 'web:pr602'), '标题里没有 PR 的 PR 链接也能找到');
});

// ── P0-1：数据目录 / doctor 形态 / 后台索引 ──

test('resolvePaths：make install 装的核心（有安装标记）默认把数据放到 ~/Library/Application Support/Sesame，不放核心目录', () => {
  const core = tmp();
  writeFileSync(join(core, INSTALL_MARKER), '');
  const c = defaultConfig('/x');
  const p = resolvePaths(c, core, {}, '/home/tester');
  assert.equal(p.dataDir, process.platform === 'darwin' ? '/home/tester/Library/Application Support/Sesame' : '/home/tester/.local/share/sesame/data');
  assert.equal(p.indexDir, join(p.dataDir, 'index'));
  // 个人配置里指定的 index_dir 优先（例如沿用旧检出的 ~/.voice-agent/index）
  assert.equal(resolvePaths({ ...c, index_dir: '~/.voice-agent/index' }, core, {}, '/home/tester').indexDir, '/home/tester/.voice-agent/index');
  // git 检出（无标记）照旧用仓库目录
  assert.equal(resolvePaths(c, tmp(), {}, '/home/tester').dataDir.startsWith(tmpdir()), true);
});

test('doctor：报 Node / 模型 / 索引 / 错误 / 热键，不报旧安装形态检查', async () => {
  const root = tmp();
  writeFileSync(join(root, INSTALL_MARKER), '');
  const checks = await collectChecks({ root, appRoot: root, indexDir: join(root, 'index'), logDir: join(root, 'logs'), home: root, run: async () => ({ code: 1, stdout: '', stderr: '' }) });
  const names = checks.map((c) => c.name).join(' | ');
  assert.doesNotMatch(names, /Alfred|launchd|辅助功能|Accessibility|签名|signature|certificate|Spotlight/i);
  assert.ok(checks.some((c) => /索引|Index/.test(c.name)));
  assert.ok(checks.some((c) => /热键|Hot key/.test(c.name)));
  const idx = checks.find((c) => /索引|Index/.test(c.name));
  assert.doesNotMatch(idx?.fix ?? '', /launchd/);
});

test('IndexService：后台子进程建索引，带进度；结束后 indexStatus 给条数和更新时间（模拟新用户 HOME + fixture 对话）', async () => {
  const home = tmp();
  const proj = join(home, '.claude/projects/-tmp-demo');
  mkdirSync(proj, { recursive: true });
  copyFileSync(join(ROOT, 'test/fixtures/fresh-user/session-fixture.jsonl'), join(proj, 'session-fixture.jsonl'));
  const cfgDir = join(home, '.config/voice-agent');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'config.yaml'), 'sources: [claude]\n');
  const indexDir = join(home, 'data/index');
  const env = { ...process.env, HOME: home, VA_CONFIG_DIR: cfgDir, VA_INDEX_DIR: indexDir, VA_LOG_DIR: join(home, 'data/logs') };
  const svc = new IndexService({ root: ROOT, indexDir, env });
  const s0 = svc.start();
  assert.equal(s0.running, true);
  assert.equal(svc.start().running, true, '重复 start 不会起第二个');
  await svc.wait();
  const s = svc.status();
  assert.equal(s.running, false);
  assert.equal(s.last, 'done', s.lastError ?? '');
  assert.ok(s.items >= 2, `items=${s.items}`);
  assert.ok(s.updatedAt && Date.parse(s.updatedAt) > Date.now() - 60_000);
  // the RPC method returns the same structured status (no paths for the UI to show)
  const st = (await dispatch({ jsonrpc: '2.0', id: 9, method: 'indexStatus' }, { ...deps(fakeRuntime([], null)), indexer: svc }))?.result as any;
  assert.equal(st.items, s.items);
  assert.ok(!JSON.stringify(st).includes(home), '状态里没有路径');
});

test('没配 key：只在上下文里沾边、标题对不上的「领先者」不自动打开，也不拿凑数的候选顶上：直接说没找到', async () => {
  setConfig(defaultConfig('/x'));
  const items = [
    item({ key: 'web:pic', kind: 'web', url: 'https://picsum.photos/seed/x', title: 'NO broken Unsplash links', contexts: ['stock trading dashboard mockup images'], count: 9, lastSeen: '2026-10-01T17:55:00Z' }),
    item({ key: 'web:arx', kind: 'web', url: 'https://arxiv.org/pdf/2605.19337', title: 'Agentic Trading paper', count: 1, lastSeen: '2026-08-11T00:00:00Z' }),
  ];
  const { ctx, ran } = makeCtx(items);
  const r = await handle('open the stock trading dashboard from last week', { cache: new MemoryCache(), chat: null, ctx, feedback: async () => {}, resolveApp: noApp });
  assert.equal(r.opened, undefined, '没有自动打开');
  assert.ok(!ran.some((x) => x.cmd === 'open'));
  assert.equal(r.candidates?.length ?? 0, 0, '没有看板 → 不列外部网页凑数');
  assert.match(r.result, /Nothing called|没找到/);
});
