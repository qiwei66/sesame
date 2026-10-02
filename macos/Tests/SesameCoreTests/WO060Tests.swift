import XCTest
@testable import SesameCore

/// WO-20261002-060: ⌘Space first, the backup key while Spotlight / a launcher holds it, the Settings key always wins.
final class WO060Tests: XCTestCase {
    // MARK: choice: Spotlight on/off × launcher on ⌘Space or not × custom key

    func testChoiceMatrix() {
        let custom = HotKeySpec(keyCode: 40, modifiers: HotKeySpec.control | HotKeySpec.option)   // ⌃⌥K
        for spotlight in [true, false] {
            for launcher in [nil, CommandSpaceHolder.alfred, .raycast] {
                // a key recorded in Settings wins whatever holds ⌘Space
                let c = HotKeyPlan.choose(custom: custom, commandSpace: true, spotlightOn: spotlight, launcher: launcher)
                XCTAssertEqual(c, HotKeyChoice(active: custom, isCustom: true, blockedBy: nil))
                XCTAssertFalse(c.canTakeOver)

                let a = HotKeyPlan.choose(custom: nil, commandSpace: true, spotlightOn: spotlight, launcher: launcher)
                XCTAssertFalse(a.isCustom)
                if spotlight {
                    XCTAssertEqual(a.active, .fallback); XCTAssertEqual(a.blockedBy, .spotlight, "the system shortcut is named first")
                } else if let l = launcher {
                    XCTAssertEqual(a.active, .fallback); XCTAssertEqual(a.blockedBy, l)
                } else {
                    XCTAssertEqual(a.active, .commandSpace); XCTAssertNil(a.blockedBy)
                }
                XCTAssertEqual(a.canTakeOver, a.blockedBy != nil)
            }
        }
    }

    func testThisMacAlfredOnCommandSpaceSpotlightOff() {
        // a real Mac on 2026-10-02: Spotlight's shortcut is off, Alfred has ⌘Space → backup key, Alfred copy, no grab
        let c = HotKeyPlan.choose(custom: nil, commandSpace: true, spotlightOn: false, launcher: .alfred)
        XCTAssertEqual(c.active.displayString, "⌥⇧Space")
        XCTAssertEqual(c.blockedBy, .alfred)
        XCTAssertNotEqual(c.active, .commandSpace)
    }

    func testCustomKeyCanBeCommandSpaceItself() {
        XCTAssertEqual(HotKeyPlan.choose(custom: .commandSpace, commandSpace: true, spotlightOn: false, launcher: nil).active, .commandSpace)
    }

    func testStoredValueMigration() {
        XCTAssertNil(HotKeyPlan.custom(fromStored: nil), "nothing stored = automatic")
        XCTAssertNil(HotKeyPlan.custom(fromStored: "49:2048"), "the old default ⌥Space reads as automatic")
        XCTAssertNil(HotKeyPlan.custom(fromStored: "junk"))
        XCTAssertEqual(HotKeyPlan.custom(fromStored: "40:6144"), HotKeySpec(keyCode: 40, modifiers: HotKeySpec.control | HotKeySpec.option))
        XCTAssertEqual(HotKeyPlan.custom(fromStored: "49:256"), .commandSpace)
    }

    // MARK: backup key avoids the known defaults

    func testBackupKeyAvoidsKnownShortcuts() {
        let sp = HotKeySpec.spaceKeyCode
        let taken: [(String, HotKeySpec)] = [
            ("Spotlight", .commandSpace),
            ("Codex pet / ChatGPT / Alfred / Raycast default", HotKeySpec(keyCode: sp, modifiers: HotKeySpec.option)),
            ("previous input source", HotKeySpec(keyCode: sp, modifiers: HotKeySpec.control)),
            ("next input source", HotKeySpec(keyCode: sp, modifiers: HotKeySpec.control | HotKeySpec.option)),
            ("Finder search window", HotKeySpec(keyCode: sp, modifiers: HotKeySpec.option | HotKeySpec.cmd)),
            ("1Password Quick Access", HotKeySpec(keyCode: sp, modifiers: HotKeySpec.shift | HotKeySpec.cmd)),
            ("Emoji & Symbols", HotKeySpec(keyCode: sp, modifiers: HotKeySpec.control | HotKeySpec.cmd)),
        ]
        for (name, k) in taken { XCTAssertNotEqual(HotKeySpec.fallback, k, name) }
    }

    // MARK: Spotlight state from `defaults read com.apple.symbolichotkeys AppleSymbolicHotKeys`

    private func entry(_ enabled: Any, _ code: Int, _ mods: Int) -> [String: Any] {
        ["enabled": enabled, "value": ["parameters": [65535, code, mods], "type": "standard"]]
    }

