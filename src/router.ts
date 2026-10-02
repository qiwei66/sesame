import { normalize } from './normalize.ts';
import { TOOL_MAP, TOOLS_VERSION, confirmOrPlan, isNoCache, needsConfirm, replaySaved, toolDefinitions } from './tools.ts';
import { getConfig } from './config.ts';
import type { Config } from './config.ts';
import { detectLocale, tr, withLocale } from './i18n.ts';
import type { Locale } from './i18n.ts';
import type { CacheStore } from './cache.ts';
import type { ChatFn, ChatMessage } from './llm.ts';
import type { Args, ExecContext, OpenedInfo, RunReport, ToolCall, ToolResult, Usage } from './types.ts';
import { queryCore, searchSaved, shortlist, strongLocalWinner } from './saved.ts';
import { parseQuery } from './query.ts';
import { resolveApp as defaultResolveApp } from './apps.ts';

const ZH_RULES = [
  '「打开/看一下 + 名词」：名词是本机已安装 App（见末尾列表）就 open_app；否则（看板、大盘、页面、报告、手册、试听页、全景、清单等 Claude 交付过的产物）先用 open_saved，它找不到再考虑 open_url。',
  '只用工具做事；优先用 run_shell / applescript 的预定义项。不许编造不存在的 App、网址、命令或结果。',
  '时间一律用相对量：今天 day_offset=0、明天 1；「早上9点」= "09:00"，「下午3点」= "15:00"。',
  '先做能做的部分，再把剩下要用户亲手做的一步交给用户：比如「帮我登一下小红书」= 本机装了对应 App 就 open_app，没装就 open_url 打开它的登录页/官网，同一轮再调用 unsupported，user_step 写「请扫码登录」这类具体动作。查订单、找商品、比价、下单、付款、登录后的操作同理：能打开对应页面就先打开。只有完全没有可做之事时才单独调用 unsupported。App 是否已安装以下面「本机已安装 App」为准，不在列表里的不要 open_app。',
  '删文件用 trash_files；退出 App 用 applescript quit_app。工具会自己弹窗确认，你不用再问。',
  '用户说「读出来/念一下」剪贴板，用 read_clipboard 且 speak_aloud=true。',
  '不要调用 notify 汇报结果，系统会自动把工具结果通知给用户。',
];

const EN_RULES = [
  '"open / show me + noun": if the noun is an installed app (see the list at the end) use open_app; otherwise (dashboards, pages, reports, manuals, previews — artifacts delivered earlier in Claude Code / Codex) use open_saved first, and only consider open_url if it finds nothing.',
  'Only act through tools; prefer the predefined run_shell / applescript items. Never invent apps, URLs, commands or results.',
  'Times are relative: today day_offset=0, tomorrow 1; "9am" = "09:00", "3pm" = "15:00".',
  'Do what you can, then hand the remaining manual step to the user via unsupported in the same turn (e.g. open the login page, then user_step "please sign in"). Only call unsupported alone when nothing at all can be done. Only open_app apps that are in the installed list.',
  'Delete files with trash_files; quit apps with applescript quit_app. The tools ask for confirmation themselves.',
  'For "read it out" on the clipboard use read_clipboard with speak_aloud=true.',
  'Do not call notify to report results; results are shown to the user automatically.',
];

/**
 * System prompt = fixed rules + personal parts from config (user_name, prompt_rules, known_urls).
 * Kept byte-stable for a given config so the provider's prompt-prefix cache keeps hitting.
 */
export function buildSystemPrompt(cfg: Pick<Config, 'user_name' | 'prompt_rules' | 'known_urls'>, locale: Locale = 'zh'): string {
  const rules = [...(locale === 'en' ? EN_RULES : ZH_RULES), ...cfg.prompt_rules].map((r, i) => `${i}. ${r}`).join('\n');
  if (locale === 'en') {
    const who = cfg.user_name ? `${cfg.user_name}'s` : 'the user\'s';
    const urls = cfg.known_urls.length
      ? `Known URLs (only these; never guess others):\n${cfg.known_urls.map((u) => `- ${u.name} ${u.url}`).join('\n')}`
      : 'Known URLs: none — never guess a URL; only open URLs the user spells out or that open_saved finds.';
    return `You are ${who} Mac voice command assistant. The input comes from speech-to-text and may contain recognition errors.
Complete the task with the provided tools, calling every tool you need in one go; no chit-chat, no questions back.
Rules:
${rules}
${urls}`;
  }
  const who = cfg.user_name ? `${cfg.user_name} 的` : '用户的';
  const urls = cfg.known_urls.length
    ? `已知网址（只能用这些，不在表里的不要猜）：\n${cfg.known_urls.map((u) => `- ${u.name} ${u.url}`).join('\n')}`
    : '已知网址：无（不要猜网址；只打开用户说出的完整网址或 open_saved 找到的产物）';
  return `你是${cfg.user_name ? ' ' : ''}${who} Mac 语音指令助手。用户的话来自语音转写，可能有错别字或口语。
用提供的工具完成任务，一次性调用完所需的全部工具，不要闲聊、不要反问。
规则：
${rules}
${urls}`;
}

