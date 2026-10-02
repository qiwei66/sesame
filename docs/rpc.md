# JSON-RPC over stdio (`va serve --stdio`)

Contract for the future native (Swift) menu-bar app. The app spawns **one long-lived process**
`bin/va serve --stdio` and talks JSON-RPC 2.0 over its stdin/stdout.

## Framing

- **NDJSON**: one JSON object per line, UTF-8, `\n`-terminated, both directions. No `Content-Length` headers.
- stdout carries protocol messages only. Diagnostics (`[va] …`) go to **stderr** — log them, don't parse them.
- Requests are handled concurrently; match responses by `id`. Notifications (no `id`) get no response.
- Errors: `-32700` parse error · `-32600` invalid request · `-32601` method not found · `-32602` bad params · `-32000` server error.
- `RPC_VERSION = 1` (returned by `ping`). Additive changes (new fields) do not bump it; removals/renames do.

## Methods

### `ping` → `{ ok: true, rpcVersion: 1 }`

### `handle({ text, dryRun?, nativeFeedback?, confirmed? })`

Runs one sentence through cache → local index → model → tools. The local layer answers without the model when
the sentence is a name (alias / exact title) or "open X" with a clear local lead; with no model key configured it is
the main path ("open <app>" opens the app, a clear winner opens, close matches come back as `candidates`).

| param | type | meaning |
|---|---|---|
| `text` | string, required | the sentence (from speech-to-text) |
| `dryRun` | bool, default false | plan only: nothing is opened/changed (read-only queries such as battery still run) |
| `nativeFeedback` | bool, default false | true = core shows macOS notification/dialog itself; false = the UI renders `cards` |
| `confirmed` | bool, default false | the user already said yes on the UI's confirm card |

Confirmation happens once, in the UI. With `nativeFeedback: false` the core never shows a dialog: an irreversible step
without `confirmed: true` is not run and the result carries `needsConfirmation: { message }`; the UI asks and, on yes,
sends the same `text` again with `confirmed: true`. Ambiguous `open_saved` matches never pop a system list either;
they come back in `candidates`.

Added fields (additive, RPC_VERSION stays 1):

| field | meaning |
|---|---|
| `layer` | also `"local"`: answered from the local index, 0 tokens |
| `opened` | `{ key?, title, url, kind, lastSeen?, firstSeen?, session? }` — the item the core actually opened (or would open in a dry run). `kind`: artifact / local / web / file / app. Use it for the success card; do not search again. `null` when nothing was opened |
| `candidates` | `[{ key, title, url, kind, score, lastSeen, … }]` — close matches left to the user (every noun of the sentence is in their name); empty when none. A sentence that matches nothing well comes back with no candidates and a "nothing found" result, never a list of filler |
| `needsConfirmation` | `{ message }` or `null` (see above) |
| `need` | one human sentence: what the user can do next after a miss (also in `cards[0].detail`); never an error code |
| `cancelled` | true when a `cancel` arrived before the request finished |

How the local layer reads a sentence (src/query.ts, src/saved.ts): function words (打开 / 那个 / open / the) and time words
are not matched as text; nouns are matched against the item's name (title, file name) and, scored far lower, the
conversation around it; a type word (看板 / 报告 / PR / 页面 / dashboard / report / page) and a time window (昨天 / 上周 /
last week) filter, a date in the name ("weekly_2026-W39.md") beats when it was seen; 最近 / recent puts the newest first.
Quality is measured on the user's own index with `npm run eval:real` (answers in `~/.config/voice-agent/eval-real.json`).

Titles in `opened` / `candidates` / `search` fall back when empty: host (web, local service) or file name, then the
last path segment.

Result:

```jsonc
{
  "input": "open the trading dashboard",
  "normalized": "openthecomputedashboard",       // cache key
  "layer": "llm",                                // "cache" | "llm" | "error"
  "dryRun": true,
  "result": "（演练）打开 Trading Dashboard（本机服务）",   // one-line summary for a toast
  "attention": false,                            // true → show a sticky card (failure / needs the user)
  "error": null,
  "intent": [                                    // what will run / ran — use for the preview row
    { "tool": "open_saved", "args": { "query": "trading dashboard" },
      "needsConfirm": false, "readOnly": false, "origin": "builtin" }   // origin: builtin | user:<file>
  ],
  "cards": [                                     // one per executed tool (or one for errors / empty plans)
    { "title": "（演练）打开 Trading Dashboard（本机服务）", "detail": "", "tool": "open_saved",
      "ok": true, "dryRun": true, "attention": false }
  ],
  "plan": ["[DRY-RUN] open_saved 选中（本地检索明显领先）：Trading Dashboard（本机服务） → open http://127.0.0.1:8787"],
  "cost": {                                      // the cost tag
    "cacheHit": false,                           // true = answered by the literal cache, 0 tokens
    "tokens": 2930, "promptCacheHitTokens": 2688, // provider-side prefix cache hits
    "ms": 1997,
    "estimate": { "amount": 0.00031, "currency": "¥" },   // null when no price is configured for the provider
    "provider": "deepseek", "model": "deepseek-flash"
  },
  "cache": { "written": false, "candidate": true },  // candidate = first time seen; same plan again → written
  "llmRounds": 1
}
```

