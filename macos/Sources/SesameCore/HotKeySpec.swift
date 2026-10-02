import Foundation

/// A global hot key as Carbon key code + Carbon modifier mask (cmdKey 0x100, shiftKey 0x200, optionKey 0x800, controlKey 0x1000).
public struct HotKeySpec: Equatable, Codable, Sendable {
    public static let cmd: UInt32 = 0x0100
    public static let shift: UInt32 = 0x0200
    public static let option: UInt32 = 0x0800
    public static let control: UInt32 = 0x1000
    public static let spaceKeyCode: UInt32 = 49

    /// ⌘Space: Sesame's first choice. Used only when nothing else holds it (Spotlight's shortcut is off and no launcher
    /// has it); the user frees it in System Settings themselves, Sesame never changes that setting.
    public static let commandSpace = HotKeySpec(keyCode: spaceKeyCode, modifiers: cmd)
    /// ⌥⇧Space: the backup while ⌘Space is taken. Avoids ⌥Space (Codex pet / ChatGPT / Alfred / Raycast defaults),
    /// ⌃Space and ⌃⌥Space (input sources), ⌥⌘Space (Finder search), ⇧⌘Space (1Password), ⌃⌘Space (emoji viewer).
    public static let fallback = HotKeySpec(keyCode: spaceKeyCode, modifiers: option | shift)
    /// ⌥Space: the pre-2026-10-02 default. Stored values equal to it are migrated back to automatic once.
    public static let optionSpace = HotKeySpec(keyCode: spaceKeyCode, modifiers: option)

    public let keyCode: UInt32
    public let modifiers: UInt32

    public init(keyCode: UInt32, modifiers: UInt32) {
        self.keyCode = keyCode
        self.modifiers = modifiers & (HotKeySpec.cmd | HotKeySpec.shift | HotKeySpec.option | HotKeySpec.control)
    }

    public enum Rejection: Equatable, Sendable { case needsModifier }

    /// Why this combination cannot be used as Sesame's hot key (nil = acceptable). ⌘Space is allowed: whether it is
    /// free right now is a runtime question (Spotlight / launchers), answered by `HotKeyPlan`.
    public var rejection: Rejection? {
        if modifiers == 0 || modifiers == HotKeySpec.shift { return .needsModifier }
        return nil
    }

    /// "49:2048" in UserDefaults.
    public var storageString: String { "\(keyCode):\(modifiers)" }

    public init?(storageString s: String) {
        let parts = s.split(separator: ":").compactMap { UInt32($0) }
        guard parts.count == 2 else { return nil }
        self.init(keyCode: parts[0], modifiers: parts[1])
    }

    public var displayString: String {
        var s = ""
        if modifiers & HotKeySpec.control != 0 { s += "⌃" }
        if modifiers & HotKeySpec.option != 0 { s += "⌥" }
        if modifiers & HotKeySpec.shift != 0 { s += "⇧" }
        if modifiers & HotKeySpec.cmd != 0 { s += "⌘" }
        return s + HotKeySpec.keyName(keyCode)
    }

    static let names: [UInt32: String] = [
        49: "Space", 36: "↩", 48: "⇥", 53: "esc", 51: "⌫",
        0: "A", 11: "B", 8: "C", 2: "D", 14: "E", 3: "F", 5: "G", 4: "H", 34: "I", 38: "J", 40: "K", 37: "L", 46: "M",
        45: "N", 31: "O", 35: "P", 12: "Q", 15: "R", 1: "S", 17: "T", 32: "U", 9: "V", 13: "W", 7: "X", 16: "Y", 6: "Z",
        29: "0", 18: "1", 19: "2", 20: "3", 21: "4", 23: "5", 22: "6", 26: "7", 28: "8", 25: "9",
        122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8", 101: "F9", 109: "F10", 103: "F11", 111: "F12",
        50: "`", 27: "-", 24: "=", 33: "[", 30: "]", 41: ";", 39: "'", 43: ",", 47: ".", 44: "/", 42: "\\",
    ]

    public static func keyName(_ code: UInt32) -> String { names[code] ?? "#\(code)" }
}
