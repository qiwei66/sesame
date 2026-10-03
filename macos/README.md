# Sesame for macOS (v0.1)

Native menu-bar app for the `va` core. It starts one long-lived `va serve --stdio` process and talks
JSON-RPC to it ([../docs/rpc.md](../docs/rpc.md)); it restarts the process if it exits.
Design source: [../design/DESIGN.md](../design/DESIGN.md), [../design/prototype.html](../design/prototype.html).

## Layout

| Path | What |
|---|---|
| `Package.swift` | Swift package (no Xcode project). `SesameCore` = UI-free logic, `Sesame` = AppKit/SwiftUI app |
| `Sources/SesameCore/` | RPC client, wire models, result → panel mapping, paste auto-commit, hot key spec, core locator |
| `Sources/Sesame/` | status item + menu, floating `NSPanel`, SwiftUI panel states, settings window, demo mode |
| `Resources/{en,zh-Hans}.lproj/` | `Localizable.strings` (copied into the .app by the build script) |
| `scripts/build-app.sh` | `swift build` → `build/Sesame.app` (Info.plist, icon, strings, codesign) |
| `Tests/SesameCoreTests/` | `swift test --package-path macos` |

## Behavior

- `LSUIElement`: menu bar only, no Dock icon. Menu: recent 5, index status, Settings…, Quit. No cost info anywhere
  except Settings → Usage.
- Hot key via Carbon `RegisterEventHotKey` (no permission needed). Default ⌥⇧Space; ⌘Space only after the user picks
  "Take over ⌘Space…" in Settings › Hot key (`Store.commandSpaceChoice`), and then only while it is free. "Free" =
  Spotlight's shortcut is off (read only: `com.apple.symbolichotkeys` entry 64) and no installed Alfred / Raycast has
  ⌘Space saved as its hot key (Alfred `hotkey/prefs.plist`, Raycast `raycastGlobalHotkey`). Sesame never writes system
  settings or another app's settings. A key recorded in Settings always wins; "Automatic" goes back. Every text that
  names the key shows the one registered right now (`Store.hotKey`). Upgrading from a build that took a free ⌘Space by
  itself keeps ⌘Space (`HotKeyPlan.wantsCommandSpace`).
- No takeover card at launch (`HotKeyPlan.takeoverAtLaunch = false`): first launch goes straight to the counts on
  ⌥⇧Space. From Settings › "Take over ⌘Space…": free → taken at once, "done" card; held → the takeover card: "Open
  Settings" opens System Settings › Keyboard › Keyboard Shortcuts › Spotlight
  (`x-apple.systempreferences:com.apple.Keyboard-Settings.extension?Spotlight`) or the launcher's settings; Sesame
  re-reads the settings once a second for 10 minutes and registers ⌘Space as soon as it is free. "Use ⌥⇧Space for now"
  or Esc: this takeover is dropped, back to ⌥⇧Space.
- Demo (`--demo`), screenshot and test-script runs never take the keyboard: `Presentation.passive` (CLAUDE.md
  invariant 13).
- First-run panel: "Share" renders `ShareCardView` (1200 × 675, counts only) to Downloads, selects it in Finder and
  copies it. `Sesame --demo 4 [--dark] --lang en --share-out <file.png>` writes the card with demo numbers.
- Panel: borderless non-activating floating `NSPanel` with `NSVisualEffectView`; 180 ms fade-in and one sheen
  across the mark are the only animations.
- Input: Return submits typed text. Text that arrives at once (≥2 characters via paste or an external value
  change, e.g. a dictation tool such as Typeless) is submitted after 400 ms without further change. Keyboard input,
  including an input method committing a whole word, never auto-submits (`PasteCommitDetector`).
- ↑ ↓ move through candidates, ↩ opens; on the confirm card ↩ is Cancel.
- First launch: the intro panel pops up once (counts from `indexStatus.groups`, climbing while the index builds, then one
  real example from `sample`); the menu item "See what your AI made" shows it again. Hot key conflicts (register failed,
  a system shortcut, or ChatGPT / the Codex app running while the key is ⌥Space) add "<key> is used by another app · Change…".
- Typing: every keystroke runs `search` (mode live, 60 ms debounce, never while an input method is composing), ≤6 rows,
  "let Sesame look for …" when nothing matches. A pasted whole sentence (a space or a verb, > 6 characters) still runs.
- Push-to-talk: hold the hot key > 300 ms to listen (SFSpeechRecognizer, on-device when supported), release to send.
  The first hold shows the microphone notice; the system prompt only comes after "Allow microphone".
- Open at login: SMAppService.mainApp, on by default (registered once at first launch), switch in Settings.
- Settings → "Preview the plan before running" asks the core for a dry-run plan first (intent preview and the
  in-panel confirm card) at the cost of one extra model call; off by default.

## Demo mode (screenshots, review)

```bash
macos/build/Sesame.app/Contents/MacOS/Sesame --demo 3 --light   # states: 1 2 3 5 6 7 8 9 0 4 h t1 t2 t3 v m s (prototype numbering)
macos/build/Sesame.app/Contents/MacOS/Sesame --demo 3 --dark --quit-after 6
```

Prints `[demo] state=… window=<id>`; capture just that window with `screencapture -o -l <id> out.png`.
States: 1 listening · 2 intent preview · 3 success · 5 info card · 6 candidates · 7 confirm · 8 English · 9 menu ·
0 not found · 4 first run · h first run + hot key taken · t1 / t2 / t3 typing (4 rows / 1 row / nothing matched) ·
v hold to talk · m microphone notice · s Settings (open at login). The first-run counts are the prototype's sample
numbers (313 in all …), not the real index.

Demo mode starts no core process and registers no hot key.

Test builds (`SESAME_SWIFT_FLAGS="-Xswiftc -DSESAME_TEST_HOOKS"`): `--test-script <file>` drives the handlers in-process
(see `TestScript.swift`; `type`, `paste`, `compose`, `hold`, `release`, `intro`, `latency` …), `--fake-speech "<sentence>"`
replaces the recognizer, `--fake-login on` keeps the real login items untouched, `SESAME_SHOT_DIR` captures each `shot`.

## Not in v0.1

- Model settings are a draft form that produces the `config.yaml` block; the core still reads config.yaml.
- Icons are SF Symbols; the design uses Phosphor (same meaning, slightly different drawing).
