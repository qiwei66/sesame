/** WO-20261003-040: the live list never falls back to links that were only mentioned; `search` says what the AI made. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore, searchLive } from '../src/saved.ts';
import { defaultConfig, setConfig } from '../src/config.ts';
import { madeByAI } from '../src/title-quality.ts';
import { dispatch } from '../src/rpc.ts';
import type { Runtime } from '../src/runtime.ts';
import type { SavedItem } from '../src/indexer.ts';

const NOW = new Date('2026-10-03T00:00:00Z');
const item = (p: Partial<SavedItem> & { key: string; title: string; kind: SavedItem['kind']; url: string }): SavedItem => ({
  variants: [p.url], titleSource: 'html', contexts: [], count: 3, firstSeen: '2026-09-20T00:00:00Z', lastSeen: '2026-10-01T00:00:00Z', ...p,
});

// a repo someone pasted into a chat (read, not made): the case behind this work order, with a made-up owner
const REPO = item({ key: 'web:repo', kind: 'web', url: 'https://github.com/example-user/typeless-tools', title: 'typeless-tools', contexts: ['看看这个仓库怎么做的'] });
const DASH = item({ key: 'local:8787', kind: 'local', url: 'http://127.0.0.1:8787', title: '交易大盘' });

test('typing an app name does not surface a repo that was only mentioned (no "nothing made → links" fallback)', () => {
  setConfig(defaultConfig('/x'));
  assert.equal(madeByAI(REPO), false, 'precondition: a pasted GitHub repo is not something the AI made');
  assert.deepEqual(searchLive('typeless', [REPO, DASH], {}, NOW), []);
  assert.deepEqual(searchLive('typeless-tools', [REPO, DASH], {}, NOW), [], 'even the full repo name');
  // asking for links still finds it
  assert.deepEqual(searchLive('typeless 链接', [REPO, DASH], {}, NOW).map((c) => c.item.key), ['web:repo']);
  assert.deepEqual(searchLive('typeless page', [REPO, DASH], {}, NOW).map((c) => c.item.key), ['web:repo']);
  // what the AI made is unaffected
  assert.deepEqual(searchLive('交易大盘', [REPO, DASH], {}, NOW).map((c) => c.item.key), ['local:8787']);
});

test('rpc search (live) marks each hit with made, so the app can rank apps around what the AI made', async () => {
  setConfig(defaultConfig('/x'));
  const store = memoryStore([REPO, DASH]);
  const rt = { ctx: { saved: store } } as unknown as Runtime;
  const deps = { runtime: async () => rt, root: '/r', home: '/home/tester', run: async () => ({ code: 0, stdout: '', stderr: '' }), write: () => {} };
  const live = (await dispatch({ jsonrpc: '2.0', id: 1, method: 'search', params: { query: '交易大盘', mode: 'live' } }, deps))?.result as { results: Array<{ key: string; made: boolean }> };
  assert.deepEqual(live.results.map((r) => [r.key, r.made]), [['local:8787', true]]);
  const links = (await dispatch({ jsonrpc: '2.0', id: 2, method: 'search', params: { query: 'typeless 链接', mode: 'live' } }, deps))?.result as { results: Array<{ key: string; made: boolean }> };
  assert.deepEqual(links.results.map((r) => [r.key, r.made]), [['web:repo', false]]);
});