/** Back-compat: prompt for the active config, zh */
export function systemPrompt(locale?: Locale): string {
  const cfg = getConfig();
  return buildSystemPrompt(cfg, locale ?? 'zh');
}

export const UNSUPPORTED_TEXT = '这个需要浏览器智能体，v1 暂不支持';
export const UNSUPPORTED_TEXT_EN = 'This needs a browser agent, which v1 does not support yet';
const SEP = () => tr('；', '; ');

/** 结果是否需要用户注意（unsupported / 有失败 / 需要用户动手）→ 用不自动消失的对话框 */
export function needsAttention(calls: Array<{ result: ToolResult }>, layer: string): boolean {
  if (layer === 'error') return true;
  if (calls.length === 0) return true;
  return calls.some((c) => !c.result.ok || c.result.unsupported || Boolean(c.result.choices?.length));
}

const ZH_OPEN = /^(?:请|麻烦|帮我|给我|替我)?\s*(?:打开|开一下|开下|看一下|看下|看看|瞧瞧|找一下|找出来|找到|找|调出来|调出|显示|翻出来|翻一下)/;
const EN_OPEN = /^(?:please\s+)?(?:open|show me|show|pull up|bring up|find|go to|look at|launch)\b/i;

/** "打开交易大盘" → { query: "交易大盘", verb: true }; no open verb → the whole sentence, verb: false */
export function openQuery(input: string): { query: string; verb: boolean } {
  const t = input.trim();
  const m = ZH_OPEN.exec(t) ?? EN_OPEN.exec(t);
  if (!m) return { query: t, verb: false };
  return { query: t.slice(m[0].length).trim(), verb: true };
}

export interface RouterDeps {
  cache: CacheStore;
  chat: ChatFn | null;
  ctx: ExecContext;
  /** 最终反馈（通知/朗读）；dry-run 下由调用方决定只打印 */
  feedback: (text: string, attention: boolean) => Promise<void>;
  /** 追加到 system prompt 末尾的本机信息（如已安装 App 列表），保持稳定以命中模型前缀缓存 */
  systemSuffix?: string | ((locale: Locale) => string);
  maxRounds?: number;
  /** Installed-app lookup (tests inject one); an app name is never answered from the saved-item index */
  resolveApp?: (name: string) => string | null;
}

const zeroUsage = (): Usage => ({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0 });

function addUsage(a: Usage, b: Usage | undefined): Usage {
  if (!b) return a;
  return {
    prompt_tokens: a.prompt_tokens + (b.prompt_tokens ?? 0),
    completion_tokens: a.completion_tokens + (b.completion_tokens ?? 0),
    total_tokens: a.total_tokens + (b.total_tokens ?? 0),
    prompt_cache_hit_tokens: (a.prompt_cache_hit_tokens ?? 0) + (b.prompt_cache_hit_tokens ?? 0),
    prompt_cache_miss_tokens: (a.prompt_cache_miss_tokens ?? 0) + (b.prompt_cache_miss_tokens ?? 0),
  };
}

async function execTool(call: ToolCall, ctx: ExecContext): Promise<ToolResult> {
  // the client cancelled (panel closed with Esc): nothing more runs, nothing opens a few seconds later
  if (ctx.signal?.aborted) return { ok: false, display: tr('已取消', 'Cancelled'), noCache: true };
  const spec = TOOL_MAP[call.name];
  if (!spec) return { ok: false, display: tr(`未知工具：${call.name}`, `Unknown tool: ${call.name}`) };
  try {
    // 缓存回放 open_saved：直接打开当时选中的那一项，打不开再回退到检索
    if (call.name === 'open_saved' && call.savedKey) return await replaySaved(String(call.args.query ?? ''), call.savedKey, ctx);
    // Generic confirmation gate for skills that declare needsConfirm but do not ask by themselves
    if (needsConfirm(call) && !spec.confirmHandled) {
      const what = `${call.name} ${JSON.stringify(call.args)}`;
      const c = await confirmOrPlan(ctx, tr(`确定要执行 ${spec.name} 吗？`, `Run ${spec.name}?`), what);
      if (c === 'dry') return { ok: true, display: tr(`（演练）确认后执行 ${spec.name}`, `(dry run) after confirmation: run ${spec.name}`), dryRun: true };
      if (c === 'no') return { ok: true, display: tr(`已取消：${spec.name}`, `Cancelled: ${spec.name}`), noCache: true };
    }
    return await spec.exec(call.args, ctx);
  } catch (e) {
    return { ok: false, display: tr(`${call.name} 出错：${(e as Error).message}`, `${call.name} failed: ${(e as Error).message}`) };
  }
}

