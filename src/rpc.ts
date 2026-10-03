/**
 * `va serve --stdio`: JSON-RPC 2.0 over stdin/stdout, one JSON object per line (NDJSON framing).
 * Methods: handle, cancel, search, sample, index, indexStatus, doctor (+ ping). Contract: docs/rpc.md.
 * stdout carries ONLY protocol messages; diagnostics go to stderr.
 */
import { createInterface } from 'node:readline';
import type { Runtime } from './runtime.ts';
import { costLabel } from './runtime.ts';
import { openedInfo, searchLive, searchSaved } from './saved.ts';
import type { IndexService } from './index-service.ts';
import { TOOL_MAP, needsConfirm } from './tools.ts';
import { collectChecks } from './doctor.ts';
import { pickSample } from './title-quality.ts';
import type { RunReport, Runner } from './types.ts';

export const RPC_VERSION = 1;

export interface RpcRequest { jsonrpc: '2.0'; id?: number | string | null; method: string; params?: Record<string, unknown> }
export interface RpcResponse { jsonrpc: '2.0'; id: number | string | null; result?: unknown; error?: { code: number; message: string; data?: unknown } }

export interface IntentStep { tool: string; args: Record<string, unknown>; needsConfirm: boolean; readOnly: boolean; origin: string | null }
export interface ResultCard { title: string; detail: string; tool: string; ok: boolean; dryRun: boolean; attention: boolean }

/** Structured view of one handled sentence, for UIs */
export function toHandleResult(r: RunReport, rt: Pick<Runtime, 'provider'>, planLines: string[], extra: { needsConfirmation?: { message: string } | null } = {}): Record<string, unknown> {
  const intent: IntentStep[] = r.calls.map((c) => {
    const spec = TOOL_MAP[c.name];
    return { tool: c.name, args: c.args, needsConfirm: needsConfirm({ name: c.name, args: c.args }), readOnly: Boolean(spec?.readOnly), origin: spec?.origin ?? null };
  });
  // card.detail is a human sentence (what the user can do next), never an internal error code
  const cards: ResultCard[] = r.calls.length
    ? r.calls.map((c) => ({ title: c.display, detail: '', tool: c.name, ok: c.ok, dryRun: Boolean(c.dryRun), attention: !c.ok }))
    : [{ title: r.result, detail: r.need ?? '', tool: '', ok: r.layer !== 'error', dryRun: r.dryRun, attention: true }];
  return {
    input: r.input, normalized: r.normalized, layer: r.layer, dryRun: r.dryRun,
    result: r.result, attention: r.attention, error: r.error ?? null, need: r.need ?? null,
    intent, cards, plan: planLines,
    opened: r.opened ?? null,
    candidates: r.candidates ?? [],
    needsConfirmation: extra.needsConfirmation ?? null,
    cancelled: Boolean(r.cancelled),
    cost: costLabel(r, rt.provider ?? null),
    cache: { written: r.cached, candidate: Boolean(r.cacheCandidate) },
    llmRounds: r.llmRounds,
  };
}

export interface ServeDeps {
  /** Build a runtime per request mode (dryRun) — runtimes are cached by mode */
  runtime: (dryRun: boolean, print: (l: string) => void) => Promise<Runtime>;
  root: string;
  appRoot?: string;
  indexDir?: string;
  logDir?: string;
  home: string;
  run: Runner;
  write: (line: string) => void;
  /** Background index runs (methods index / indexStatus); absent = those methods answer -32000 */
  indexer?: IndexService;
}

/** In-flight handle requests by id, for `cancel` */
const inflight = new Map<number | string, AbortController>();

const err = (id: RpcResponse['id'], code: number, message: string): RpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

