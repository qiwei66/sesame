# Live list ranking (results while typing)

With ⌘Space handed to Sesame, the live list replaces Spotlight for opening apps, so typing an app's name must put that
app on the first row, every time. The list mixes two sources:

- **Installed apps**, matched inside Sesame.app (`macos/Sources/SesameCore/AppSearch.swift`, `AppCatalog.swift`).
- **What the AI made**, from the core's `search({ mode: "live" })` (`src/saved.ts` `searchLive`, [rpc.md](rpc.md)).

## Order

| Rank | What | Example |
|---|---|---|
| 1 | App name clearly matches: the whole name, its start, the start of a word, or its initials (≤ 3 rows; ≤ 2 for one typed character) | `typeless` → Typeless, `飞书` → Lark, `vsc` → Visual Studio Code, `feishu` / `wx` → pinyin |
| 2 | What the AI made, by name (the core's order) | `交易大盘` → the trading dashboard |
| 3 | App name only contains the text (≤ 2 rows) | `note` → Keynote, after Notes |
| 4 | Everything else the core returned: links that were only mentioned, and only when the text asks for web pages / links / articles | `typeless 链接` → a pasted GitHub repo |

At most 6 rows. ↩ opens the selected row; an app row always opens, even when the text would otherwise read as a sentence
(longer than six characters or with a space, like `typeless` or `Visual Studio Code`).

Within rank 1 and 3: whole name > start > word start > initials, then the shorter name, then alphabetical, so rows do not
jump between keystrokes. One typed character matches only the start of a name (`t` → Terminal, Typeless), never inside it.

## Which names an app answers to

Read from the bundle's own files at scan time, never while typing: the file name (`Lark.app`), `CFBundleDisplayName` /
`CFBundleName` in Info.plist, the same keys in `<lang>.lproj/InfoPlist.strings` (zh-Hans, zh_CN, zh-Hant, zh_TW, zh_HK,
en, Base) and in `InfoPlist.loctable` (newer system apps such as System Settings), and the name Finder shows. Chinese
names also match by toneless pinyin (`feishu`) and pinyin initials (`fs`). Names compare after NFKC, lower case, with
spaces and punctuation removed (the same rule as the core's `nameKey` in `src/apps.ts`).

Folders: `/Applications`, `/Applications/Utilities`, `/System/Applications`, `/System/Applications/Utilities`,
`~/Applications`, `/System/Library/CoreServices/Applications`. The same app in two folders shows once.

## Why apps are matched in the app, not in the core

- **Latency**: no RPC round trip and no subprocess per keystroke. Matching is string compares over a list held in memory
  (about 10 ms for 1000 apps in a debug build, `testMatchingAThousandAppsIsFast`); the core's `src/apps.ts` reads names
  with one `plutil` process per bundle, which is fine for a spoken sentence but not for a first scan the user is waiting on.
- **Icons**: the row shows the real icon (`NSWorkspace.icon(forFile:)`), which needs the bundle path in the app anyway.
- **Freshness**: the catalog scans once at launch on a background queue, then watches the folders (a dispatch source per
  folder) and rescans one second after a change, re-reading only bundles whose modification date changed. A new or
  removed app shows up without restarting Sesame.

## What the core leaves out

`searchLive` shows what the AI made for the user. The agent's own work files (briefs, scratchpad output) fill in only when
nothing else matches. Links that were only mentioned or read (`madeByAI` false: a repo someone pasted, a blog post) never
fill in for a miss: before WO-20261003-040 they did, so typing `typeless` showed someone else's GitHub repo with that word in its name,
labelled "Web page" while Typeless.app was missing. Each live result carries `made`, so the app can place links after
apps. An older core without `made` is treated as "all made".
