# Sesame: notes for AI coding assistants

`AGENTS.md` is a symlink to this file. Humans: see [CONTRIBUTING.md](CONTRIBUTING.md).

Sesame is a macOS menu-bar app that keeps a local library of the artifacts Claude Code and Codex delivered
(dashboards, reports, decks, sites, PRs, files) and opens one when you type or say a few words.

## Architecture

```
Sesame.app (Swift, macos/)                 TS core (Node 22.18+, src/, no build step)
  menu bar + floating NSPanel   ── JSON-RPC 2.0 over stdio (NDJSON) ──▶  va serve --stdio
  hot key, push-to-talk, settings                                         ├─ search: local index, per keystroke
                                                                           ├─ handle: cache → local index → model → tools
                                                                           └─ index: sources → index/items.json
```

| Area | Where | Notes |
|---|---|---|
| App logic (no UI) | `macos/Sources/SesameCore/` | RPC client, result mapping, hot-key plan, paste commit. Tested by `swift test --package-path macos` |
| App UI | `macos/Sources/Sesame/` | AppKit + SwiftUI. Strings in `macos/Resources/{en,zh-Hans}.lproj/` |
| RPC contract | `src/rpc.ts`, [docs/rpc.md](docs/rpc.md) | `RPC_VERSION = 1`. Adding fields is fine; removing or renaming bumps the version |
| Routing | `src/router.ts`, `src/cache.ts`, `src/normalize.ts` | Cache replays a plan only after the same sentence planned the same way twice |
| Index sources | `src/sources/` | One `IndexSource` per tool (`claude.ts`, `codex.ts`). Register in `SOURCES` |
| Indexer / search | `src/indexer.ts`, `src/index-run.ts`, `src/saved.ts` | Incremental by byte offset; never re-reads whole files by mtime |
| Tools the model may call | `skills/builtin/*.ts`, `src/tools.ts` | See [docs/skills.md](docs/skills.md). Allowlist only |
| Health check | `src/doctor.ts` (`va doctor`) | Read-only |
| Config | `src/config.ts`, [docs/config.md](docs/config.md) | User config lives in `~/.config/voice-agent/`, never in the repo |

## Build and test

```sh
npm test && npm run typecheck          # core
swift test --package-path macos        # app logic
make                                   # macos/build/Sesame.app
VA_DRY_RUN=1 bin/va "open the trading dashboard"   # plan only, nothing runs
```

`src/**` changes take effect directly (Node strips types). TypeScript is strict with `noUnusedLocals` and `noUnusedParameters`.

## Invariants (do not break these)

1. **Never take focus from automation.** Demo (`--demo`), screenshot and `--test-script` runs set
   `Presentation.passive`: windows only `orderFrontRegardless`, never become key, never activate the app. Only the
   real hot key may focus the panel. Test: `PresentationTests`.
2. **Never synthesize keyboard or mouse events.** No `CGEvent` posting, no AppleScript keystrokes. The hot key is
   reserved with Carbon `RegisterEventHotKey`; no Input Monitoring or Accessibility permission is needed.
3. **Never write system settings or another app's settings.** Spotlight, Alfred and Raycast hot keys are read only
   (`defaults read` / preference files). To change them, open the right settings page for the user.
4. **The index stays on this Mac.** Sources are read-only; the indexer never writes inside a source directory.
   `index/`, `logs/` and caches are git-ignored; index files are written with mode 600.
5. **Send the model as little as possible.** It gets the sentence, tool definitions and, when local search is not
   sure, candidate type + title + keywords (`describeForModel`). Never full URLs, file paths or clipboard text. A tool
   whose result contains user content must set `modelDisplay` / `modelData`. With no model key, the local path works alone.
6. **No secrets anywhere.** URLs with key/token-style query parameters are stripped and marked `needsAuth`;
   key-like strings are removed from titles and context. Key values are never printed or logged.
7. **Irreversible actions need a yes.** Deleting files or quitting apps returns `needsConfirmation`; the UI asks once.
8. **Copy names the artifact.** User-facing text says what it is (dashboard, report, deck, site, PR, file). No vague
   words like "things" or "stuff" (or their Chinese equivalents), no internals (model names, tokens, cost) in the
   panel. Cost appears only in Settings → Usage.
9. **No personal data in the repo.** Code, tests and fixtures use made-up paths, links and chat text.

## Common changes

- New source: follow CONTRIBUTING.md → "Add an index source"; add a redacted fixture test.
- New tool: add it under `skills/builtin/`, with a unit test; set `cachePolicy: 'never'` for one-shot side effects.
- RPC change: update `docs/rpc.md` and both sides (`src/rpc.ts`, `macos/Sources/SesameCore/RPCClient.swift`).
- UI change: attach light and dark screenshots (`Sesame --demo <state> --light|--dark`, see `macos/README.md`).