export async function dispatch(req: RpcRequest, d: ServeDeps): Promise<RpcResponse | null> {
  const id = req.id ?? null;
  const p = req.params ?? {};
  try {
    switch (req.method) {
      case 'ping':
        return { jsonrpc: '2.0', id, result: { ok: true, rpcVersion: RPC_VERSION } };
      case 'handle': {
        const text = typeof p.text === 'string' ? p.text : '';
        if (!text.trim()) return err(id, -32602, 'params.text is required');
        const planLines: string[] = [];
        const ac = new AbortController();
        if (id !== null) inflight.set(id, ac);
        try {
          const rt = await d.runtime(p.dryRun === true, (l) => planLines.push(l));
          const native = p.nativeFeedback === true;
          // The panel confirms irreversible actions itself, once: `confirmed: true` = the user already said yes.
          // Without it the core does not pop a dialog; it stops and answers needsConfirmation for the panel to ask.
          let needsConfirmation: { message: string } | null = null;
          const ctx = native ? { signal: ac.signal } : {
            signal: ac.signal,
            choose: undefined,
            confirm: async (message: string) => {
              if (p.confirmed === true) return true;
              needsConfirmation = { message };
              return false;
            },
          };
          // UI owns the feedback (no notification / dialog from the core) unless the client asks for it
          const report = await rt.run(text, native ? { ctx } : { feedback: async () => {}, ctx });
          return { jsonrpc: '2.0', id, result: toHandleResult(report, rt, planLines, { needsConfirmation }) };
        } finally {
          if (id !== null) inflight.delete(id);
        }
      }
      case 'cancel': {
        // usually sent as a notification (no id); cancels a running handle so nothing opens after the panel closed
        const target = p.id as number | string | undefined;
        const ac = target !== undefined ? inflight.get(target) : undefined;
        ac?.abort();
        return { jsonrpc: '2.0', id, result: { cancelled: Boolean(ac) } };
      }
      case 'index': {
        if (!d.indexer) return err(id, -32000, 'index not available');
        return { jsonrpc: '2.0', id, result: d.indexer.start(p.full === true) };
      }
      case 'indexStatus': {
        if (!d.indexer) return err(id, -32000, 'index not available');
        return { jsonrpc: '2.0', id, result: d.indexer.status() };
      }
      case 'search': {
        const query = typeof p.query === 'string' ? p.query : '';
        if (!query.trim()) return err(id, -32602, 'params.query is required');
        const limit = typeof p.limit === 'number' ? Math.max(1, Math.min(20, p.limit)) : 5;
        const rt = await d.runtime(true, () => {});
        const store = rt.ctx.saved;
        if (!store) return err(id, -32000, 'index not available');
        const t0 = Date.now();
        // mode "live" = results while typing: only items whose name carries what was typed (docs/rpc.md)
        const found = p.mode === 'live' ? searchLive(query, store.items(), store.aliases(), new Date(), limit) : searchSaved(query, store.items(), store.aliases(), new Date(), limit);
        const results = found.slice(0, limit).map((c) => ({
          key: c.item.key, kind: c.item.kind, title: openedInfo(c.item).title, url: c.item.url, score: Math.round(c.score * 1000) / 1000,
          aliasHit: c.aliasHit, needsAuth: Boolean(c.item.needsAuth), lastSeen: c.item.lastSeen, count: c.item.count,
        }));
        return { jsonrpc: '2.0', id, result: { query, results, cost: { cacheHit: true, tokens: 0, ms: Date.now() - t0, estimate: { amount: 0, currency: '¥' } } } };
      }
      case 'sample': {
        // first-run "try: open …": one clean, recent title from the user's own index (null = show no example)
        const rt = await d.runtime(true, () => {});
        const store = rt.ctx.saved;
        if (!store) return err(id, -32000, 'index not available');
        const it = pickSample(store.items(), new Date());
        return { jsonrpc: '2.0', id, result: { sample: it ? openedInfo(it) : null } };
      }
      case 'doctor': {
        const checks = await collectChecks({ root: d.root, appRoot: d.appRoot, indexDir: d.indexDir, logDir: d.logDir, home: d.home, run: d.run });
        const fail = checks.filter((c) => c.level === 'fail').length;
        const warn = checks.filter((c) => c.level === 'warn').length;
        return { jsonrpc: '2.0', id, result: { checks, summary: { total: checks.length, ok: checks.length - fail - warn, warn, fail } } };
      }
      default:
        return err(id, -32601, `method not found: ${req.method}`);
    }
  } catch (e) {
    return err(id, -32000, (e as Error).message.slice(0, 300));
  }
}

/** Parse items.json and build the per-item grams before the first keystroke (cold: ~100 ms on 2,700 items; warm: <10 ms) */
export async function warmSearch(d: Pick<ServeDeps, 'runtime'>): Promise<void> {
  try {
    const rt = await d.runtime(true, () => {});
    const store = rt.ctx.saved;
    if (store) searchLive('warm up', store.items(), store.aliases(), new Date());
  } catch { /* nothing to warm yet */ }
}

export async function serveStdio(d: ServeDeps, input: NodeJS.ReadableStream = process.stdin): Promise<void> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  setTimeout(() => { void warmSearch(d); }, 50);
  d.indexer?.onFinish(() => { void warmSearch(d); });
  const pending: Array<Promise<void>> = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: RpcRequest;
    try {
      req = JSON.parse(line) as RpcRequest;
    } catch {
      d.write(JSON.stringify(err(null, -32700, 'parse error')));
      continue;
    }
    if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      d.write(JSON.stringify(err(req?.id ?? null, -32600, 'invalid request')));
      continue;
    }
    // requests run concurrently; responses carry the id (order not guaranteed)
    pending.push(dispatch(req, d).then((res) => { if (res && req.id !== undefined) d.write(JSON.stringify(res)); }));
  }
  await Promise.all(pending);
}
