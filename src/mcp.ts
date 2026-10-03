/**
 * `va mcp`: a Model Context Protocol server over stdio, so Claude Code (or any MCP client) can search and open
 * Sesame's local artifact library. Tools: search_artifacts, open_artifact, artifact_stats.
 * Same index, search and open code as the app (src/saved.ts, skills/builtin/saved.ts); nothing is copied here.
 * stdout carries ONLY protocol messages; diagnostics go to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Runtime } from './runtime.ts';
import type { IndexService } from './index-service.ts';
import { openedInfo, REFRESH_BELOW, searchSaved, shortlist } from './saved.ts';
import { groupOf, isProduct, GROUPS } from './title-quality.ts';
import type { SavedItem } from './indexer.ts';
import { openItem } from '../skills/builtin/saved.ts';

export const MCP_SERVER_NAME = 'sesame';

/** Start a background index run at startup when the index is older than this (the app also refreshes every 30 min) */
export const STALE_MS = 30 * 60_000;
/** On the very first search with an empty index, wait this long for the first build before answering */
const FIRST_BUILD_WAIT_MS = 25_000;

export const INSTRUCTIONS = `Sesame keeps a local library of every artifact Claude Code and Codex delivered on this Mac: dashboards, local web services, reports and docs, slide decks, deployed sites, Claude artifact pages, pull requests and files the agent wrote.
When the user refers to something made in an earlier conversation ("where is last week's dashboard", "open the report I made yesterday", "上周那个看板在哪"), call search_artifacts with their own words instead of searching transcripts or the file system, then open_artifact with the key of the result they mean.`;

export interface McpDeps {
  /** Runtime with ctx.saved (index), ctx.run (open) and ctx.refreshSaved (time-boxed incremental index) */
  runtime: () => Promise<Runtime>;
  /** Background index runs; absent = no automatic indexing */
  indexer?: IndexService;
  version: string;
  now?: () => Date;
}

const text = (v: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }], ...(isError ? { isError: true } : {}) });

/** One search result as the model sees it */
export function resultRow(it: SavedItem, score: number, close: boolean): Record<string, unknown> {
  const o = openedInfo(it);
  return {
    key: it.key, title: o.title, type: groupOf(it), kind: it.kind, url: it.url,
    lastSeen: it.lastSeen, firstSeen: it.firstSeen,
    ...(o.session ? { session: o.session } : {}),
    madeByAI: isProduct(it),
    ...(it.needsAuth ? { needsAuth: true } : {}),
    match: close ? 'close' : 'loose',
    score: Math.round(score * 1000) / 1000,
  };
}

export function statsOf(items: SavedItem[]): { items: number; made: number; byType: Record<string, number>; byKind: Record<string, number> } {
  const byType: Record<string, number> = Object.fromEntries(GROUPS.map((g) => [g, 0]));
  const byKind: Record<string, number> = { artifact: 0, local: 0, web: 0, file: 0 };
  let made = 0;
  for (const it of items) {
    byKind[it.kind] = (byKind[it.kind] ?? 0) + 1;
    if (isProduct(it)) { made += 1; byType[groupOf(it)] += 1; }
  }
  return { items: items.length, made, byType, byKind };
}

function indexInfo(d: McpDeps): Record<string, unknown> {
  const s = d.indexer?.status();
  return s ? { updatedAt: s.updatedAt, building: s.running, ...(s.last === 'failed' ? { lastError: s.lastError } : {}) } : {};
}

/** Kick off an incremental index run when the index is missing or stale (non-blocking, child process) */
export function refreshIfStale(d: McpDeps, env: NodeJS.ProcessEnv = process.env): boolean {
  // VA_NO_AUTO_INDEX=1: install self-checks (make install-core, brew test) only ask initialize, no index run
  if (!d.indexer || env.VA_NO_AUTO_INDEX === '1') return false;
  const s = d.indexer.status();
  const now = (d.now ?? (() => new Date()))().getTime();
  if (s.running) return false;
  if (s.updatedAt && now - Date.parse(s.updatedAt) < STALE_MS) return false;
  d.indexer.start(false);
  return true;
}

