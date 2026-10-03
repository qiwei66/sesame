/** open_saved / save_alias: open artifacts previously delivered in Claude Code / Codex conversations (local index) */
import { outLocale, tr } from '../../src/i18n.ts';
import type { ExecContext, ToolResult, ToolSpec, Usage } from '../../src/types.ts';
import { obj, str } from '../../src/tool-helpers.ts';
import { searchSaved, decide, shortlist, describeForModel, queryCore, REFRESH_BELOW, specificHits, isWeakWeb, displayTitle, openedInfo } from '../../src/saved.ts';
import type { Candidate } from '../../src/saved.ts';
import type { SavedItem } from '../../src/indexer.ts';

export const openSavedTool: ToolSpec = {
  name: 'open_saved',
  description: '打开 Claude 以前交付过的产物：看板、页面、报告、手册、试听页、本机服务、发过的文件等（例：「打开交易大盘」「看一下项目全景」）。query 填用户说的名词',
  parameters: obj({ query: { type: 'string', description: '要找的产物：照抄用户原话里的名词短语，连「官网/看板/手册」这类词一起保留，如「咖啡店的官网」「交易大盘」；听写错字也照抄，不要自己改' } }, ['query']),
  readOnly: false,
  async exec(a, ctx) {
    return openSaved(str(a.query), ctx);
  },
};


export const saveAliasTool: ToolSpec = {
  name: 'save_alias',
  description: '给已索引的产物起别名，下次说别名就能打开。「把刚才打开的那个记成 X」→ alias=X、target 省略；「把 <网址或标题> 记成 X」→ target 填网址或标题',
  parameters: obj({
    alias: { type: 'string', description: '别名，如「大盘」' },
    target: { type: 'string', description: '网址或标题；省略表示刚才打开的那个' },
  }, ['alias']),
  readOnly: false,
  cachePolicy: 'never', // 别名是一次性写操作，回放没有意义还会重复写
  async exec(a, ctx) {
    return saveAlias(str(a.alias), str(a.target), ctx);
  },
};



const KIND_CN: Record<string, string> = { artifact: 'Claude 页面', local: '本机服务', web: '网页', file: '文件' };
const KIND_EN: Record<string, string> = { artifact: 'Claude page', local: 'local service', web: 'web page', file: 'file' };

function label(it: SavedItem): string {
  if (outLocale() === 'en') return `${displayTitle(it)} (${KIND_EN[it.kind] ?? it.kind})`;
  return `${displayTitle(it)}（${KIND_CN[it.kind] ?? it.kind}）`;
}

/** Open one indexed item on this Mac (also used by `va mcp` open_artifact) */
export async function openItem(it: SavedItem, ctx: ExecContext, how: string, usage?: Usage): Promise<ToolResult> {
  const target = it.url;
  const auth = it.needsAuth ? tr('（原链接带鉴权参数，已去掉，可能需要重新登录）', ' (auth parameters were stripped; you may need to sign in again)') : '';
  if (ctx.dryRun) {
    ctx.print(tr(`[DRY-RUN] open_saved 选中（${how}）：${label(it)} → open ${target}`, `[DRY-RUN] open_saved picked (${how}): ${label(it)} → open ${target}`));
    return { ok: true, display: tr(`（演练）打开 ${label(it)}${auth}`, `(dry run) open ${label(it)}${auth}`), dryRun: true, usage, data: { key: it.key, how }, opened: openedInfo(it) };
  }
  const r = await ctx.run('open', [target]);
  if (r.code !== 0) return { ok: false, display: tr(`打开 ${label(it)} 失败：${r.stderr.trim()}`, `Failed to open ${label(it)}: ${r.stderr.trim()}`), usage };
  ctx.saved?.setLastOpened(it.key);
  return { ok: true, display: tr(`已打开 ${label(it)}${auth}`, `Opened ${label(it)}${auth}`), usage, data: { key: it.key, how }, opened: openedInfo(it) };
}

