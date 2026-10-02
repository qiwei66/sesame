# 语音指令助手 · 交接文档（CLAUDE.md = AGENTS.md）

> oss-core 分支：个人化内容全部在 `~/.config/voice-agent/`（config.yaml / commands.yaml / skills/ / env.sh），不进仓库。`<prefix>` = `VA_BUNDLE_PREFIX`（env.sh 设置，默认 `local.voice-agent`）。核心模块说明见 README.md、docs/。

> 给接手的人和 agent：读完这一页就能改、能编译、能验证，不需要任何口头交代。
> 新电脑：`git clone`/恢复本目录 → `~/.voice-agent/bin/va-setup` → 在弹出的「辅助功能」里把 `VA AutoEnter` 拖进列表并打开开关 → `va doctor` 全绿。完。
> 现状（2026-10-01）：助手已是 `bin/VA AutoEnter.app`（bundle id `<prefix>.va-autoenter`），本机已授权；`scripts/verify-autoenter-tcc.sh` 验证过「重编译后授权保留」PASS。旧的裸二进制 `bin/va-autoenter` 已废弃，`va-setup` 会顺手删掉残留。

## 架构

```
⌘Space ──▶ Alfred 主输入框 ◀── Typeless（按住 Fn 说话，松开后粘贴文字）
                │                        │
                │                        └─ 写 typeless.db + 剪贴板（VA AutoEnter 只看 mtime/计数）
                │
                │  VA AutoEnter.app（launchd 常驻）：Alfred 浮窗在屏 + 听写信号 + 文字稳定 400ms → 按回车
                ▼
        Alfred workflow「语音指令助手」（bundle <prefix>.voice-agent）
          · Fallback 触发器（fallback 列表第一位）· 关键词 v <一句话> · 外部触发 va
                │  bash: ~/.voice-agent/bin/va "$1"（退出码≠0 → logs/alfred-errors.log；非 1 的再弹通知）
                ▼
        va（src/cli.ts → src/router.ts）
          ① 缓存层 cache.json（演练用 cache.dryrun.json）：字面归一化命中且工具表版本号一致 → 直接回放，0 token
          ② DeepSeek 工具调用层（deepseek-flash，非思考模式）→ src/tools.ts 白名单工具
               open_app · open_url · run_shell(白名单) · applescript(预定义) · search_files · trash_files(确认)
               read_clipboard · notify/speak · unsupported(交接给用户) · open_saved · save_alias
                │
                └─ open_saved 读 index/items.json ◀── va-index（launchd 每 30 分钟增量；查询没命中时按需刷新，限时 5 秒，超时放弃且不写盘）
                                                       扫 ~/.claude/projects/**/*.jsonl（只读）
反馈：一般成功 → 系统通知；unsupported/失败/需要用户动手 → 不自动关闭的对话框；朗读默认关（VA_SPEAK=1 开）
日志：logs/YYYY-MM-DD.jsonl（每次调用）· logs/va-index.log · logs/va-autoenter.log · logs/alfred-errors.log（Alfred 侧失败）
体检：`va doctor`（只读，✅/⚠️/❌ + 一行修法）
```

## 组件职责

