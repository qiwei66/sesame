import Foundation

/// Rules for results-while-typing (design/DESIGN.md「边打字边出结果」). UI-free so they are unit tested.
public enum LiveSearch {
    /// Keystroke → search debounce.
    public static let debounce: TimeInterval = 0.06

    /// Verbs that make a pasted text a command; single characters only where they rarely start a name
    /// ("看" is in 看板, "开" in 开机, so those stay out).
    private static let verbs = ["打开", "开一下", "找", "查", "搜", "看看", "看一下", "放一下", "播放", "删掉", "删除", "移到", "关掉", "发给", "把", "帮我", "给我", "让",
                                "open", "find", "show", "search", "play", "delete", "move", "close", "check", "launch", "trash"]

    /// Looks like a sentence, not a keyword: has a space, or a verb, or is longer than 6 characters.
    /// One rule for both places: a paste that looks like this runs at once, and ↩ on typed text that looks like this
    /// runs the full flow instead of opening the selected row. Short keywords ("交易大盘") stay in the live list.
    public static func isSentence(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return false }
        if t.count > 6 { return true }
        if t.contains(where: { $0.isWhitespace }) { return true }
        let lower = t.lowercased()
        return verbs.contains { lower.contains($0) }
    }

    /// ↩ on the live list.
    public enum ReturnAction: Equatable, Sendable { case submit(String), open(Int) }
    /// An app row on the selection always opens: app rows only match the whole typed name, and app names are often
    /// longer than six characters or have spaces ("typeless", "Visual Studio Code"), which would read as a sentence.
    public static func returnAction(query: String, list: LiveList) -> ReturnAction {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if list.selectedItem?.kind == .app { return .open(list.selected) }
        if isSentence(q) || list.selectedItem == nil { return .submit(q.isEmpty ? list.query : q) }
        return .open(list.selected)
    }

    /// Where the selection goes when the list changes. Before the user pressed an arrow key it is always the first row;
    /// after that it follows "that item" (by id) while it is still in the list, and falls back to the first row once it is gone.
    public static func selection(in items: [Candidate], chosenId: String?) -> Int {
        guard let id = chosenId, let i = items.firstIndex(where: { $0.id == id }) else { return 0 }
        return i
    }

    /// How the list changed, for the animation: 0 → N rows fade in one by one; N → M only resizes.
    public enum Change: Equatable, Sendable { case appear, update, none }
    public static func change(from old: Int, to new: Int) -> Change {
        if old == new && old == 0 { return .none }
        return old == 0 ? .appear : .update
    }
}

/// The first-run count roll (1.2 s, ease-out cubic, rolls once; later increases while indexing glide over 0.6 s).
public struct CountTween: Equatable, Sendable {
    public private(set) var from: Double
    public private(set) var to: Double
    public private(set) var start: Date
    public var duration: TimeInterval

    public init(value: Double = 0, duration: TimeInterval = 1.2, now: Date = Date()) {
        from = value; to = value; start = now; self.duration = duration
    }

    public func value(at now: Date) -> Double {
        guard duration > 0 else { return to }
        let k = min(1, max(0, now.timeIntervalSince(start) / duration))
        let e = 1 - pow(1 - k, 3)
        return from + (to - from) * e
    }

    public func isDone(at now: Date) -> Bool { now.timeIntervalSince(start) >= duration }

    /// Retarget from wherever the number is now (no jump back).
    public mutating func retarget(_ target: Double, now: Date, duration d: TimeInterval? = nil) {
        guard target != to else { return }
        from = value(at: now)
        to = target
        start = now
        if let d { duration = d }
    }
}

public enum IntroCounts {
    /// Core `groups` → the panel's six groups (unknown keys ignored, missing = 0).
    public static func groups(_ g: [String: Int]?) -> [IntroGroupKind: Int] {
        var out: [IntroGroupKind: Int] = [:]
        for k in IntroGroupKind.allCases { out[k] = g?[k.rawValue] ?? 0 }
        return out
    }

    /// The big number = what the AI made (links that were only mentioned do not count). An older core without `made`
    /// falls back to the item count.
    public static func total(_ s: IndexStatus?) -> Int {
        guard let s else { return 0 }
        if let m = s.made { return m }
        if let g = s.groups { return g.values.reduce(0, +) }
        return s.running ? max(s.progress?.items ?? 0, s.items) : s.items
    }

    /// Groups shown on the panel: the ones with something in them, in the fixed order. 3 per row; fewer than 3 = one row.
    public static func visible(_ g: [IntroGroupKind: Int]) -> [IntroGroupKind] {
        IntroGroupKind.allCases.filter { (g[$0] ?? 0) > 0 }
    }
    public static func columns(for n: Int) -> Int { max(1, min(3, n)) }
}

/// Alfred's own hot key, read from its preferences (`preferences/local/<hash>/hotkey/prefs.plist`:
/// `{ default: { key: 49, mod: …, string: "Space" } }`). `mod` is AppKit modifier flags on current Alfred
/// (⌘ = 1048576, ⌥ = 524288); a Carbon mask (⌥ = 2048) is accepted too.
public enum AlfredHotKey {
    public static func parse(_ plist: [String: Any]) -> HotKeySpec? {
        guard let d = plist["default"] as? [String: Any], let key = (d["key"] as? NSNumber)?.uint32Value,
              let mod = (d["mod"] as? NSNumber)?.uintValue else { return nil }
        return HotKeySpec(keyCode: key, modifiers: carbon(mod))
    }

    static func carbon(_ mod: UInt) -> UInt32 {
        if mod <= 0xFFFF { return UInt32(mod) }   // already a Carbon mask
        var m: UInt32 = 0
        if mod & (1 << 20) != 0 { m |= HotKeySpec.cmd }
        if mod & (1 << 17) != 0 { m |= HotKeySpec.shift }
        if mod & (1 << 19) != 0 { m |= HotKeySpec.option }
        if mod & (1 << 18) != 0 { m |= HotKeySpec.control }
        return m
    }
}