    func testSpotlightStateParsing() {
        // this Mac on 2026-10-02 (64 off, 65 Finder search ⌥⌘Space on, 60/61 input sources on)
        let real: [String: Any] = ["64": entry(false, 49, 1048576), "65": entry(true, 49, 1572864),
                                   "60": entry(true, 49, 262144), "61": entry(true, 49, 786432)]
        XCTAssertFalse(SymbolicHotKeys.commandSpaceEnabled(real))
        var on = real; on["64"] = entry(true, 49, 1048576)
        XCTAssertTrue(SymbolicHotKeys.commandSpaceEnabled(on))
        // NSNumber / Int forms the plist bridge may hand over
        XCTAssertTrue(SymbolicHotKeys.commandSpaceEnabled(["64": entry(NSNumber(value: 1), 49, 1048576)]))
        XCTAssertFalse(SymbolicHotKeys.commandSpaceEnabled(["64": entry(0, 49, 1048576)]))
        // never touched: entry 64 missing (or no dictionary at all) = the macOS default, on
        XCTAssertTrue(SymbolicHotKeys.commandSpaceEnabled(nil))
        XCTAssertTrue(SymbolicHotKeys.commandSpaceEnabled(["65": entry(true, 49, 1572864)]))
        // Spotlight moved to another key: ⌘Space is free
        XCTAssertFalse(SymbolicHotKeys.commandSpaceEnabled(["64": entry(true, 49, 1179648)]))   // ⇧⌘Space
        // some other system shortcut moved onto ⌘Space: not free
        XCTAssertTrue(SymbolicHotKeys.commandSpaceEnabled(["64": entry(false, 49, 1048576), "65": entry(true, 49, 1048576)]))
        // enabled without parameters keeps the built-in ⌘Space
        XCTAssertTrue(SymbolicHotKeys.commandSpaceEnabled(["64": ["enabled": true]]))
    }

    func testRaycastHotKeyParsing() {
        XCTAssertEqual(RaycastHotKey.parse("Command-49"), .commandSpace)
        XCTAssertEqual(RaycastHotKey.parse("Option-49"), .optionSpace)
        XCTAssertEqual(RaycastHotKey.parse("Control-2"), HotKeySpec(keyCode: 2, modifiers: HotKeySpec.control))
        XCTAssertEqual(RaycastHotKey.parse(nil), .optionSpace, "not set = Raycast's default ⌥Space")
        XCTAssertNil(RaycastHotKey.parse("Hyper-x"))
    }

    // MARK: copy names the key in use

    /// Every string that names the hot key takes it as an argument; no key glyph + "Space" is written out by hand.
    func testStringsNeverHardCodeTheHotKey() throws {
        let res = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../Resources")
        for lang in ["en", "zh-Hans"] {
            let url = res.appendingPathComponent("\(lang).lproj/Localizable.strings")
            let dict = try XCTUnwrap(NSDictionary(contentsOf: url) as? [String: String], "\(lang) strings load")
            for (k, v) in dict {
                XCTAssertNil(v.range(of: "[⌘⌥⌃⇧]+ ?Space", options: .regularExpression), "\(lang) \(k) hard-codes a key: \(v)")
            }
            for k in ["placeholder", "mic.title", "settings.loginHint", "intro.hotkeyTaken", "takeover.title", "takeover.later", "takeover.doneTitle"] {
                let t = try XCTUnwrap(dict[k], "\(lang) \(k)")
                for (choice, want) in [(HotKeyPlan.choose(custom: nil, commandSpace: true, spotlightOn: false, launcher: .alfred), "⌥⇧Space"),
                                       (HotKeyPlan.choose(custom: nil, commandSpace: true, spotlightOn: false, launcher: nil), "⌘Space")] {
                    let s = String(format: t, choice.active.displayString)
                    XCTAssertTrue(s.contains(want), "\(lang) \(k) follows the active key: \(s)")
                }
            }
            // launcher copy: the key, then the launcher's name (twice: "General › Alfred Hotkey")
            let l = String(format: try XCTUnwrap(dict["takeover.launcher"]), "⌘Space", "Alfred")
            XCTAssertTrue(l.contains("Alfred Hotkey") && l.contains("⌘Space"), l)
        }
    }

    /// The bold part of the takeover notes must really turn bold (CommonMark will not open `**` right before 「).
    func testTakeoverNotesBoldParses() throws {
        let res = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../Resources")
        for lang in ["en", "zh-Hans"] {
            let dict = try XCTUnwrap(NSDictionary(contentsOf: res.appendingPathComponent("\(lang).lproj/Localizable.strings")) as? [String: String])
            for k in ["takeover.spotlight", "takeover.launcher"] {
                let raw = String(format: try XCTUnwrap(dict[k]), "⌘Space", "Alfred")
                let a = try AttributedString(markdown: raw, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
                let plain = String(a.characters)
                XCTAssertFalse(plain.contains("*"), "\(lang) \(k) shows raw asterisks: \(plain)")
                XCTAssertTrue(a.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true }, "\(lang) \(k) has a bold part")
            }
        }
    }

    func testDeepLinkPointsAtSpotlightShortcuts() {
        XCTAssertEqual(SettingsLinks.keyboardShortcuts, "x-apple.systempreferences:com.apple.Keyboard-Settings.extension?Spotlight")
    }
}
