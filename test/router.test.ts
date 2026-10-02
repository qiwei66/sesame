import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCache } from '../src/cache.ts';
import { handle, cacheableActions } from '../src/router.ts';
import { TOOLS_VERSION } from '../src/tools.ts';
import type { ChatFn, ChatMessage, ChatResponse } from '../src/llm.ts';
import type { ExecContext, RunOutput } from '../src/types.ts';

interface Recorded { cmd: string; args: string[] }

function makeCtx(opts: { dryRun?: boolean; runImpl?: (cmd: string, args: string[]) => RunOutput } = {}) {
  const ran: Recorded[] = [];
  const printed: string[] = [];
  const ctx: ExecContext = {
    dryRun: opts.dryRun ?? false,
    print: (l) => printed.push(l),
    run: async (cmd, args) => {
      ran.push({ cmd, args });
      return opts.runImpl ? opts.runImpl(cmd, args) : { code: 0, stdout: '', stderr: '' };
    },
    confirm: async () => false,
    home: '/home/tester',
    now: () => new Date(2026, 9, 1, 20, 0, 0),
  };
  return { ctx, ran, printed };
}

const usage = (p: number, c: number) => ({ prompt_tokens: p, completion_tokens: c, total_tokens: p + c });

/** 脚本化的假模型：按顺序吐出预设回复，并记录收到的消息 */
function fakeChat(replies: Array<Partial<ChatResponse['message']>>): { chat: ChatFn; calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  let i = 0;
  const chat: ChatFn = async (messages) => {
    calls.push(structuredClone(messages));
    const r = replies[Math.min(i++, replies.length - 1)];
    return { message: { role: 'assistant', content: r.content ?? null, tool_calls: r.tool_calls }, usage: usage(1000, 30), finishReason: 'tool_calls' };
  };
  return { chat, calls };
}

const tc = (id: string, name: string, args: unknown) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });

test('缓存：第一次只记候选，第二次相同规划才写入；第三次（含语气词差异）走缓存层、0 token、不调模型', async () => {
  const cache = new MemoryCache();
  const { ctx, ran } = makeCtx();
  const { chat, calls } = fakeChat([{ tool_calls: [tc('1', 'open_app', { name: 'Safari' })] }]);
  const fed: string[] = [];
  const deps = { cache, chat, ctx, feedback: async (t: string) => { fed.push(t); } };

  const r1 = await handle('打开Safari', deps);
  assert.equal(r1.layer, 'llm');
  assert.equal(r1.usage.total_tokens, 1030);
  assert.equal(r1.cached, false, '第一次只记候选');
  assert.equal(r1.cacheCandidate, true);
  assert.equal(cache.get('打开safari'), undefined);
  assert.equal(calls.length, 1, '全部成功时只调一次模型，不再要总结');

  const r2 = await handle('打开 Safari', deps);
  assert.equal(r2.layer, 'llm');
  assert.equal(r2.cached, true, '第二次相同规划 → 转正');
  assert.deepEqual(cache.get('打开safari')?.actions, [{ name: 'open_app', args: { name: 'Safari' } }]);
  assert.equal(cache.get('打开safari')?.toolsVersion, TOOLS_VERSION);

  const r3 = await handle('帮我打开 Safari 吧！', deps);
  assert.equal(r3.layer, 'cache');
  assert.equal(r3.usage.total_tokens, 0);
  assert.equal(r3.llmRounds, 0);
  assert.equal(calls.length, 2, '缓存命中不得再调模型');
  assert.equal(cache.get('打开safari')?.hits, 1);
  assert.equal(ran.filter((x) => x.cmd === 'open').length, 3);
  assert.equal(fed.length, 3);
});

test('缓存：两次规划不同 → 不写入，候选换成最新一次', async () => {
  const cache = new MemoryCache();
  const { ctx } = makeCtx();
  const a = fakeChat([{ tool_calls: [tc('1', 'open_app', { name: 'Safari' })] }]);
  const b = fakeChat([{ tool_calls: [tc('1', 'open_app', { name: 'Google Chrome' })] }]);
  await handle('打开浏览器', { cache, chat: a.chat, ctx, feedback: async () => {} });
  const r2 = await handle('打开浏览器', { cache, chat: b.chat, ctx, feedback: async () => {} });
  assert.equal(r2.cached, false);
  assert.equal(cache.get('打开浏览器'), undefined);
  assert.deepEqual(cache.getCandidate('打开浏览器')?.actions, [{ name: 'open_app', args: { name: 'Google Chrome' } }]);
});