export async function openSaved(query: string, ctx: ExecContext): Promise<ToolResult> {
  if (!ctx.saved) return { ok: false, display: tr('索引不可用（先跑 va-index）', 'Index not available (run va-index first)') };
  let cands = searchSaved(query, ctx.saved.items(), ctx.saved.aliases(), ctx.now());
  // 没命中或分数偏低：可能是刚在对话里出现的新链接 → 同步跑一次增量索引（限时）再查
  if ((shortlist(cands).length === 0 || cands[0].score < REFRESH_BELOW) && ctx.refreshSaved) {
    const done = await ctx.refreshSaved();
    if (done) {
      ctx.saved.reload();
      cands = searchSaved(query, ctx.saved.items(), ctx.saved.aliases(), ctx.now());
    }
  }
  const win = decide(cands);
  if (win) return openItem(win.item, ctx, win.aliasHit ? '别名' : tr('本地检索明显领先', 'clear local winner'));
  // no model to pick: only close matches (every noun in the name) are offered; none → say so, no filler candidates
  if (!ctx.pick) cands = shortlist(cands);
  if (cands.length === 0) return { ok: false, display: tr(`没在以前的对话里找到「${query}」`, `Nothing called "${query}" found in past conversations`) };
  let usage: Usage | undefined;
  // 无标题、只出现过一次的网页不发给模型（多半是噪声，且发出去只剩一个空标题）；只留给本机列表让用户自己选
  const forModel = cands.filter((c) => !isWeakWeb(c.item));
  if (ctx.pick && forModel.length) {
    const p = await ctx.pick(query, describeForModel(forModel));
    usage = p.usage;
    if (p.index !== null && p.index >= 1 && p.index <= forModel.length) return openItem(forModel[p.index - 1].item, ctx, tr('模型挑选', 'picked by model'), usage);
    if (p.index === -1) {
      // 模型说都不像，但有候选在具体词（如「门店」）上对得上 → 让用户自己选，不直接判失败（语音听写常有错字）
      const spec = specificHits(query, cands);
      if (spec.length === 0) return { ok: false, display: tr(`找到几个相近的，但都不像「${query}」：${cands.map((c) => c.item.title).join('、')}`, `Found similar items, but none looks like "${query}": ${cands.map((c) => c.item.title).join(', ')}`), usage };
      cands = spec;
    }
  }
  // 分不清 → 让用户选
  // 列表只在本机弹给用户看，可以带域名/文件名帮助辨认（不发给模型）
  const options = cands.map((c) => {
    const it = c.item;
    let hint = '';
    if (it.kind === 'web' || it.kind === 'local') { try { hint = ` · ${new URL(it.url).host}`; } catch { hint = ''; } }
    else if (it.kind === 'file') hint = ` · ${it.url.split('/').pop()}`;
    return `${label(it)}${hint}`;
  });
  const choices = cands.map((c: Candidate) => openedInfo(c.item, c.score));
  if (ctx.dryRun) {
    ctx.print(tr(`[DRY-RUN] 分不清，将弹出列表让你选：${options.join(' / ')}`, `[DRY-RUN] ambiguous, would show a list to choose from: ${options.join(' / ')}`));
    return { ok: true, display: tr(`（演练）让你从 ${options.length} 个候选里选`, `(dry run) ask you to pick one of ${options.length} candidates`), dryRun: true, usage, noCache: true, choices };
  }
  // 没有本机选择框（RPC：界面自己列候选）→ 把候选交回去
  if (!ctx.choose) return { ok: true, display: tr(`找到 ${cands.length} 个相近的，选一个`, `Found ${cands.length} close matches, pick one`), usage, noCache: true, choices };
  const idx = ctx.choose ? await ctx.choose(tr(`「${query}」是哪个？`, `Which one is "${query}"?`), options) : null;
  if (idx === null || idx < 0 || idx >= cands.length) return { ok: true, display: tr('已取消', 'Cancelled'), usage, noCache: true };
  return openItem(cands[idx].item, ctx, tr('用户选择', 'picked by you'), usage);
}

/** 缓存回放：直接打开当时选中的那一项；索引里没了或打不开 → 回退到正常检索 */
export async function replaySaved(query: string, key: string, ctx: ExecContext): Promise<ToolResult> {
  const it = ctx.saved?.items().find((i) => i.key === key);
  if (it) {
    const r = await openItem(it, ctx, tr('缓存回放', 'cache replay'));
    if (r.ok) return r;
  }
  return openSaved(query, ctx);
}

export async function saveAlias(alias: string, target: string, ctx: ExecContext): Promise<ToolResult> {
  if (!ctx.saved) return { ok: false, display: tr('索引不可用（先跑 va-index）', 'Index not available (run va-index first)') };
  const a = queryCore(alias);
  if (a.length < 1) return { ok: false, display: tr('别名不能为空', 'Alias cannot be empty') };
  let key: string | null = null;
  const items = ctx.saved.items();
  if (!target) {
    key = ctx.saved.lastOpened();
    if (!key) return { ok: false, display: tr('还没通过 Sesame 打开过产物，不知道「刚才那个」是哪个', 'Nothing has been opened through Sesame yet, so "that one" is unknown') };
  } else {
    const byUrl = items.find((i) => i.url === target || i.variants.includes(target));
    key = byUrl?.key ?? searchSaved(target, items, ctx.saved.aliases(), ctx.now())[0]?.item.key ?? null;
  }
  const it = items.find((i) => i.key === key);
  if (!key || !it) return { ok: false, display: tr(`没找到要记的产物：${target || '刚才那个'}`, `Could not find what to remember: ${target || 'the last opened item'}`) };
  if (ctx.dryRun) {
    ctx.print(tr(`[DRY-RUN] 将把「${alias}」记为 ${label(it)}`, `[DRY-RUN] would remember "${alias}" = ${label(it)}`));
    return { ok: true, display: tr(`（演练）记住「${alias}」= ${label(it)}`, `(dry run) remember "${alias}" = ${label(it)}`), dryRun: true };
  }
  ctx.saved.setAlias(alias, key);
  return { ok: true, display: tr(`记住了：「${alias}」= ${label(it)}`, `Remembered: "${alias}" = ${label(it)}`) };
}