/**
 * 决定一次成功的 LLM 运行能否进缓存：只要「第一轮就规划完、全部成功、不含 noCache 工具/结果」的动作，去掉纯反馈工具。
 * open_saved 记下当时选中项的 key（savedKey），回放时直接打开。
 * 注意：这里只决定「能不能」；真正写入要同一句话第二次得到相同规划（CacheStore.propose）。
 */
export function cacheableActions(calls: Array<{ call: ToolCall; result: ToolResult; round: number }>): ToolCall[] | null {
  if (calls.length === 0) return null;
  if (calls.some((c) => c.round !== 0 || !c.result.ok || c.result.unsupported || c.result.noCache)) return null;
  if (calls.some((c) => isNoCache(c.call))) return null;
  const actions = calls.filter((c) => !TOOL_MAP[c.call.name]?.feedbackOnly).map((c) => {
    const data = c.result.data;
    const key = c.call.name === 'open_saved' && data && typeof data === 'object' && !Array.isArray(data) && typeof data.key === 'string' ? data.key : undefined;
    return key ? { ...c.call, savedKey: key } : { ...c.call };
  });
  return actions.length ? actions : null;
}

function resultText(calls: Array<{ call: ToolCall; result: ToolResult }>): string {
  const unsupported = calls.find((c) => c.result.unsupported);
  if (unsupported) {
    const done = calls.filter((c) => c !== unsupported && c.result.ok && !TOOL_MAP[c.call.name]?.feedbackOnly && !c.result.unsupported).map((c) => c.result.display);
    const step = String(unsupported.call.args.user_step ?? '').trim();
    const reason = String(unsupported.call.args.reason ?? '').trim();
    if (done.length) return tr(`${done.join('；')}。接下来需要你：${step || reason || '手动完成剩下的操作'}`, `${done.join('; ')}. Your turn: ${step || reason || 'finish the rest manually'}`);
    const failed = calls.filter((c) => !c.result.ok).map((c) => c.result.display);
    if (failed.length) return tr(`${failed.join('；')}${step ? `。你可以：${step}` : ''}`, `${failed.join('; ')}${step ? `. You can: ${step}` : ''}`);
    return tr(`${UNSUPPORTED_TEXT}${reason ? `（${reason}）` : ''}${step ? `。你可以：${step}` : ''}`, `${UNSUPPORTED_TEXT_EN}${reason ? ` (${reason})` : ''}${step ? `. You can: ${step}` : ''}`);
  }
  const main = calls.filter((c) => !TOOL_MAP[c.call.name]?.feedbackOnly).map((c) => c.result.display);
  if (main.length) return main.join(SEP());
  return calls.map((c) => c.result.display).join(SEP());
}

