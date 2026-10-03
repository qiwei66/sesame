# Contributing to Sesame

[中文](#参与贡献)

Thanks for helping. Small, focused pull requests are the easiest to review.

## Build and test

You need macOS 13+, Node.js 22.18+ and the Xcode Command Line Tools (`xcode-select --install`).

```sh
npm install                          # dev dependencies only (TypeScript, types)
npm test                             # core tests (node --test, runs .ts directly)
npm run typecheck                    # tsc --noEmit
swift test --package-path macos      # app logic tests
make                                 # build macos/build/Sesame.app
make install                         # build and install the app and the core
```

`make test` runs both test suites. Run `va doctor` after installing to check your setup.

## Code style

- TypeScript only, strict mode, ES modules with explicit `.ts` imports. No build step: Node runs the sources.
- No new runtime dependencies without discussing it in an issue first.
- Keep functions pure where you can and cover them in `test/`. Swift logic goes in `macos/Sources/SesameCore` with tests in `macos/Tests`.
- Never put personal paths, real links or chat text in code, tests or fixtures. Use made-up data.
- UI changes: attach light and dark screenshots to the PR.

## Add an index source

A source tells the indexer where an AI tool keeps its transcripts and how to pull delivered links and files out of one line. Sources are read-only.

1. Create `src/sources/<tool>.ts` that exports an `IndexSource` (see `src/sources/types.ts`). `codex.ts` is a complete example; `claude.ts` is the shortest.
2. Register it in `SOURCES` in `src/sources/index.ts`.
3. Add tests with a small redacted fixture (see the Codex cases in `test/oss-core.test.ts`).
4. Document the config id (`sources: [claude, codex, <tool>]`) in `docs/config.md`.

If the tool stores history in something other than line-based JSONL (for example SQLite), open an issue first so we can agree on the approach.

---

## 参与贡献

感谢参与。小而聚焦的 PR 最容易评审。

### 构建与测试

需要 macOS 13+、Node.js 22.18+ 和 Xcode 命令行工具（`xcode-select --install`）。命令同上：`npm test` 跑核心测试，`npm run typecheck` 做类型检查，`swift test --package-path macos` 跑 App 逻辑测试，`make` 构建，`make install` 安装。装好后用 `va doctor` 体检。

### 代码风格

- 只写 TypeScript，strict 模式，ES 模块，import 带 `.ts` 后缀；没有构建步骤，Node 直接运行源码。
- 新增运行时依赖前先开 issue 讨论。
- 能写成纯函数就写成纯函数，并在 `test/` 补测试；Swift 逻辑放 `macos/Sources/SesameCore`，测试放 `macos/Tests`。
- 代码、测试、样例里不放个人路径、真实链接或对话内容，一律用编造的数据。
- 界面改动请在 PR 里附浅色和深色截图。

### 新增一个索引来源

来源负责告诉索引器某个 AI 工具把对话记录存在哪，以及怎样从一行记录里取出交付的链接和文件。来源只读，不写。

1. 新建 `src/sources/<tool>.ts`，导出一个 `IndexSource`（接口见 `src/sources/types.ts`）。完整例子看 `codex.ts`，最短的看 `claude.ts`。
2. 在 `src/sources/index.ts` 的 `SOURCES` 里注册。
3. 用一份脱敏的小样例补测试（参考 `test/oss-core.test.ts` 里 Codex 的用例）。
4. 在 `docs/config.md` 写明配置 id（`sources: [claude, codex, <tool>]`）。

如果这个工具的记录不是按行的 JSONL（比如 SQLite），请先开 issue 商量做法。
