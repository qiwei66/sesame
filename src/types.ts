export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Args = Record<string, Json>;

export interface ToolCall {
  name: string;
  args: Args;
  /** 仅缓存里有：open_saved 当时选中项的 key，回放时直接打开它，打不开再回退到检索（不发给模型） */
  savedKey?: string;
}

export interface ToolResult {
  ok: boolean;
  /** 给人看的一句话结果（通知/朗读/缓存回放用） */
  display: string;
  /** 回传给模型的原始结果（可选） */
  data?: Json;
  /** dry-run 下只打印、未真执行 */
  dryRun?: boolean;
  /** 标记为「v1 不支持」 */
  unsupported?: boolean;
  /** 工具内部额外的模型调用用量（如 open_saved 让模型挑候选） */
  usage?: Usage;
  /** 这次结果不该进缓存（如用户取消、只是弹了候选列表） */
  noCache?: boolean;
  /** 进入下一轮模型请求时给模型看的版本（数据最小化）；缺省用 display / data */
  modelDisplay?: string;
  modelData?: Json;
  /** What was actually opened (open_saved / open_url / open_app), for the UI's success card. Never sent to the model */
  opened?: OpenedInfo;
  /** open_saved could not pick one and no chooser is available (RPC): the candidates, for the UI to list */
  choices?: OpenedInfo[];
}

/** Structured description of an opened (or candidate) item; title already has the empty-title fallback applied */
export interface OpenedInfo {
  key?: string;
  title: string;
  url: string;
  /** artifact | local | web | file | app */
  kind: string;
  lastSeen?: string;
  firstSeen?: string;
  session?: string;
  score?: number;
}

export interface PickResult { index: number | null; usage?: Usage }

export interface RunOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string, args: string[], opts?: { timeoutMs?: number; input?: string }) => Promise<RunOutput>;

export interface ExecContext {
  dryRun: boolean;
  /** 不可逆操作前弹窗确认；返回 true = 用户点了确认 */
  confirm: (message: string) => Promise<boolean>;
  /** dry-run 计划输出 */
  print: (line: string) => void;
  run: Runner;
  home: string;
  now: () => Date;
  /** open_saved 用：已索引的 Claude 产物 */
  saved?: import('./saved.ts').SavedStore;
  /** 让模型在候选里挑一项：返回 1-based 序号；0 = 分不清；-1 = 都不对；null = 模型不可用 */
  pick?: (query: string, candidates: string) => Promise<PickResult>;
  /** 查询时按需增量刷新索引（限时）；返回是否刷新完成 */
  refreshSaved?: () => Promise<boolean>;
  /** 让用户从列表里选（AppleScript choose from list）；返回 0-based 下标或 null。未提供（RPC）= open_saved 把候选交回给 UI */
  choose?: (prompt: string, options: string[]) => Promise<number | null>;
  /** Aborted when the client cancels the request (RPC `cancel`): no further tool runs after that */
  signal?: AbortSignal;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
  /** 只读工具：dry-run 下仍然真执行（不改变任何状态） */
  readOnly: boolean;
  /** 纯反馈工具（notify/speak）：不写进缓存，回放时由各动作的 display 重新生成反馈 */
  feedbackOnly?: boolean;
  /** @deprecated use cachePolicy: 'never'. 不进缓存；函数形式按参数判断 */
  noCache?: boolean | ((args: Args) => boolean);
  /**
   * Cache policy for a successful plan that contains this tool:
   *  - 'auto' (default): cacheable (written after the same sentence yields the same plan twice)
   *  - 'never': one-shot side effects (reminders, aliases) or hand-offs — never replayed from cache
   * Function form decides per call (e.g. applescript create_reminder).
   */
  cachePolicy?: CachePolicy | ((args: Args) => CachePolicy);
  /**
   * Irreversible / user-visible side effect that needs an explicit yes (shown in intent previews).
   * If the tool does NOT ask by itself (confirmHandled !== true), the router asks via ctx.confirm before exec.
   */
  needsConfirm?: boolean | ((args: Args) => boolean);
  /** The tool already calls confirmOrPlan internally (so the router must not ask twice) */
  confirmHandled?: boolean;
  /** Which input languages this tool is offered for; default 'all' */
  locale?: 'zh' | 'en' | 'all';
  /** Where it came from (builtin | user:<file> | command:<file>) — for doctor / RPC */
  origin?: string;
  exec: (args: Args, ctx: ExecContext) => Promise<ToolResult>;
}

export type CachePolicy = 'auto' | 'never';

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

/** cache = literal cache replay · local = answered by the local index without the model · llm = model tool call · error */
export type Layer = 'cache' | 'local' | 'llm' | 'error';

export interface RunReport {
  input: string;
  normalized: string;
  layer: Layer;
  dryRun: boolean;
  calls: Array<{ name: string; args: Args; ok: boolean; display: string; dryRun?: boolean; opened?: OpenedInfo }>;
  /** The item actually opened (last successful open_* call) */
  opened?: OpenedInfo;
  /** open_saved left the choice to the user (no chooser / no model) */
  candidates?: OpenedInfo[];
  /** The request was cancelled by the client before it finished */
  cancelled?: boolean;
  /** What the user can do next (human sentence), when the answer is a miss */
  need?: string;
  usage: Usage;
  llmRounds: number;
  durationMs: number;
  result: string;
  /** 本次规划已写入缓存（同一句第二次得到相同规划） */
  cached: boolean;
  /** 本次规划只记成了缓存候选（第一次见到） */
  cacheCandidate?: boolean;
  /** true = 需要用户注意（用对话框而不是会消失的通知） */
  attention: boolean;
  error?: string;
}
