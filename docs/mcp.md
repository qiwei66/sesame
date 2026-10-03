# MCP server (`va mcp`) and the Claude Code plugin

`va mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio. It answers from the same
local index, search and open code as the app (`src/saved.ts`, `skills/builtin/saved.ts`), built on the official
TypeScript SDK (`@modelcontextprotocol/sdk`, MIT). stdout carries protocol messages only; diagnostics go to stderr.

## Install

**Claude Code plugin** (this repository is both the plugin and its marketplace, `.claude-plugin/`):

```bash
claude plugin marketplace add qiwei66/sesame && claude plugin install sesame@sesame
```

Claude Code copies the plugin into its plugin cache and installs its npm packages there from `package-lock.json`.
The server runs `${CLAUDE_PLUGIN_ROOT}/bin/va mcp` with `VA_INSTALLED=1`, so its data lives in the per-user data dir
(`~/Library/Application Support/Sesame` on macOS), shared with the app and kept across plugin updates.
Updates: `claude plugin update sesame@sesame`. Remove: `claude plugin uninstall sesame@sesame`.

**Any other MCP client**, from a git checkout:

```bash
git clone https://github.com/qiwei66/sesame.git && cd sesame && npm ci --omit=dev
claude mcp add --scope user -e VA_INSTALLED=1 --transport stdio sesame -- "$PWD/bin/va" mcp
```

For another client, the server entry is `{"command": "/path/to/sesame/bin/va", "args": ["mcp"], "env": {"VA_INSTALLED": "1"}}`.
Without `VA_INSTALLED=1` a checkout keeps its index in the checkout (developer default, see `src/config.ts`).
A core installed by `make install` or Homebrew has no `node_modules`; `va mcp` then says which command to run.

## Tools

| tool | input | returns |
|---|---|---|
| `search_artifacts` | `query` (the user's words), `limit` 1–20 (default 5) | `results`: `key`, `title`, `type` (dashboard / report / deck / site / pr / file), `kind` (artifact / local / web / file), `url`, `lastSeen`, `firstSeen`, `session`, `madeByAI`, `match` (`close` = every noun of the query is in the name), `score`; plus `libraryItems`, `updatedAt`, `building`, and a `note` when nothing matches |
| `open_artifact` | `key` from a search result | `ok`, `message`, `opened`; opens with `open` on this Mac (`VA_DRY_RUN=1`: only says what it would open) |
| `artifact_stats` | none | `items`, `made`, `byType` (made items), `byKind` (all items), `updatedAt`, `building` |

Results are JSON in one text block. Search reads type words and time words the way the app does (docs/rpc.md, "How
the local layer reads a sentence"); when nothing close is found it runs one time-boxed incremental index (5 s) and
searches again, so an artifact from a conversation that is still going can be found.

## Index

At startup the server starts a background incremental index run (a child process) when the index is missing or older
than 30 minutes. The first search on an empty index waits up to 25 seconds for that first build. Index runs are
mutually exclusive with the app's (`index/lock`), so the plugin and the app can run at the same time.

## What reaches the model

Only what a tool returns: the matches for the query that was asked (title, type, link, time, session id) or the counts.
They go to the model of the Claude Code conversation that called the tool. Links with auth parameters were already
stripped when indexed (`needsAuth: true`).

## Test

```bash
node --test test/mcp.test.ts   # spawns bin/va mcp, real stdio: initialize, tools/list, tools/call
claude plugin validate .       # plugin + marketplace manifests
```
