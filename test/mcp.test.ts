import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readlinkSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { defaultDataDir } from '../src/config.ts';
import { statsOf } from '../src/mcp.ts';
import type { SavedItem } from '../src/indexer.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const item = (o: Partial<SavedItem> & Pick<SavedItem, 'key' | 'kind' | 'url' | 'title'>): SavedItem => ({
  variants: [o.url], titleSource: 'html', contexts: [], count: 1, firstSeen: '2026-09-20T10:00:00Z', lastSeen: '2026-09-28T10:00:00Z', ...o,
});

// the report must exist on disk: an index refresh drops files that are gone
const WORK = mkdtempSync(join(tmpdir(), 'va-mcp-work-'));
const REPORT = join(WORK, 'weekly-2026-W39.md');
writeFileSync(REPORT, '# 销售周报\n');

const ITEMS: SavedItem[] = [
  item({ key: 'local:host:8787', kind: 'local', url: 'http://127.0.0.1:8787', title: 'Trading Dashboard', contexts: ['trading dashboard v2'], sessions: ['sess-aaa'] }),
  item({ key: `file:${REPORT}`, kind: 'file', url: REPORT, title: '销售周报', titleSource: 'markdown', sessions: ['sess-bbb'] }),
  item({ key: 'artifact:abc', kind: 'artifact', url: 'https://claude.ai/artifact/abc', title: 'Pricing deck slides', sessions: ['sess-ccc'] }),
];

/** A fresh user with a fixture index; HOME points into the temp dir so nothing real is read */
function fixture(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'va-mcp-'));
  const idx = join(dir, 'index');
  mkdirSync(idx, { recursive: true });
  writeFileSync(join(idx, 'items.json'), JSON.stringify(ITEMS));
  // a fresh lastRun: the server does not start a background index run at boot
  writeFileSync(join(idx, 'state.json'), JSON.stringify({ version: 1, files: {}, lastRun: new Date().toISOString() }));
  return { ...process.env, HOME: dir, VA_CONFIG_DIR: join(dir, 'cfg'), VA_INDEX_DIR: idx, VA_LOG_DIR: join(dir, 'logs'), VA_CACHE_FILE: join(dir, 'cache.json'), VA_DRY_RUN: '1', DEEPSEEK_API_KEY: '' };
}

interface Rpc { jsonrpc: string; id?: number; result?: Record<string, unknown>; error?: { code: number; message: string } }

