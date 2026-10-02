import Foundation

/// Where a text change in the panel's input field came from.
/// The field editor tags changes explicitly, so no guessing is involved:
/// - `typed`: keyboard input, including an input method committing several characters at once (pinyin etc.)
/// - `paste`: the `paste:` action (⌘V, Edit menu), which is how dictation tools such as Typeless deliver text
/// - `external`: anything else that changed the value (accessibility value set, services); treated like a paste
public enum InsertSource: Equatable, Sendable {
    case typed
    case paste
    case external
}

/// Auto-submit rule for the panel input:
/// a single change that inserts at least `minBurst` characters from a non-keyboard source arms a timer;
/// when the text then stays unchanged for `settle` seconds, the text is submitted.
/// Any keyboard edit or deletion disarms it (the user is editing by hand and will press Return).
/// Further non-keyboard insertions while armed (dictation streaming in chunks) extend the timer.
public struct PasteCommitDetector: Sendable {
    public static let defaultMinBurst = 2
    public static let defaultSettle: TimeInterval = 0.4

    public let minBurst: Int
    public let settle: TimeInterval
    public private(set) var text: String
    /// When armed, the moment at which `fire(at:)` returns the text.
    public private(set) var deadline: Date?

    public init(text: String = "", minBurst: Int = PasteCommitDetector.defaultMinBurst, settle: TimeInterval = PasteCommitDetector.defaultSettle) {
        self.text = text
        self.minBurst = minBurst
        self.settle = settle
    }

    public var isArmed: Bool { deadline != nil }

    /// Clear state (panel shown again, query submitted, field cleared programmatically).
    public mutating func reset(text: String = "") {
        self.text = text
        deadline = nil
    }

    /// Feed every text change. Returns the new deadline (nil = not armed).
    @discardableResult
    public mutating func textDidChange(to newText: String, source: InsertSource, at now: Date) -> Date? {
        let inserted = PasteCommitDetector.insertedCount(old: text, new: newText)
        text = newText
        switch source {
        case .typed:
            deadline = nil
        case .paste, .external:
            if inserted >= minBurst {
                deadline = now.addingTimeInterval(settle)
            } else if inserted > 0, deadline != nil {
                deadline = now.addingTimeInterval(settle)
            } else {
                deadline = nil
            }
        }
        return deadline
    }

    /// Call when the timer fires. Returns the text to submit if the settle window has fully elapsed.
    public mutating func fire(at now: Date) -> String? {
        guard let d = deadline, now >= d else { return nil }
        deadline = nil
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    /// Number of characters (grapheme clusters) inserted by the change old -> new,
    /// computed as new minus the common prefix and suffix. A pure deletion yields 0.
    public static func insertedCount(old: String, new: String) -> Int {
        let a = Array(old), b = Array(new)
        var p = 0
        while p < a.count, p < b.count, a[p] == b[p] { p += 1 }
        var s = 0
        while s < a.count - p, s < b.count - p, a[a.count - 1 - s] == b[b.count - 1 - s] { s += 1 }
        return max(0, b.count - p - s)
    }
}