test('缓存：工具表版本号不一致的条目自动作废，重新走模型', async () => {
  const cache = new MemoryCache({ 打开飞书: { sample: '打开飞书', actions: [{ name: 'open_app', args: { name: 'Lark' } }], createdAt: '', hits: 0, toolsVersion: 'old-version' } });
  const { ctx } = makeCtx();
  const { chat, calls } = fakeChat([{ tool_calls: [tc('1', 'open_app', { name: 'Lark' })] }]);
  const r = await handle('打开飞书', { cache, chat, ctx, feedback: async () => {} });
  assert.equal(r.layer, 'llm');
  assert.equal(calls.length, 1);
  assert.equal(cache.get('打开飞书'), undefined, '旧版本条目已删');
  assert.equal(cache.getCandidate('打开飞书')?.toolsVersion, TOOLS_VERSION);
});

test('缓存层不做语义模糊：近义但字面不同的句子不命中', async () => {
  const cache = new MemoryCache({ 打开飞书: { sample: '打开飞书', actions: [{ name: 'open_app', args: { name: 'Lark' } }], createdAt: '', hits: 0, toolsVersion: TOOLS_VERSION } });
  const { ctx } = makeCtx();
  const { chat, calls } = fakeChat([{ content: '好的' }]);
  const r = await handle('启动飞书', { cache, chat, ctx, feedback: async () => {} });
  assert.equal(r.layer, 'llm');
  assert.equal(calls.length, 1);
});

test('unsupported 不进缓存，结果为固定提示', async () => {
  const cache = new MemoryCache();
  const { ctx } = makeCtx({ dryRun: true });
  const { chat } = fakeChat([{ tool_calls: [tc('1', 'unsupported', { user_step: '自己去淘宝搜', reason: '要登录淘宝查订单' })] }]);
  let att: boolean | undefined;
  const r = await handle('帮我查一下我经常买的那个茶', { cache, chat, ctx, feedback: async (_t: string, a: boolean) => { att = a; } });
  assert.equal(r.layer, 'llm');
  assert.match(r.result, /这个需要浏览器智能体，v1 暂不支持/);
  assert.equal(r.cached, false);
  assert.equal(r.attention, true);
  assert.equal(att, true, 'unsupported 必须走对话框');
  assert.equal(cache.keys().length, 0);
});

test('工具失败 → 把错误回给模型重试；跨轮的运行不写缓存', async () => {
  const cache = new MemoryCache();
  const { ctx } = makeCtx();
  const { chat, calls } = fakeChat([
    { tool_calls: [tc('1', 'open_app', { name: '不存在的App' })] },
    { tool_calls: [tc('2', 'open_app', { name: 'Safari' })] },
  ]);
  const r = await handle('打开那个浏览器', { cache, chat, ctx: { ...ctx, run: ctx.run }, feedback: async () => {} });
  assert.equal(calls.length, 2);
  const toolMsg = calls[1].find((m) => m.role === 'tool');
  assert.ok(toolMsg && /没找到应用/.test(String(toolMsg.content)), '第二轮应带上第一轮的失败结果');
  assert.equal(r.cached, false);
  assert.equal(cache.keys().length, 0);
});

test('参数非法 JSON 不执行工具', async () => {
  const cache = new MemoryCache();
  const { ctx, ran } = makeCtx();
  const bad = { id: '1', type: 'function' as const, function: { name: 'open_app', arguments: '{oops' } };
  const { chat } = fakeChat([{ tool_calls: [bad] }, { content: '算了' }]);
  const r = await handle('打开x', { cache, chat, ctx, feedback: async () => {} });
  assert.equal(ran.length, 0);
  assert.equal(r.calls[0].ok, false);
  assert.equal(r.cached, false);
});

test('缓存回放失败 → 作废该条缓存', async () => {
  const cache = new MemoryCache({ 打开飞书: { sample: '打开飞书', actions: [{ name: 'open_app', args: { name: '已卸载的App' } }], createdAt: '', hits: 0, toolsVersion: TOOLS_VERSION } });
  const { ctx } = makeCtx();
  const r = await handle('打开飞书', { cache, chat: null, ctx, feedback: async () => {} });
  assert.equal(r.layer, 'cache');
  assert.equal(cache.get('打开飞书'), undefined);
});