export function createMcpServer(d: McpDeps): McpServer {
  const now = d.now ?? (() => new Date());
  const server = new McpServer({ name: MCP_SERVER_NAME, title: 'Sesame', version: d.version }, { instructions: INSTRUCTIONS });

  server.registerTool('search_artifacts', {
    title: 'Search past AI artifacts',
    description: [
      'Search the local library of artifacts that Claude Code and Codex delivered in past conversations on this Mac:',
      'dashboards, local web services (127.0.0.1 ports), reports and docs, slide decks, deployed sites, Claude artifact pages,',
      'pull requests and files the agent wrote.',
      'Use it whenever the user refers to something made in an earlier session and wants to find, reopen or link it',
      '("where is last week\'s dashboard", "open the report I made yesterday", "上周那个看板在哪"), instead of grepping transcripts or the disk.',
      'Pass the user\'s own words as query, in the language they used, including type words (dashboard, report, PR, 看板, 报告)',
      'and time words (yesterday, last week, 昨天, 上周), which filter by type and by when the item was seen.',
      'Do not add dates, translations or synonyms of your own: every extra word has to match the item\'s name, so it only narrows the results.',
      'If nothing comes back, retry once with fewer words (just the name) before telling the user.',
      'Returns the best matches first: key (for open_artifact), title, type, url, lastSeen/firstSeen (ISO time),',
      'session (the conversation it came from) and match ("close" = every noun of the query is in its name).',
      'An empty list means nothing in the library fits; say so rather than guessing.',
    ].join(' '),
    inputSchema: {
      query: z.string().min(1).describe('What the user is looking for, in their words, e.g. "trading dashboard last week" or "昨天的周报"'),
      limit: z.number().int().min(1).max(20).optional().describe('Maximum results, 1-20 (default 5)'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ query, limit }) => {
    const n = limit ?? 5;
    const rt = await d.runtime();
    const store = rt.ctx.saved;
    if (!store) return text({ error: 'index not available' }, true);
    if (store.items().length === 0 && d.indexer) {
      // first use: build the index now (or wait for the run started at boot), time-boxed
      if (!d.indexer.status().running) d.indexer.start(false);
      await Promise.race([d.indexer.wait(), new Promise((r) => setTimeout(r, FIRST_BUILD_WAIT_MS))]);
      store.reload();
    }
    let found = searchSaved(query, store.items(), store.aliases(), now(), n);
    // nothing close, or a weak lead: the item may come from a conversation that is still going → time-boxed refresh (5 s)
    if ((shortlist(found).length === 0 || found[0].score < REFRESH_BELOW) && rt.ctx.refreshSaved && !d.indexer?.status().running) {
      if (await rt.ctx.refreshSaved()) {
        store.reload();
        found = searchSaved(query, store.items(), store.aliases(), now(), n);
      }
    }
    const close = new Set(shortlist(found).map((c) => c.item.key));
    const results = found.slice(0, n).map((c) => resultRow(c.item, c.score, close.has(c.item.key)));
    const total = store.items().length;
    const note = total === 0
      ? (d.indexer?.status().running ? 'Sesame is still building its index for the first time; try again in a minute.' : 'The library is empty: no Claude Code or Codex conversations were found on this Mac.')
      : results.length === 0 ? 'Nothing in the library matches; tell the user rather than guessing.' : undefined;
    return text({ query, results, libraryItems: total, ...indexInfo(d), ...(note ? { note } : {}) });
  });

  server.registerTool('open_artifact', {
    title: 'Open an artifact',
    description: [
      'Open one artifact from search_artifacts on this Mac: links and local services in the default browser, files in their default app.',
      'Pass the key of a search result. Call it when the user asks to open, show or bring up the item;',
      'when several results fit equally well, ask the user which one first.',
      'Only items already in the library can be opened.',
    ].join(' '),
    inputSchema: { key: z.string().min(1).describe('The key field of a search_artifacts result') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ key }) => {
    const rt = await d.runtime();
    const store = rt.ctx.saved;
    if (!store) return text({ error: 'index not available' }, true);
    let it = store.items().find((x) => x.key === key);
    if (!it) { store.reload(); it = store.items().find((x) => x.key === key); }
    if (!it) return text({ ok: false, error: `no artifact with key ${JSON.stringify(key)}; call search_artifacts first and pass a key it returned` }, true);
    const r = await openItem(it, rt.ctx, 'mcp');
    const o = openedInfo(it);
    return text({ ok: r.ok, ...(r.dryRun ? { dryRun: true } : {}), message: r.display, opened: { key: it.key, title: o.title, type: groupOf(it), url: it.url } }, !r.ok);
  });

  server.registerTool('artifact_stats', {
    title: 'Library stats',
    description: [
      'Counts for the local artifact library: total items, how many the AI made (madeByAI), made items by type',
      '(dashboard, report, deck, site, pr, file), all items by kind (artifact, local, web, file), and when the index was last updated.',
      'Use it for questions like "how many dashboards have you built for me" or to check that the library is ready.',
    ].join(' '),
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const rt = await d.runtime();
    const store = rt.ctx.saved;
    if (!store) return text({ error: 'index not available' }, true);
    store.reload();
    return text({ ...statsOf(store.items()), ...indexInfo(d) });
  });

  return server;
}

/** Run the server on stdin/stdout until the client closes stdin */
export async function serveMcp(d: McpDeps): Promise<void> {
  const server = createMcpServer(d);
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => { server.server.onclose = () => resolve(); });
  await server.connect(transport);
  // count requests until their response is written, so a client that closes stdin right after its last request
  // (a script, a test) still gets every answer
  const open = new Set<string | number>();
  let drained: (() => void) | null = null;
  const onmessage = transport.onmessage;
  transport.onmessage = (m: JSONRPCMessage) => {
    if ('id' in m && 'method' in m) open.add(m.id);
    onmessage?.(m);
  };
  const send = transport.send.bind(transport);
  transport.send = async (m: JSONRPCMessage) => {
    await send(m);
    if ('id' in m && !('method' in m) && m.id !== undefined) { open.delete(m.id); if (open.size === 0) drained?.(); }
  };
  const idle = () => (open.size === 0 ? Promise.resolve() : new Promise<void>((r) => { drained = r; }));
  refreshIfStale(d);
  // the SDK transport does not close on stdin EOF by itself: end when the client goes away.
  // A background index run is a separate process that finishes (or stops at a file boundary) on its own.
  process.stdin.once('end', () => { void idle().then(() => server.close()); });
  await closed;
}