Display strings (`result`, `cards[].title`, `plan[]`) are currently Chinese; they are for humans, do not parse them.
Use `intent`, `layer`, `cost`, `cards[].ok` for logic.

### `cancel({ id })` (notification)

Cancels a running `handle` by its request id; send it as a notification (no `id` of its own). The core runs no
further tool for that request, so nothing opens after the panel was closed. With an `id` it answers `{ cancelled }`.

### `index({ full? })` → index status, right away

Starts a background index run in a child process (`src/index-cli.ts --progress-json`) unless one is running; never
blocks `handle` / `search`. Where the index lives is decided by the core (`resolvePaths`: env `VA_INDEX_DIR` >
config `index_dir` > `<data_dir>/index`; an installed core defaults to `~/Library/Application Support/Sesame`). The app
calls it on every launch and every 30 minutes; the first run builds the index from scratch.

### `indexStatus()` →

```jsonc
{ "running": true, "progress": { "phase": "scan", "filesDone": 120, "filesTotal": 812, "items": 1204 },
  "items": 1204, "updatedAt": "2026-10-02T05:58:00.000Z", "last": "done", "lastError": null }
```

No paths. `last`: `done` | `skipped` (another index run held the lock) | `failed` | `null`.
Added: `groups` — `{ dashboard, report, deck, site, pr, file }`, the first-run panel's six counts, and `made` (their
sum). Both count only what the AI made: local services, Claude artifacts, files it wrote or sent, PRs it opened, sites it
deployed, docs it created (`madeByAI` in src/title-quality.ts). Links that were only mentioned or read stay in the index
and in `search`, but are not counted; `items` counts everything. Live while running.

### `sample()` → `{ sample: { key, title, url, kind, lastSeen, … } | null }`

The first-run "try: open …" example, picked from the user's own index: seen in the last 7 days, a clean short title
that looks like a dashboard / report / page (Claude pages and local services first). `null` = show no example row.

### `search({ query, limit? })`

Local index search only (no model, no network). `limit` 1–20, default 5. `mode: "live"` = results while typing:
only items whose name (title, its uncut original, alias, PR/issue tag) carries at least half of the typed text; one or two
characters also match inside a title; one row per name; only what the AI made, unless the text asks for web pages /
links / articles or nothing the AI made matches (then mentioned links come after). An empty result means the UI shows
"let Sesame look for …". Ranking in both modes prefers what the AI made and lowers links that were only mentioned.

```jsonc
{ "query": "trading dashboard",
  "results": [ { "key": "local:host:8787", "kind": "local", "title": "Trading Dashboard",
                 "url": "http://127.0.0.1:8787", "score": 7.12, "aliasHit": false,
                 "needsAuth": false, "lastSeen": "2026-10-01T10:00:00Z", "count": 3 } ],
  "cost": { "cacheHit": true, "tokens": 0, "ms": 4, "estimate": { "amount": 0, "currency": "¥" } } }
```

`kind`: `artifact` (claude.ai artifact) · `local` (127.0.0.1 / LAN / tailnet service) · `web` · `file`.
`url` is returned to the local UI only; it is never sent to the model.

### `doctor({ alfredTrigger?, profile? })`

`profile: "sesame"` (the app sends it) checks only node, model and index; `"alfred"` adds the Alfred workflow,
AutoEnter helper, launchd, signing and Spotlight checks. Default: detected from the install.

Read-only health checks (same as `va doctor`). `alfredTrigger: true` also runs the Alfred round-trip self-test.

```jsonc
{ "checks": [ { "name": "模型", "level": "ok", "detail": "deepseek · deepseek-flash · …; key 来自 env DEEPSEEK_API_KEY（内容不显示）" },
              { "name": "索引新鲜度", "level": "warn", "detail": "…", "fix": "bin/va-index" } ],
  "summary": { "total": 9, "ok": 7, "warn": 1, "fail": 1 } }
```

`level`: `ok` | `warn` | `fail`; `fix` is a one-line remedy (present for warn/fail).

## Example session

```
→ {"jsonrpc":"2.0","id":1,"method":"ping"}
← {"jsonrpc":"2.0","id":1,"result":{"ok":true,"rpcVersion":1}}
→ {"jsonrpc":"2.0","id":2,"method":"handle","params":{"text":"what's my battery","dryRun":true}}
← {"jsonrpc":"2.0","id":2,"result":{"layer":"llm","result":"电量 100%，已充满","intent":[{"tool":"run_shell","args":{"command_id":"battery"},…}],"cost":{…}}}
```

## Swift side (suggested)

- `Process` with `standardInput`/`standardOutput` pipes; read stdout with a line splitter; one `[Int: CheckedContinuation]` map by id.
- Restart the process if it exits; it is stateless between requests (state lives in cache/index files).
  `bin/va` exits 127 when there is no node and 125 when node is older than 22.18: do not restart on those, show the fix.
- Keys: the core reads them itself (env / Keychain / file per config). The app never passes keys over RPC.