| 组件 | 文件 | 职责 |
|---|---|---|
| va | `bin/va` → `src/cli.ts` | 一句话入口：缓存 → DeepSeek → 执行 → 反馈 → 记日志 |
| 路由 | `src/router.ts` · `src/normalize.ts` · `src/cache.ts` | 两层路由、缓存键归一化（只做字面，不做语义模糊）、写缓存规则（见不变式 10） |
| 并发写 | `src/fsutil.ts` | 文件锁 + 重读合并 + pid 临时文件原子写（cache / aliases / 索引共用） |
| 体检 | `src/doctor.ts`（`va doctor`） | 只读检查 node、key、launchd、授权、证书、Alfred、Spotlight、索引、错误数、Alfred 外部触发自检 |
| 工具 | `src/tools.ts` | 全部工具与白名单；不可逆操作弹确认；`VA_DRY_RUN=1` 只打印 |
| 模型 | `src/llm.ts` · `src/providers.ts` | OpenAI 兼容 `/chat/completions`；provider（deepseek/openai/ollama/lmstudio）与 key 来源（env/钥匙串/文件）在 `~/.config/voice-agent/config.yaml` |
| 索引器 | `bin/va-index` → `src/index-cli.ts` · `src/index-run.ts` · `src/indexer.ts` | 从 Claude 对话抽 Artifact/链接/文档；字节偏移增量；脱敏 |
| 检索 | `src/saved.ts` | bigram + 泛词降权 + 具体词兜底 + 同会话/同项目主题词 + 别名 |
| 自动回车 | `autoenter/main.swift` → `bin/VA AutoEnter.app`（bundle id `<prefix>.va-autoenter`，LSUIElement） | 只在 Alfred 浮窗在屏时、听写完成后按一次回车 |
| Alfred | `scripts/build-alfred.ts` · `scripts/alfred-install.py` | 生成 workflow；文件法装入；fallback 第一位；主热键 ⌘Space |
| 安装 | `bin/va-setup` · `bin/va-autoenter-setup` · `scripts/build-autoenter.sh` | 一键幂等安装；授权引导；固定身份签名 |
| launchd | `launchd/va-index.plist` · `launchd/va-autoenter.plist` | 模板（`__ROOT__/__HOME__/__PREFIX__` 由 va-setup 替换） |

## 不变式（改代码前必须守住）

