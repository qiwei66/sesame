/** WO-20261001-024：缓存回放存选中 key、数据最小化、索引降噪、弱网页、按需刷新可放弃、doctor 纯函数 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryCache } from '../src/cache.ts';
import { handle } from '../src/router.ts';
import { normalize } from '../src/normalize.ts';
import { TOOL_MAP, TOOLS_VERSION, toolsVersionOf, toolDefinitions, isNoCache, openSaved } from '../src/tools.ts';
import { memoryStore, searchSaved, isWeakWeb } from '../src/saved.ts';
import { classify, extractUrlsFromText, isTruncatedUrl } from '../src/indexer.ts';
import { runIndex, IndexAborted } from '../src/index-run.ts';
import { certLevel, countRecentErrors, spotlightHotkeyEnabled, formatCheck } from '../src/doctor.ts';
import type { ChatFn, ChatMessage, ChatResponse } from '../src/llm.ts';
import type { ExecContext, RunOutput } from '../src/types.ts';
import type { SavedItem } from '../src/indexer.ts';

const item = (p: Partial<SavedItem> & { key: string; title: string; kind: SavedItem['kind']; url: string }): SavedItem => ({
  variants: [p.url], titleSource: 'html', contexts: [], count: 3, firstSeen: '2026-09-20T00:00:00Z', lastSeen: '2026-09-28T00:00:00Z', ...p,
});

function makeCtx(opts: { dryRun?: boolean; items?: SavedItem[]; runImpl?: (cmd: string, args: string[]) => RunOutput } = {}) {
  const ran: Array<{ cmd: string; args: string[] }> = [];
  const printed: string[] = [];
  const ctx: ExecContext = {
    dryRun: opts.dryRun ?? false,
    print: (l) => printed.push(l),
    run: async (cmd, args) => { ran.push({ cmd, args }); return opts.runImpl ? opts.runImpl(cmd, args) : { code: 0, stdout: '', stderr: '' }; },
    confirm: async () => false,
    home: '/home/tester',
    now: () => new Date(2026, 9, 1, 20, 0, 0),
    saved: opts.items ? memoryStore(opts.items) : undefined,
  };
  return { ctx, ran, printed };
}

const tc = (id: string, name: string, args: unknown) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });
function fakeChat(replies: Array<Partial<ChatResponse['message']>>): { chat: ChatFn; calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  let i = 0;
  return {
    calls,
    chat: async (messages) => {
      calls.push(structuredClone(messages));
      const r = replies[Math.min(i++, replies.length - 1)];
      return { message: { role: 'assistant', content: r.content ?? null, tool_calls: r.tool_calls }, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, finishReason: 'tool_calls' };
    },
  };
}

// ── 1. 工具表版本号 / noCache ──

test('工具表版本号：工具定义一变就变', () => {
  assert.match(TOOLS_VERSION, /^[0-9a-f]{12}$/);
  const defs = toolDefinitions();
  assert.equal(toolsVersionOf(defs), TOOLS_VERSION);
  const changed = structuredClone(defs);
  changed[0].function.description += '（改了一个字）';
  assert.notEqual(toolsVersionOf(changed), TOOLS_VERSION);
});

test('isNoCache：save_alias、create_reminder、unsupported 不缓存；其它照常', () => {
  assert.equal(isNoCache({ name: 'save_alias', args: { alias: 'x' } }), true);
  assert.equal(isNoCache({ name: 'applescript', args: { action: 'create_reminder', params: {} } }), true);
  assert.equal(isNoCache({ name: 'unsupported', args: {} }), true);
  assert.equal(isNoCache({ name: 'applescript', args: { action: 'mute', params: {} } }), false);
  assert.equal(isNoCache({ name: 'open_app', args: { name: 'Safari' } }), false);
  assert.equal(TOOL_MAP.save_alias.cachePolicy, 'never');
});

test('save_alias / create_reminder 连跑两次也不进缓存（候选也不记）', async () => {
  const { ctx } = makeCtx({ dryRun: true, items: [item({ key: 'web:a', kind: 'web', url: 'https://a.com', title: '库存看板' })] });
  ctx.saved?.setLastOpened('web:a');
  for (const [input, call] of [
    ['把刚才那个记成大盘', tc('1', 'save_alias', { alias: '大盘' })],
    ['明天早上9点提醒我交材料', tc('1', 'applescript', { action: 'create_reminder', params: { title: '交材料', day_offset: 1, time: '09:00' } })],
  ] as const) {
    const cache = new MemoryCache();
    const { chat } = fakeChat([{ tool_calls: [call] }]);
    for (let i = 0; i < 2; i++) {
      const r = await handle(input, { cache, chat, ctx, feedback: async () => {} });
      assert.equal(r.calls[0].ok, true, `${input} 本身要执行成功`);
      assert.equal(r.cached, false);
      assert.notEqual(r.cacheCandidate, true);
    }
    assert.equal(cache.keys().length, 0);
    assert.equal(cache.getCandidate(normalize(input)), undefined);
  }
});

// ── 5. open_saved 缓存存选中 key ──

const SAVED = [
  item({ key: 'local:host:8787', kind: 'local', url: 'http://127.0.0.1:8787', title: '库存看板', count: 14 }),
  item({ key: 'artifact:B6DM', kind: 'artifact', url: 'https://claude.ai/artifact/B6DMcSVZiYk69VEtYTpAkn', title: '期权作战手册' }),
];

test('open_saved：缓存条目带选中项 key；回放直接打开该项，不再检索', async () => {
  const cache = new MemoryCache();
  const { ctx, ran } = makeCtx({ items: SAVED });
  const { chat } = fakeChat([{ tool_calls: [tc('1', 'open_saved', { query: '库存看板' })] }]);
  const deps = { cache, chat, ctx, feedback: async () => {} };
  // 这句话本地索引答不了（没有名字）→ 走模型，规划进缓存（说出名字的「打开库存看板」走本地层，见 wo034.test.ts）
  await handle('打开上次说的那个', deps);
  const r2 = await handle('打开上次说的那个', deps);
  assert.equal(r2.cached, true);
  assert.equal(cache.get(normalize('打开上次说的那个'))?.actions[0].savedKey, 'local:host:8787');
  // 回放：把检索打残（换掉标题），仍然按 key 直接打开
  const items = ctx.saved?.items() ?? [];
  items[0].title = '完全不相关的标题';
  const r3 = await handle('打开上次说的那个', deps);
  assert.equal(r3.layer, 'cache');
  assert.equal(r3.calls[0].ok, true);
  assert.deepEqual(ran.at(-1), { cmd: 'open', args: ['http://127.0.0.1:8787'] });
});

test('open_saved 回放：key 在索引里没了 → 回退到检索', async () => {
  const cache = new MemoryCache({ 打开期权作战手册: { sample: 'x', actions: [{ name: 'open_saved', args: { query: '期权作战手册' }, savedKey: 'artifact:GONE' }], createdAt: '', hits: 0, toolsVersion: TOOLS_VERSION } });
  const { ctx, ran } = makeCtx({ items: SAVED });
  const r = await handle('打开期权作战手册', { cache, chat: null, ctx, feedback: async () => {} });
  assert.equal(r.layer, 'cache');
  assert.equal(r.calls[0].ok, true);
  assert.deepEqual(ran.at(-1), { cmd: 'open', args: ['https://claude.ai/artifact/B6DMcSVZiYk69VEtYTpAkn'] });
});

test('open_saved 回放：key 对应项打不开（open 失败）→ 回退检索', async () => {
  const cache = new MemoryCache({ 打开库存看板: { sample: 'x', actions: [{ name: 'open_saved', args: { query: '期权作战手册' }, savedKey: 'local:host:8787' }], createdAt: '', hits: 0, toolsVersion: TOOLS_VERSION } });
  const { ctx, ran } = makeCtx({ items: SAVED, runImpl: (_c, a) => (a[0].includes('8787') ? { code: 1, stdout: '', stderr: 'dead' } : { code: 0, stdout: '', stderr: '' }) });
  const r = await handle('打开库存看板', { cache, chat: null, ctx, feedback: async () => {} });
  assert.equal(r.calls[0].ok, true);
  assert.equal(ran.length, 2, '先试 key 对应项，失败后检索再开');
});

test('open_saved 结果是「已取消/让你选」时不进缓存', async () => {
  const cache = new MemoryCache();
  const items = [item({ key: 'a', kind: 'web', url: 'https://a.com', title: '门店预约 A' }), item({ key: 'b', kind: 'web', url: 'https://b.com', title: '门店预约 B' })];
  const { ctx } = makeCtx({ dryRun: true, items });
  const { chat } = fakeChat([{ tool_calls: [tc('1', 'open_saved', { query: '门店预约' })] }]);
  for (let i = 0; i < 2; i++) await handle('打开门店预约', { cache, chat, ctx: { ...ctx, pick: async () => ({ index: 0 }) }, feedback: async () => {} });
  assert.equal(cache.keys().length, 0);
});

// ── 6. 数据最小化 ──

test('第二轮请求：read_clipboard 只给摘要与数量，不给全文', async () => {
  const secret = '这是一段很私密的剪贴板内容 ABC-123 不该出本机';
  const { ctx } = makeCtx({ runImpl: (cmd) => (cmd === 'pbpaste' ? { code: 0, stdout: secret, stderr: '' } : { code: 0, stdout: '', stderr: '' }) });
  // 第一轮：read_clipboard + 一个必失败的工具 → 进入第二轮
  const { chat, calls } = fakeChat([{ tool_calls: [tc('1', 'read_clipboard', {}), tc('2', 'open_app', { name: '不存在的App' })] }, { content: '好' }]);
  const r = await handle('读剪贴板然后打开那个', { cache: new MemoryCache(), chat, ctx, feedback: async () => {} });
  assert.equal(calls.length, 2);
  const toModel = JSON.stringify(calls[1]);
  assert.ok(!toModel.includes('ABC-123'), '剪贴板全文不得进入模型请求');
  assert.match(toModel, /剪贴板有文本（\d+ 字/);
  assert.match(r.result, /ABC-123/, '本机给用户看的结果照常有内容');
});

test('第二轮请求：search_files 只给数量与扩展名分布，不给文件名和完整路径', async () => {
  const { ctx } = makeCtx({ runImpl: (cmd) => (cmd === 'mdfind' ? { code: 0, stdout: '/home/tester/Downloads/体检报告-张三.pdf\n/home/tester/Downloads/合同.pdf\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }) });
  const { chat, calls } = fakeChat([{ tool_calls: [tc('1', 'search_files', { dir: 'downloads', extension: 'pdf' }), tc('2', 'open_app', { name: '不存在的App' })] }, { content: '好' }]);
  await handle('找下载里的pdf', { cache: new MemoryCache(), chat, ctx, feedback: async () => {} });
  const toModel = JSON.stringify(calls[1]);
  assert.ok(!toModel.includes('/home/tester'), '完整路径不得进入模型请求');
  assert.ok(!toModel.includes('体检报告'), '文件名不得进入模型请求');
  const toolMsg = JSON.parse(String(calls[1].find((m) => m.role === 'tool')?.content)) as { result: string; data: unknown };
  assert.equal(toolMsg.result, '在 Downloads 找到 2 个文件');
  assert.deepEqual(toolMsg.data, { count: 2, by_extension: { pdf: 2 } });
});

// ── 4. 索引降噪 ──

test('降噪：t.co、x.com/twitter 帖子、GitHub Actions 运行页不收；普通 x.com 主页、github 仓库照收', () => {
  assert.equal(classify('https://t.co/AbCdEf123'), null);
  assert.equal(classify('https://x.com/someone/status/1839999999999999999'), null);
  assert.equal(classify('https://twitter.com/someone/status/1839999999999999999'), null);
  assert.equal(classify('https://mobile.twitter.com/someone/status/18399999'), null);
  assert.equal(classify('https://github.com/octo/widget/actions/runs/123456789'), null);
  assert.equal(classify('https://github.com/octo/widget/actions/runs/123/job/456'), null);
  assert.ok(classify('https://x.com/someone'));
  assert.ok(classify('https://github.com/octo/widget'));
  assert.ok(classify('https://github.com/octo/widget/pull/12'));
});

test('降噪：被省略号截断的 URL 不收；va 的 DRY-RUN 输出行里的链接不收', () => {
  assert.equal(isTruncatedUrl('https://a.com/abc…', ''), true);
  assert.equal(isTruncatedUrl('https://a.com/abc', '…后面'), true);
  assert.equal(isTruncatedUrl('https://a.com/abc...', ''), true);
  assert.equal(isTruncatedUrl('https://a.com/abc', ' 正常'), false);
  const hits = extractUrlsFromText([
    '门店官网 https://shop.example-store.cn/home…',
    '截断 https://shop.example-store.cn/a...',
    '[DRY-RUN] open_saved 选中（模型挑选）：x → open https://dry.example-store.cn/p',
    '（演练）打开 https://dry2.example-store.cn/p',
    '真的链接 https://real.example-store.cn/page',
  ].join('\n'), '2026-10-01T00:00:00Z');
  assert.deepEqual(hits.map((h) => h.url), ['https://real.example-store.cn/page']);
});

test('弱网页（无标题且只出现一次）：检索降权，且不发给模型挑选', async () => {
  const weak = item({ key: 'web:weak', kind: 'web', url: 'https://weak.cn', title: '', contexts: ['门店 服务 官网'], count: 1 });
  const strong = item({ key: 'web:strong', kind: 'web', url: 'https://strong.cn', title: '', contexts: ['门店 服务 官网'], count: 4 });
  assert.equal(isWeakWeb(weak), true);
  assert.equal(isWeakWeb(strong), false);
  const c = searchSaved('门店服务的官网', [weak, strong], {});
  assert.equal(c[0].item.key, 'web:strong');
  assert.ok(c[1].score < c[0].score);
  let sent = '';
  const s2 = item({ key: 'web:s2', kind: 'web', url: 'https://s2.cn', title: '', contexts: ['门店 服务 官网'], count: 4 });
  const { ctx } = makeCtx({ dryRun: true, items: [weak, strong, s2] });
  ctx.pick = async (_q, cands) => { sent = cands; return { index: 0 }; };
  await openSaved('门店服务的官网', ctx);
  assert.ok(sent.length > 0, '有非弱候选时照常问模型');
  assert.equal(sent.split('\n').length, 2, '弱网页不在发给模型的列表里');
});

// ── 2. 按需刷新超时：放弃并回滚 ──

test('runIndex：signal 已 abort → 抛 IndexAborted，正式索引文件一个字节不动、不留临时文件和锁', async () => {
  const root = mkdtempSync(join(tmpdir(), 'va-ab-'));
  const projects = join(root, 'projects', 'p');
  mkdirSync(projects, { recursive: true });
  const indexDir = join(root, 'index');
  writeFileSync(join(projects, 's1.jsonl'), `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-01T00:00:00Z', message: { content: '看板 https://keep.example-store.cn/a' } })}\n`);
  await runIndex({ projectsDir: join(root, 'projects'), indexDir }, { fetchTitles: false });
  const before = ['items.json', 'state.json', 'titles.json'].map((f) => readFileSync(join(indexDir, f), 'utf8'));
  writeFileSync(join(projects, 's2.jsonl'), `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-01T01:00:00Z', message: { content: '新的 https://new.example-store.cn/b' } })}\n`);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(runIndex({ projectsDir: join(root, 'projects'), indexDir }, { fetchTitles: false, signal: ac.signal }), IndexAborted);
  const after = ['items.json', 'state.json', 'titles.json'].map((f) => readFileSync(join(indexDir, f), 'utf8'));
  assert.deepEqual(after, before);
  assert.deepEqual(readdirSync(indexDir).sort(), ['items.json', 'state.json', 'titles.json']);
  assert.equal(existsSync(join(indexDir, 'lock')), false);
});

// ── 3. doctor 纯函数 ──

test('doctor：证书少于 60 天标红；Spotlight 64 号快捷键解析；24 小时错误计数', () => {
  assert.equal(certLevel(59), 'fail');
  assert.equal(certLevel(-3), 'fail');
  assert.equal(certLevel(281), 'ok');
  assert.match(formatCheck({ name: '签名证书', level: 'fail', detail: '剩 30 天', fix: '续期' }, true), /\x1b\[31m❌ 签名证书：剩 30 天\x1b\[0m\n {5}修法：续期/);
  const txt = '{\n    32 =     {\n        enabled = 1;\n    };\n    64 =     {\n        enabled = 0;\n        value = {};\n    };\n}';
  assert.equal(spotlightHotkeyEnabled(txt), false);
  assert.equal(spotlightHotkeyEnabled(txt.replace('enabled = 0', 'enabled = 1')), true);
  assert.equal(spotlightHotkeyEnabled('{ 32 = { enabled = 1; }; }'), null);
  const logDir = mkdtempSync(join(tmpdir(), 'va-lg-'));
  const now = new Date('2026-10-01T12:00:00Z');
  writeFileSync(join(logDir, '2026-10-01.jsonl'), [
    { ts: '2026-10-01T11:00:00Z', layer: 'llm' }, { ts: '2026-10-01T10:00:00Z', layer: 'error', error: 'DeepSeek HTTP 503' },
    { ts: '2026-09-29T10:00:00Z', layer: 'error', error: '太旧' },
  ].map((x) => JSON.stringify(x)).join('\n'));
  const e = countRecentErrors(logDir, now);
  assert.equal(e.total, 2);
  assert.equal(e.errors, 1);
});