test('无 key 且未命中缓存 → error 层，不抛异常', async () => {
  const { ctx } = makeCtx();
  const r = await handle('现在电量多少', { cache: new MemoryCache(), chat: null, ctx, feedback: async () => {} });
  assert.equal(r.layer, 'error');
  assert.equal(r.result, '这句需要模型才能听懂');
});

test('模型异常（HTTP 错误）→ error 层', async () => {
  const { ctx } = makeCtx();
  const chat: ChatFn = async () => { throw new Error('DeepSeek HTTP 503: busy'); };
  const r = await handle('打开飞书', { cache: new MemoryCache(), chat, ctx, feedback: async () => {} });
  assert.equal(r.layer, 'error');
  assert.match(r.error ?? '', /503/);
});

test('cacheableActions：去掉 notify/speak，只剩反馈则不缓存', () => {
  const ok = { ok: true, display: 'x' };
  assert.deepEqual(
    cacheableActions([
      { call: { name: 'run_shell', args: { command_id: 'disk_free' } }, result: ok, round: 0 },
      { call: { name: 'speak', args: { text: '还剩 100G' } }, result: ok, round: 0 },
    ]),
    [{ name: 'run_shell', args: { command_id: 'disk_free' } }],
  );
  assert.equal(cacheableActions([{ call: { name: 'notify', args: { text: 'hi' } }, result: ok, round: 0 }]), null);
  assert.equal(cacheableActions([{ call: { name: 'open_app', args: {} }, result: { ok: false, display: '' }, round: 0 }]), null);
  assert.equal(cacheableActions([]), null);
});

test('dry-run：副作用工具只打印不执行；不可逆操作打印确认提示', async () => {
  const { ctx, ran, printed } = makeCtx({ dryRun: true });
  const { chat } = fakeChat([{ tool_calls: [tc('1', 'applescript', { action: 'quit_app', params: { name: 'Safari' } })] }]);
  const r = await handle('退出Safari', { cache: new MemoryCache(), chat, ctx, feedback: async () => {} });
  assert.equal(ran.length, 0, 'dry-run 不得执行任何命令');
  assert.ok(printed.some((l) => l.includes('将先弹窗确认')));
  assert.equal(r.calls[0].dryRun, true);
});

test('先做能做的部分：open_url + unsupported 同轮 → 结果说明已做的和剩下要用户做的一步，走对话框', async () => {
  const cache = new MemoryCache();
  const { ctx } = makeCtx({ dryRun: true });
  const { chat, calls } = fakeChat([{ tool_calls: [
    tc('1', 'open_url', { url: 'https://social.example.com/explore' }),
    tc('2', 'unsupported', { user_step: '请扫码登录', reason: '登录需要本人扫码' }),
  ] }]);
  const fed: Array<[string, boolean]> = [];
  const r = await handle('帮我登一下小红书', { cache, chat, ctx, feedback: async (t: string, a: boolean) => { fed.push([t, a]); } });
  assert.equal(calls.length, 1);
  assert.match(r.result, /social\.example\.com/);
  assert.match(r.result, /接下来需要你：请扫码登录/);
  assert.doesNotMatch(r.result, /v1 暂不支持/);
  assert.deepEqual(fed.map((f) => f[1]), [true]);
  assert.equal(cache.keys().length, 0, '含 unsupported 的运行不缓存');
});

test('一般成功走通知（attention=false），失败走对话框', async () => {
  const { ctx } = makeCtx();
  const ok = fakeChat([{ tool_calls: [tc('1', 'open_app', { name: 'Safari' })] }]);
  const fed: boolean[] = [];
  await handle('打开Safari', { cache: new MemoryCache(), chat: ok.chat, ctx, feedback: async (_t: string, a: boolean) => { fed.push(a); } });
  const bad = fakeChat([{ tool_calls: [tc('1', 'open_app', { name: '不存在的App' })] }, { content: '没找到' }]);
  await handle('打开那个', { cache: new MemoryCache(), chat: bad.chat, ctx, feedback: async (_t: string, a: boolean) => { fed.push(a); } });
  assert.deepEqual(fed, [false, true]);
});

test('systemSuffix 拼到 system prompt 末尾', async () => {
  const { ctx } = makeCtx();
  const { chat, calls } = fakeChat([{ content: '好' }]);
  await handle('随便说说', { cache: new MemoryCache(), chat, ctx, feedback: async () => {}, systemSuffix: '本机已安装 App：Lark、WeChat' });
  assert.match(String(calls[0][0].content), /本机已安装 App：Lark、WeChat$/);
});