1. **必须是 .app bundle + 固定签名身份**：助手只能由 `scripts/build-autoenter.sh` 产出 `bin/VA AutoEnter.app`，`CFBundleIdentifier = <prefix>.va-autoenter`，用 `VA_SIGN_IDENTITY`（未设时取钥匙串里第一个 Apple Development 身份）签整个 bundle；launchd 直接执行 `Contents/MacOS/va-autoenter`（bundle 主程序），并带 `AssociatedBundleIdentifiers`。designated requirement 必须是「identifier + 证书」，**不能是 cdhash**；找不到身份直接失败，**禁止退回 ad-hoc**。
   - 理由一：TCC 用 DR 判断「新编译的还是不是同一个程序」，DR 不变 → 重编译后授权保持（Apple [TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)；DTS [thread 730043](https://developer.apple.com/forums/thread/730043)）。
   - 理由二：TCC 按「responsible code」归属授权；放进 bundle 后按 bundle id 记录（client_type=0），可用 `tccutil reset Accessibility <prefix>.va-autoenter` 精确重置（DTS [thread 732291](https://developer.apple.com/forums/thread/732291)、[thread 698337](https://developer.apple.com/forums/thread/698337)）。
   - **教训（2026-10-01）**：裸二进制 `bin/va-autoenter` 被 TCC 按**路径**记录（client_type=1），首次授权时的 csreq 被钉成当时 ad-hoc 版本的 `cdhash`；之后同一路径换成正式签名，系统设置里旧记录照样显示「已开启」，再点开关也不会更新 csreq，新版本永远拿不到授权。所以：不许再用裸二进制拿 TCC 权限；改 bundle id 或路径等于新程序，要重新授权。
   - 重置授权的 `tccutil` 只能由用户本人执行，agent 不许跑、不许读写 TCC.db。
2. **自动回车只在 Alfred 生效**：判定条件包含「Alfred 有宽≥400、高≥40 的在屏窗口」。Alfred 搜索框是不抢前台的浮窗（实测前台仍是 Chrome），所以不能改成只看前台 App。
3. **不读 Typeless 内容**：只读 `typeless.db` 的修改时间和剪贴板 changeCount，不打开、不解析、不修改 Typeless 的任何文件。
4. **不监听键盘**：不需要也不申请「输入监控」。只需要「辅助功能」（发回车、读 Alfred 输入框文字）。
5. **索引不进仓**：`index/`（items/state/titles/aliases/last_opened，600 权限）、`logs/`、`cache*.json`、`dist/`、编译产物都在 `.gitignore`。
6. **无密钥**：仓库、日志、索引里不出现任何密钥值。带 token/key/k/sig 等参数的 URL 去掉查询串并标记 `needsAuth`；含 `sk-` 的 URL 整条不收；上下文与标题抹掉密钥样式片段。验证：`grep -cE 'k=|token=|key=|sk-' index/items.json` 必须为 0。
7. **open_saved 发给模型的只有「标题 + 关键词 + 类型」**，URL/IP/路径先剥掉（`describeForModel`）。完整 URL 只在本机打开时使用。
8. **索引器只读 `~/.claude/projects`**，不遍历 home 其它目录；增量按字节偏移（state.json 记 offset/inode/size），不许按 mtime 整文件重读。
9. **不可逆操作**（删文件、退出 App）必须先 `display dialog` 确认；工具白名单之外的命令/AppleScript 一律拒绝。
10. **缓存写入规则**（`src/router.ts` `cacheableActions` + `src/cache.ts` `propose`）：
    - 只缓存「第一轮就规划完、全部成功」的动作；`unsupported`、`save_alias`、`applescript create_reminder` 永不缓存（`ToolSpec.noCache`，可按参数判断）；工具结果自带 `noCache`（open_saved 用户取消/只弹了候选列表）也不缓存。
    - **同一句话第二次得到相同规划才写入**；第一次只记进 `candidates`，CLI 打印「记为缓存候选」。规划不同 → 候选换成最新一次。
    - 每条带 `toolsVersion`（`TOOLS_VERSION` = 工具定义 + 缓存语义代号的 sha256 前 12 位）；不一致的条目在命中时删除、重走模型。改了回放语义但工具定义没变时，手动改 `src/tools.ts` 的 `CACHE_SEMANTICS`。
    - open_saved 的缓存动作带 `savedKey`（当时选中项的 key）：回放直接打开它，索引里没了或 `open` 失败才回退检索。
    - 文件格式 v2：`{v:2, entries, candidates}`。v1 扁平格式整体作废（2026-10-01 已迁移，清掉了 `测试autoenter916` 等测试污染）；测试/自检句（`POLLUTION_RE`）读时剔除。
11. **并发安全**（Alfred 开了并发执行）：cache.json、aliases.json 每次写都「加锁（`<file>.lock`，pid 判活，10 秒视为悬空）→ 重读盘上最新内容 → 合并本次改动 → `<file>.<pid>.<rand>.tmp` → rename」。缓存拿不到锁（5 秒）就只改内存不写盘，不阻塞指令。索引 items/titles/state 只有 `runIndex` 写，由 `index/lock` 互斥；按需刷新超时 → `AbortSignal` → 在文件边界停下、**正式文件一个字节不写**，并且 cli 等它真正退出后才继续（不会写到一半 `process.exit`）；提交时三个文件先全部写成 pid 临时文件再依次 rename，`state.json` 最后（被杀在中间只会重读一段字节，不丢条目）。单测：`test/concurrency.test.ts`（10 进程并发写缓存/别名一条不丢）。
12. **自检参数无副作用**：`va "__va_selftest__ <nonce>"` 只写 `logs/.selftest-<nonce>` 标记文件，不调模型、不碰缓存、不执行任何动作；`va doctor` 和 `alfred-install.py` 用它经 Alfred 外部触发验证整条链路，检完即删标记。

13. **截图和演示永远不许抢焦点**：`Sesame --demo …`（含 `macos/scripts/shoot.sh` 等一切截图脚本）和 `--test-script` 测试运行时，`Presentation.passive = true`（`macos/Sources/SesameCore/Presentation.swift`）：窗口只用 `orderFrontRegardless` 显示，**绝不成为 key window、不激活 App**，输入框只读、不做 first responder；状态 9（菜单栏下拉）会吃键盘，只有显式 `--allow-menu` 才开。正常按热键唤出面板仍然抢焦点。单测：`PresentationTests`。
    - **理由（2026-10-03 事故）**：演示面板原来调 `makeKeyAndOrderFront`，一出来就抢走键盘；另一个 agent 截图期间启动了约 25 次演示，用户当时打的字被面板吞了进去。这台机器上用户一直在用键盘，任何自动化画面都不许接收他的按键。

## 数据边界（什么会离开本机发给 DeepSeek）

DeepSeek 是境外/第三方处理。只发下面这些：

| 发什么 | 什么时候 | 不发什么 |
|---|---|---|
| 用户说的那句话 + system prompt（含本机已安装 App 名列表）+ 工具定义 | 每次缓存未命中 | — |
| open_saved 候选的「类型 + 标题 + 关键词片段」（`describeForModel`，URL/IP/路径先剥掉） | 本地检索分不出明显赢家时 | 完整 URL、文件路径；**无标题且只出现过一次的网页整条不发**（`isWeakWeb`） |
| 工具结果（只在进入第二轮时，即第一轮有工具失败） | 工具给了 `modelDisplay/modelData` 就只发这两项 | `read_clipboard`：只发字数/行数/是否像网址，**不发剪贴板全文**；`search_files`：只发数量和扩展名分布，**不发文件名和完整路径** |

本机给用户看的通知/对话框照常带完整内容（`display`）。新增工具时：凡是结果里有用户内容（文本、文件名、路径、联系人…），必须给 `modelDisplay/modelData`，并在 `test/wo024.test.ts` 里加「第二轮请求不含原文」的断言。

## 怎么改 / 编译 / 验证

```bash
cd ~/.voice-agent
npm test                      # 全部单测（路由、缓存、工具白名单、索引、检索）
npm run typecheck             # tsc --noEmit
npm run test:autoenter        # 编译打包签名到 autoenter/build/（不安装）+ Swift 判定自测
npm run build:autoenter       # 编译打包签名并安装到 bin/VA AutoEnter.app、重启 launchd（授权保持）
scripts/verify-autoenter-tcc.sh   # 已授权前提下：重编译后看新进程 accessibility_trusted=true
VA_DRY_RUN=1 va "打开交易大盘"   # 只打印将执行的动作
va-index / va-index --full     # 增量 / 全量索引
"bin/VA AutoEnter.app/Contents/MacOS/va-autoenter" --check   # 当前进程视角：权限、Alfred 是否在屏、能否读到输入框
va doctor                      # 只读体检：先看哪一项 ❌，按它给的一行修法做
bin/va-setup                   # 任何一环坏了先跑它（幂等；最后会经 Alfred 外部触发自检一次）
```

- 改 `src/**`：直接生效（Node 原生 type stripping，无构建）。加工具：在 `src/tools.ts` 的 `TOOLS` 里加并写单测。
- 改 `autoenter/main.swift`：`npm run build:autoenter`。不许手动 `swiftc` 后直接拷进 `bin/`（ad-hoc 签名 + 裸二进制，授权会失效）。
- 改 Alfred workflow：改 `scripts/build-alfred.ts` → `bin/va-setup`（会就地更新已装 workflow，目录 UUID 不变）。只想更新 workflow 不重编助手：`node --no-warnings scripts/build-alfred.ts && python3 scripts/alfred-install.py dist/build/info.plist`。
- va 退出码约定（Alfred 脚本依赖）：0 正常；1 = va 已处理的失败（用户已看到对话框，Alfred 只记日志不重复弹）；3 = 未捕获异常；127 = 找不到 node。非 0、非 1 → 记 `logs/alfred-errors.log` + 弹通知。
- 改 launchd：改 `launchd/*.plist` → `bin/va-setup`。

## 权限模型

| 权限 | 谁要 | 怎么给 | 迁移 |
|---|---|---|---|
| 辅助功能 | `VA AutoEnter.app`（bundle id `<prefix>.va-autoenter`，launchd 起） | `va-autoenter-setup`：打开面板 + 访达选中 `VA AutoEnter.app` → 拖进列表打开开关；出问题时用户自己跑 `tccutil reset Accessibility <prefix>.va-autoenter` 后重新授权 | **新电脑必须重新授权**：macOS TCC 数据库按机器存储、不随备份/迁移带走 |
| 自动化（AppleScript 控制 Finder/提醒事项） | va 首次删文件/建提醒时 | 系统弹框点允许 | 同上 |
| 模型 key | va | `config.yaml` 里 `providers.<name>.key` 指定的 env / 钥匙串 / 文件（都不在本仓） | 新电脑重新配置 |

未授权时 VA AutoEnter 不会静默失效：启动即写日志 `accessibility NOT granted…`，并发系统通知「语音回车助手需要授权，运行 va-autoenter-setup」（每天最多一次，戳记 `logs/.autoenter-nag-date`）；此时检测到听写也只记 `would fire but accessibility not granted`。

## Alfred 偏好格式（2026-10-01 查实，alfred-install.py 依据）

- workflow 目录：`Alfred.alfredpreferences/workflows/user.workflow.<UUID>/info.plist`；导入的 workflow 会被 Alfred 剥热键，所以入口用 fallback + 关键词，不用热键。
- 本机目录 `preferences/local/<机器 hash>` 是 Alfred 首次启动时生成的；没有时 `alfred-install.py` 先 `open -a "Alfred 5"` 等最多 30 秒。
- 退出 Alfred 后要**轮询到进程真的没了**再写 prefs（最多 20 秒，超时放弃）：Alfred 退出时会把内存里的旧 prefs 写回去。
- 外部触发自检：`osascript -e 'tell application id "com.runningwithcrayons.Alfred" to run trigger "va" in workflow "<prefix>.voice-agent" with argument "__va_selftest__ x1234"'`。调用它的终端/App 需要「自动化 → Alfred」权限（首次会弹系统框，报 -1743 就是没给）。
- fallback：`preferences/features/defaultresults/prefs.plist` 的 `fallbacks` 数组；workflow 项 `user.workflow.<目录UUID>.<fallback 触发器 uid>`（社区 dotfiles 交叉验证）。
- 主热键：`preferences/local/<机器 hash>/hotkey/prefs.plist` = `{default: {key: 49, mod: 1048576, string: "Space"}}`。改 prefs 前要先 `quit app "Alfred 5"`。
- Spotlight 的 ⌘Space 由用户在 系统设置→键盘→键盘快捷键→聚焦 里自己关（不许脚本改系统设置）。

## 已知限制

- **新电脑上要有签名身份**：证书私钥在钥匙串里，不在任何备份里。新机器先在 Xcode → Settings → Accounts → Manage Certificates 建一张 Apple Development 证书（或从旧机导出 .p12 导入），身份名不同就 `VA_SIGN_IDENTITY="<security find-identity 里的名字>" bin/va-setup`。没有身份时 va-setup 在第 1 步直接失败并说明原因。

- 签名证书到期后续期/换证书后 DR 里的证书 CN 可能变化 → 需要重新授权一次（重新跑 `va-autoenter-setup`）。
- 自动回车依赖「Typeless 每次结果都进剪贴板并写 typeless.db」，这是根据社区资料与文件修改时间推断的；Typeless 改实现会失效（日志里看不到 fired）。
- 极少数情况下误按：Alfred 框里手动粘贴的同时 3 秒内恰好有一次 Typeless 历史写入。
- 网页类索引标题来自对话上下文，质量一般；只出现在项目文件里、从没在对话正文里出现过的链接不会被索引（设计如此，只扫对话正文）。
- `open_saved` 需要模型挑选时会把候选标题/关键词发给 DeepSeek（境外/第三方处理），URL 不发；完整边界见「数据边界」。
- 索引降噪（`src/indexer.ts` `isNoise` / `extractUrlsFromText`）：不收 t.co 短链、x.com/twitter 帖子（`/<user>/status/…`）、GitHub Actions 运行页（`/actions/runs|jobs/`）、被「…」或「...」截断的 URL、va 自己的 `[DRY-RUN]`/`（演练）` 输出行里的链接。2026-10-01 降噪后全量重建：3879 → 2533 条（web 3308 → 1961）。
- 网页标题仍有脏数据（如 `<br><br>飞书文档`、整句话当标题），来自对话上下文里 URL 前的那段文字。
- 链式任务（先搜再基于结果操作）v1 不支持：第一轮工具全部成功就收尾。
