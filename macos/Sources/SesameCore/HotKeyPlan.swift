import Foundation

/// Who is holding ⌘Space, so Sesame cannot use it. Sesame only reads their settings, never changes them.
public enum CommandSpaceHolder: String, Equatable, Sendable, CaseIterable {
    /// the system shortcut "Show Spotlight search" (symbolic hot key 64) is on
    case spotlight
    case alfred
    case raycast

    public var appName: String {
        switch self {
        case .spotlight: return "Spotlight"
        case .alfred: return "Alfred"
        case .raycast: return "Raycast"
        }
    }
}

/// The hot key Sesame registers right now, and why.
public struct HotKeyChoice: Equatable, Sendable {
    public var active: HotKeySpec
    /// the user picked a key in Settings (nil custom = automatic)
    public var isCustom: Bool
    /// automatic mode only: ⌘Space is taken by this, so the backup key is in use
    public var blockedBy: CommandSpaceHolder?
    public init(active: HotKeySpec, isCustom: Bool, blockedBy: CommandSpaceHolder?) {
        self.active = active; self.isCustom = isCustom; self.blockedBy = blockedBy
    }
    /// automatic mode is not on ⌘Space: Settings offers "Take over ⌘Space…"
    public var canTakeOver: Bool { !isCustom && active != .commandSpace }
}

/// The backup key ⌥⇧Space by default; ⌘Space only after the user chose it in Settings ("Take over ⌘Space…"), and
/// then only while nothing else holds it. A key the user recorded in Settings always wins.
public enum HotKeyPlan {
    /// - commandSpace: the user asked for ⌘Space (Settings › Take over ⌘Space…)
    /// - spotlightOn: Spotlight's ⌘Space shortcut is enabled (`SymbolicHotKeys.commandSpaceEnabled`)
    /// - launcher: a launcher whose saved hot key is ⌘Space (Alfred / Raycast), nil = none
    public static func choose(custom: HotKeySpec?, commandSpace: Bool, spotlightOn: Bool, launcher: CommandSpaceHolder?) -> HotKeyChoice {
        if let c = custom { return HotKeyChoice(active: c, isCustom: true, blockedBy: nil) }
        // the system shortcut wins over any app, so it is named first; once it is off, a launcher may still hold ⌘Space
        let holder: CommandSpaceHolder? = spotlightOn ? .spotlight : launcher
        if !commandSpace || holder != nil { return HotKeyChoice(active: .fallback, isCustom: false, blockedBy: holder) }
        return HotKeyChoice(active: .commandSpace, isCustom: false, blockedBy: nil)
    }

    /// The takeover card never pops up at launch (WO-20261003-002): first launch goes straight to the counts on the
    /// backup key; ⌘Space is offered in Settings only.
    public static let takeoverAtLaunch = false

    /// Whether the user wants ⌘Space. `stored` = what they chose in Settings (nil = never chose). Someone upgrading
    /// from a build that took ⌘Space by itself whenever it was free (`existingUser`, and it is free now) keeps it.
    public static func wantsCommandSpace(stored: Bool?, existingUser: Bool, commandSpaceFree: Bool) -> Bool {
        if let s = stored { return s }
        return existingUser && commandSpaceFree
    }

    /// What is stored under the `hotKey` default → the custom key (nil = automatic). The old default ⌥Space
    /// (written by the old "Reset to ⌥Space" button) counts as automatic: it is the key the Codex pet now takes.
    public static func custom(fromStored s: String?) -> HotKeySpec? {
        guard let s, let spec = HotKeySpec(storageString: s), spec != .optionSpace else { return nil }
        return spec
    }
}

/// `defaults read com.apple.symbolichotkeys AppleSymbolicHotKeys`: `{ "64": { enabled: 1, value: { parameters:
/// (65535, 49, 1048576), type: standard } } }`. parameters = (character, virtual key code, AppKit modifier flags).
/// 64 = Show Spotlight search, 65 = Finder search window, 60/61 = input sources.
public enum SymbolicHotKeys {
    public static let spotlightId = "64"
    static let modMask: UInt = (1 << 17) | (1 << 18) | (1 << 19) | (1 << 20)

    /// Is ⌘Space an enabled system shortcut? Missing dictionary or missing entry 64 = the macOS default, which is on.
    public static func commandSpaceEnabled(_ dict: [String: Any]?) -> Bool {
        guard let dict else { return true }
        var sawSpotlight = false
        for (id, raw) in dict {
            guard let e = raw as? [String: Any] else { continue }
            if id == spotlightId { sawSpotlight = true }
            let params = ((e["value"] as? [String: Any])?["parameters"] as? [Any]) ?? []
            let enabled = number(e["enabled"]).map { $0 != 0 } ?? false
            // an entry without parameters keeps its built-in key; only 64's built-in key is ⌘Space
            if params.count < 3 { if id == spotlightId && enabled { return true }; continue }
            guard enabled, let code = number(params[1]), let mods = number(params[2]) else { continue }
            if code == 49 && UInt(mods) & modMask == (1 << 20) { return true }
        }
        return !sawSpotlight
    }

    static func number(_ v: Any?) -> Int? {
        if let n = v as? NSNumber { return n.intValue }
        if let i = v as? Int { return i }
        if let b = v as? Bool { return b ? 1 : 0 }
        if let s = v as? String { return Int(s) }
        return nil
    }
}

/// Raycast keeps its hot key in `defaults read com.raycast.macos raycastGlobalHotkey`, e.g. "Command-49"
/// (modifier names, then the virtual key code). Missing = Raycast's default ⌥Space. Format taken from community
/// dotfiles (Raycast is not installed on the machine this was written on).
public enum RaycastHotKey {
    public static let defaultsDomain = "com.raycast.macos"
    public static let defaultsKey = "raycastGlobalHotkey"

    public static func parse(_ s: String?) -> HotKeySpec? {
        guard let s, !s.isEmpty else { return .optionSpace }
        let parts = s.split(separator: "-").map(String.init)
        guard let last = parts.last, let code = UInt32(last) else { return nil }
        var m: UInt32 = 0
        for p in parts.dropLast() {
            switch p.lowercased() {
            case "command", "cmd": m |= HotKeySpec.cmd
            case "option", "alt": m |= HotKeySpec.option
            case "control", "ctrl": m |= HotKeySpec.control
            case "shift": m |= HotKeySpec.shift
            default: return nil
            }
        }
        return HotKeySpec(keyCode: code, modifiers: m)
    }
}

/// The first-run takeover step (prototype states k / k2 / k3).
public struct TakeoverCard: Equatable, Sendable {
    /// who holds ⌘Space; nil together with `done` = Sesame just got it
    public var holder: CommandSpaceHolder?
    /// the key Sesame uses meanwhile (shown on the secondary button)
    public var fallback: HotKeySpec
    public var done: Bool
    public init(holder: CommandSpaceHolder?, fallback: HotKeySpec = .fallback, done: Bool = false) {
        self.holder = holder; self.fallback = fallback; self.done = done
    }
}

/// System Settings › Keyboard › Keyboard Shortcuts… › Spotlight (the anchor lands on that category; checked on macOS 26.5).
/// Opened with `open`: it shows the page, it changes nothing.
public enum SettingsLinks {
    public static let keyboardShortcuts = "x-apple.systempreferences:com.apple.Keyboard-Settings.extension?Spotlight"
    public static let alfredPreferences = "com.runningwithcrayons.Alfred-Preferences"
    public static let raycast = "com.raycast.macos"
}