function parseArgs(raw: string): Args | null {
  try {
    const v = JSON.parse(raw || '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Args) : null;
  } catch {
    return null;
  }
}

/** Handle one sentence; user-facing strings follow the sentence's language (or config.locale) */
export function handle(input: string, deps: RouterDeps): Promise<RunReport> {
  return withLocale(detectLocale(input, getConfig().locale), () => handleInner(input, deps));
}

async function handleInner(input: string, deps: RouterDeps): Promise<RunReport> {
  const t0 = Date.now();
  const { ctx, cache } = deps;
  const normalized = normalize(input);
  const report: RunReport = {
    input, normalized, layer: 'error', dryRun: ctx.dryRun, calls: [], usage: zeroUsage(), llmRounds: 0, durationMs: 0, result: '', cached: false, attention: false,
  };
  const results: ToolResult[] = [];
  const track = (r: ToolResult): ToolResult => { results.push(r); return r; };
  const finish = async (r: RunReport, opts: { feedback: boolean }): Promise<RunReport> => {
    r.durationMs = Date.now() - t0;
    const opened = [...results].reverse().find((x) => x.ok && x.opened)?.opened;
    if (opened) r.opened = opened;
    const choices = results.find((x) => x.choices?.length)?.choices;
    if (choices) r.candidates = choices;
    if (ctx.signal?.aborted) { r.cancelled = true; return r; }
    r.attention = r.attention || r.layer === 'error';
    if (opts.feedback && r.result) await deps.feedback(r.result, r.attention);
    return r;
  };

  if (!normalized) {
    report.error = '空指令';
    report.result = tr('没听清，再说一次？', "Didn't catch that — say it again?");
    return finish(report, { feedback: true });
  }

  // ── 第 1 层：缓存（0 模型调用）──
  let hit = cache.get(normalized);
  if (hit && hit.toolsVersion !== TOOLS_VERSION) {
    // 工具定义变了（加/改工具、白名单、描述）→ 旧规划可能已不成立，作废重来
    cache.delete(normalized);
    hit = undefined;
  }
  if (hit) {
    report.layer = 'cache';
    const done: Array<{ call: ToolCall; result: ToolResult }> = [];
    for (const call of hit.actions) {
      const result = track(await execTool(call, ctx));
      report.usage = addUsage(report.usage, result.usage);
      done.push({ call, result });
      report.calls.push({ name: call.name, args: call.args, ok: result.ok, display: result.display, dryRun: result.dryRun, opened: result.opened });
    }
    report.result = resultText(done);
    report.attention = needsAttention(done, 'cache');
    if (done.some((d) => !d.result.ok)) {
      // 回放失败（App 被删、目录变了…）→ 作废这条缓存，下次重新走模型
      cache.delete(normalized);
      report.error = 'cache replay failed; entry evicted';
    } else {
      cache.touch(normalized, ctx.now().toISOString());
    }
    return finish(report, { feedback: true });
  }

  // ── 第 1.5 层：本地索引（0 模型调用）──
  // 说的就是某个产物的名字 / 别名，或「打开 X」且本地检索明显领先 → 直接打开，不问模型。
  // 没配模型时这是主路径：明显领先就打开，分不清就把候选交给用户选，App 名直接打开。
  const local = await localFirst(input, deps, report, track);
  if (local) return finish(local, { feedback: true });

  // ── 第 2 层：模型工具调用（provider 见 providers.ts）──
  if (!deps.chat) {
    const { query, verb } = openQuery(input);
    report.error = 'no_model';
    const pq = query ? parseQuery(query, ctx.now()) : null;
    // "open X", or a sentence that asks for a kind of thing / a time ("昨天的报告", "上周的周报"): a miss, not a command
    if (query && (verb || (pq && (pq.types.length > 0 || pq.time !== null)))) {
      report.result = tr(`没找到「${query}」`, `Nothing called "${query}" found`);
      report.need = tr('换个说法，或者说出它标题里的一个词。没配模型也能用；配上后能听懂更模糊的说法', 'Try other words, or a word from its title. Works without a model; with one it understands vaguer requests');
    } else {
      report.result = tr('这句需要模型才能听懂', 'This one needs a model to understand');
      report.need = tr('没配模型也能用：说「打开」加上产物的名字。配上模型后能听懂更模糊的说法，也能做系统操作（设置 → 模型）', 'Works without a model: say "open" plus the name. With a model it understands vaguer requests and can run system actions (Settings → Model)');
    }
    return finish(report, { feedback: true });
  }
  if (ctx.signal?.aborted) { report.error = 'cancelled'; report.result = tr('已取消', 'Cancelled'); return finish(report, { feedback: false }); }
  report.layer = 'llm';
  const locale: Locale = detectLocale(input, getConfig().locale);
  const tools = toolDefinitions(locale);
  const prompt = buildSystemPrompt(getConfig(), locale);
  const suffix = typeof deps.systemSuffix === 'function' ? deps.systemSuffix(locale) : deps.systemSuffix;
  const messages: ChatMessage[] = [
    { role: 'system', content: suffix ? `${prompt}\n${suffix}` : prompt },
    { role: 'user', content: input },
  ];
  const all: Array<{ call: ToolCall; result: ToolResult; round: number }> = [];
  const maxRounds = deps.maxRounds ?? 3;
  let modelText = '';
  try {
    for (let round = 0; round < maxRounds; round++) {
      const resp = await deps.chat(messages, tools);
      report.llmRounds += 1;
      report.usage = addUsage(report.usage, resp.usage);
      const tcs = resp.message.tool_calls ?? [];
      if (tcs.length === 0) {
        modelText = (resp.message.content ?? '').trim();
        break;
      }
      messages.push({ role: 'assistant', content: resp.message.content ?? '', tool_calls: tcs });
      const roundResults: ToolResult[] = [];
      for (const tc of tcs) {
        const args = parseArgs(tc.function.arguments);
        const call: ToolCall = { name: tc.function.name, args: args ?? {} };
        const result = track(args ? await execTool(call, ctx) : { ok: false, display: tr(`参数不是合法 JSON：${tc.function.arguments.slice(0, 120)}`, `Arguments are not valid JSON: ${tc.function.arguments.slice(0, 120)}`) });
        all.push({ call, result, round });
        report.usage = addUsage(report.usage, result.usage);
        roundResults.push(result);
        report.calls.push({ name: call.name, args: call.args, ok: result.ok, display: result.display, dryRun: result.dryRun, opened: result.opened });
        // 数据最小化：工具给了 modelDisplay/modelData 就只把它们发给模型（剪贴板全文、完整路径不出本机）
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ ok: result.ok, result: result.modelDisplay ?? result.display, data: (result.modelData !== undefined ? result.modelData : result.data) ?? null }) });
      }
      // 省 token：本轮全部成功就直接用工具结果收尾，不再让模型「总结一句」
      if (roundResults.every((r) => r.ok)) break;
    }
  } catch (e) {
    report.layer = 'error';
    report.error = (e as Error).message;
    report.result = tr(`模型调用失败：${(e as Error).message.slice(0, 120)}`, `Model call failed: ${(e as Error).message.slice(0, 120)}`);
    return finish(report, { feedback: true });
  }

  report.result = all.length ? resultText(all) : modelText || tr('没理解这句话，换个说法试试？', "Didn't understand that — try saying it differently?");
  if (all.length && all.every((a) => !a.result.ok)) report.error = 'all tool calls failed';
  report.attention = needsAttention(all, report.layer);

  const actions = cacheableActions(all);
  if (actions) {
    // 同一句话第二次得到相同规划才写入；第一次只记候选（防一次性的偶然规划/测试句污染缓存）
    const st = cache.propose(normalized, { sample: input, actions, createdAt: ctx.now().toISOString(), hits: 0, toolsVersion: TOOLS_VERSION });
    report.cached = st === 'confirmed';
    report.cacheCandidate = st === 'candidate';
  }
  // 模型自己调过 notify/speak 就不再重复通知
  const selfFed = all.some((a) => TOOL_MAP[a.call.name]?.feedbackOnly && a.result.ok);
  return finish(report, { feedback: !selfFed });
}