/** Real stdio: spawn `bin/va mcp`, write one JSON-RPC message per line, read responses by id */
function start(env: NodeJS.ProcessEnv, t: { after: (f: () => void) => void }) {
  const p = spawn(join(ROOT, 'bin/va'), ['mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (p.exitCode === null) p.kill(); });
  const lines: string[] = [];
  const waiting = new Map<number, (r: Rpc) => void>();
  let stderr = '';
  p.stderr.on('data', (d: Buffer) => { stderr += String(d); });
  createInterface({ input: p.stdout }).on('line', (l) => {
    lines.push(l);
    const m = JSON.parse(l) as Rpc;
    if (m.id !== undefined) waiting.get(m.id)?.(m);
  });
  let next = 1;
  const request = (method: string, params: Record<string, unknown> = {}): Promise<Rpc> => {
    const id = next++;
    const done = new Promise<Rpc>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no answer to ${method}; stderr: ${stderr}`)), 20_000);
      waiting.set(id, (r) => { clearTimeout(t); resolve(r); });
    });
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return done;
  };
  const notify = (method: string) => p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  const exited = new Promise<number | null>((r) => p.on('close', (code) => r(code)));
  return { request, notify, lines, exited, close: () => p.stdin.end(), stderr: () => stderr };
}

const callText = (r: Rpc): Record<string, unknown> => {
  const content = (r.result?.content as Array<{ type: string; text: string }>);
  assert.equal(content[0].type, 'text');
  return JSON.parse(content[0].text) as Record<string, unknown>;
};

test('va mcp over real stdio: initialize → tools/list → tools/call (search / open / stats), stdout is protocol only', async (t) => {
  const s = start(fixture(), t);
  const init = await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.error, undefined);
  assert.equal((init.result?.serverInfo as { name: string }).name, 'sesame');
  assert.equal((init.result?.serverInfo as { version: string }).version, readFileSync(join(ROOT, 'macos/VERSION'), 'utf8').trim());
  assert.ok((init.result?.capabilities as Record<string, unknown>).tools, 'tools capability');
  assert.match(String(init.result?.instructions), /search_artifacts/);
  s.notify('notifications/initialized');

  const list = await s.request('tools/list');
  const tools = list.result?.tools as Array<{ name: string; description: string; inputSchema: { properties?: Record<string, unknown>; required?: string[] }; annotations?: Record<string, boolean> }>;
  assert.deepEqual(tools.map((t) => t.name).sort(), ['artifact_stats', 'open_artifact', 'search_artifacts']);
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const t of tools) assert.ok(t.description.length > 120, `${t.name} says when to use it`);
  assert.deepEqual(by.search_artifacts.inputSchema.required, ['query']);
  assert.ok(by.search_artifacts.inputSchema.properties?.limit);
  assert.deepEqual(by.open_artifact.inputSchema.required, ['key']);
  assert.equal(by.search_artifacts.annotations?.readOnlyHint, true);
  assert.equal(by.open_artifact.annotations?.readOnlyHint, false);

  const en = callText(await s.request('tools/call', { name: 'search_artifacts', arguments: { query: 'trading dashboard' } }));
  const top = (en.results as Array<Record<string, unknown>>)[0];
  assert.equal(top.key, 'local:host:8787');
  assert.equal(top.title, 'Trading Dashboard');
  assert.equal(top.type, 'dashboard');
  assert.equal(top.url, 'http://127.0.0.1:8787');
  assert.equal(top.session, 'sess-aaa');
  assert.equal(top.lastSeen, '2026-09-28T10:00:00Z');
  assert.equal(top.match, 'close');
  assert.equal(en.libraryItems, 3);

  const zh = callText(await s.request('tools/call', { name: 'search_artifacts', arguments: { query: '周报', limit: 2 } }));
  assert.equal((zh.results as Array<Record<string, unknown>>)[0].key, `file:${REPORT}`);
  assert.ok((zh.results as unknown[]).length <= 2);

  const none = callText(await s.request('tools/call', { name: 'search_artifacts', arguments: { query: 'quarterly tax filing' } }));
  assert.equal((none.results as Array<Record<string, unknown>>).filter((r) => r.match === 'close').length, 0);

  const opened = await s.request('tools/call', { name: 'open_artifact', arguments: { key: 'local:host:8787' } });
  assert.notEqual(opened.result?.isError, true);
  const o = callText(opened);
  assert.equal(o.ok, true);
  assert.equal(o.dryRun, true, 'VA_DRY_RUN=1: nothing is opened');
  assert.equal((o.opened as Record<string, unknown>).url, 'http://127.0.0.1:8787');

  const bad = await s.request('tools/call', { name: 'open_artifact', arguments: { key: 'nope' } });
  assert.equal(bad.result?.isError, true);
  assert.match(String(callText(bad).error), /search_artifacts first/);

  const missingArg = await s.request('tools/call', { name: 'search_artifacts', arguments: {} });
  assert.ok(missingArg.error || missingArg.result?.isError, 'query is required');

  const stats = callText(await s.request('tools/call', { name: 'artifact_stats', arguments: {} }));
  assert.equal(stats.items, 3);
  assert.deepEqual(stats.byKind, { artifact: 1, local: 1, web: 0, file: 1 });
  assert.equal((stats.byType as Record<string, number>).dashboard, 1);
  assert.equal((stats.byType as Record<string, number>).deck, 1);
  assert.equal(stats.building, false);

  // a request written right before stdin closes still gets its answer, then the server exits 0
  const last = s.request('tools/call', { name: 'artifact_stats', arguments: {} });
  s.close();
  assert.equal(callText(await last).items, 3);
  assert.equal(await s.exited, 0, s.stderr());
  for (const l of s.lines) assert.equal((JSON.parse(l) as Rpc).jsonrpc, '2.0', `stdout line is protocol: ${l.slice(0, 80)}`);
});

test('statsOf: made items by type, all items by kind (a file under the temp dir is searchable, not counted as made)', () => {
  const st = statsOf(ITEMS);
  assert.equal(st.items, 3);
  assert.equal(st.made, 2);
  assert.deepEqual(st.byType, { dashboard: 1, report: 0, deck: 1, site: 0, pr: 0, file: 0 });
  assert.deepEqual(st.byKind, { artifact: 1, local: 1, web: 0, file: 1 });
});

test('VA_INSTALLED=1 (the Claude Code plugin) keeps data in the per-user data dir, not in the plugin cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'va-plugin-root-'));
  assert.equal(defaultDataDir(root, {}, '/h', 'darwin'), root, 'a checkout keeps data in the repo');
  assert.equal(defaultDataDir(root, { VA_INSTALLED: '1' }, '/h', 'darwin'), '/h/Library/Application Support/Sesame');
  assert.equal(defaultDataDir(root, { VA_INSTALLED: '1', XDG_DATA_HOME: '/x' }, '/h', 'linux'), '/x/sesame');
});

test('plugin + marketplace manifests: same name, plugin/ holds only the core (links), MCP server runs core/bin/va mcp', () => {
  const read = (f: string) => JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
  const plugin = read('plugin/.claude-plugin/plugin.json') as { name: string; version: string; mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> };
  const market = read('.claude-plugin/marketplace.json') as { name: string; plugins: Array<{ name: string; source: string }> };
  assert.equal(market.plugins[0].name, plugin.name, 'entry name = manifest name');
  assert.equal(market.plugins[0].source, './plugin');
  const srv = plugin.mcpServers.sesame;
  assert.equal(srv.command, '${CLAUDE_PLUGIN_ROOT}/core/bin/va');
  assert.deepEqual(srv.args, ['mcp']);
  assert.equal(srv.env?.VA_INSTALLED, '1');
  // no top-level bin/ in the plugin: it would land on the Bash tool's PATH
  assert.equal(existsSync(join(ROOT, 'plugin/bin')), false);
  // core/* are links into the repository: Claude Code copies their targets into the plugin cache
  for (const [l, target] of [['bin', '../../bin'], ['src', '../../src'], ['skills', '../../skills'], ['package.json', '../../package.json'], ['LICENSE', '../../LICENSE']]) {
    assert.equal(readlinkSync(join(ROOT, 'plugin/core', l)), target, `plugin/core/${l}`);
  }
  accessSync(join(ROOT, 'plugin/core/bin/va'), constants.X_OK);
  // Claude Code installs node_modules from package.json + package-lock.json at the plugin root
  const root = read('package.json') as { version: string; dependencies: Record<string, string> };
  const pkg = read('plugin/package.json') as { version: string; dependencies: Record<string, string> };
  assert.deepEqual(pkg.dependencies, root.dependencies, 'plugin packages = the core runtime packages');
  for (const f of ['package-lock.json', 'plugin/package-lock.json']) {
    const lock = read(f) as { lockfileVersion: number; packages: Record<string, { dependencies?: Record<string, string> }> };
    assert.ok(lock.lockfileVersion >= 2, f);
    assert.deepEqual(lock.packages[''].dependencies, root.dependencies, `${f} lists the same dependencies`);
  }
  for (const v of Object.values(root.dependencies)) assert.match(v, /^\d+\.\d+\.\d+$/, 'exact versions');
  // one version everywhere: core, plugin, its packages, the app bundle (MCP serverInfo reads package.json)
  const app = readFileSync(join(ROOT, 'macos/VERSION'), 'utf8').trim();
  assert.deepEqual([root.version, pkg.version, plugin.version], [app, app, app]);
});