/**
 * Local-index answer without the model. Returns the finished report, or null to fall through to the model.
 *  - with a model: only when the sentence is a name (alias / exact title) or "open X" with a big local lead
 *  - without a model: "open <app>" opens the app; otherwise a clear local winner opens, close matches become candidates
 */
async function localFirst(input: string, deps: RouterDeps, report: RunReport, track: (r: ToolResult) => ToolResult): Promise<RunReport | null> {
  const { ctx } = deps;
  if (!ctx.saved && deps.chat) return null;
  const { query, verb } = openQuery(input);
  if (!query) return null;
  const appOf = deps.resolveApp ?? ((n: string) => { try { return defaultResolveApp(n); } catch { return null; } });
  const app = verb ? appOf(query) : null;
  const run = async (call: ToolCall, how: string): Promise<RunReport> => {
    report.layer = 'local';
    const result = track(await execTool(call, ctx));
    report.calls.push({ name: call.name, args: call.args, ok: result.ok, display: result.display, dryRun: result.dryRun, opened: result.opened });
    report.result = result.display;
    report.attention = needsAttention([{ result }], 'local');
    if (!result.ok) report.error = 'local open failed';
    void how;
    return report;
  };
  if (app) {
    if (deps.chat) return null; // an app name: the model (open_app / quit_app …) decides
    return run({ name: 'open_app', args: { name: query } }, 'local: app name');
  }
  if (!ctx.saved) return null;
  const cands = searchSaved(query, ctx.saved.items(), ctx.saved.aliases(), ctx.now());
  const core = queryCore(query);
  const win = strongLocalWinner(cands, core, Boolean(deps.chat));
  if (win && (verb || !deps.chat || win.aliasHit || queryCore(win.item.title) === core)) {
    // open_saved runs its own search again and lands on the same winner (same query, same index)
    return run({ name: 'open_saved', args: { query } }, 'local: clear winner');
  }
  if (deps.chat) return null;
  if (shortlist(cands).length === 0) return null; // nothing close enough to list: say so (no filler candidates)
  // no model: hand the close matches to the user (RPC) or the chooser (CLI)
  return run({ name: 'open_saved', args: { query } }, 'local: candidates');
}

export type { OpenedInfo };
