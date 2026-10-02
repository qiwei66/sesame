import Foundation

/// Health of the `va serve --stdio` child process, as the menu and the panel need it.
public enum CoreState: Equatable, Sendable {
    case starting
    case running
    /// Stopped retrying; the user has to fix something first (menu shows one line + how to fix, "Retry" restarts).
    case failed(CoreFailure)
}

public enum CoreFailure: Equatable, Sendable {
    /// no `va` found (SESAME_CORE / Settings / install locations)
    case coreNotFound
    /// `bin/va` exit 127: no node on this Mac
    case nodeMissing
    /// `bin/va` exit 125: node older than 22.18
    case nodeTooOld
    /// exited again and again without answering
    case crashing(status: Int32)

    /// Exit statuses that will not get better by restarting.
    public static func permanent(exitStatus s: Int32) -> CoreFailure? {
        switch s {
        case 127: return .nodeMissing
        case 125: return .nodeTooOld
        default: return nil
        }
    }
}

/// Restart policy: permanent exit statuses stop at once; anything else stops after `maxFailures` launches in a row
/// that never answered a request. A successful answer resets the count.
public struct RestartPolicy: Equatable, Sendable {
    public var maxFailures: Int
    public private(set) var failuresInARow = 0
    public init(maxFailures: Int = 3) { self.maxFailures = maxFailures }

    /// Returns nil = restart (after a backoff), or the failure to show.
    public mutating func didExit(status: Int32, answeredSinceLaunch: Bool) -> CoreFailure? {
        if answeredSinceLaunch { failuresInARow = 0 }
        if let p = CoreFailure.permanent(exitStatus: status) { return p }
        failuresInARow += 1
        return failuresInARow >= maxFailures ? .crashing(status: status) : nil
    }

    public mutating func reset() { failuresInARow = 0 }
}

/// Text for the menu's index row: "正在整理… 1,204 条" / "2,708 条 · 2 分钟前". Never a path.
public enum IndexLine {
    public static func text(_ s: IndexStatus?, now: Date = Date(), zh: Bool) -> String {
        guard let s else { return zh ? "正在连接…" : "Connecting…" }
        if s.running {
            let n = max(s.progress?.items ?? 0, s.items)
            return zh ? "正在整理… \(count(n)) 条" : "Indexing… \(count(n)) items"
        }
        if s.last == "failed" && s.updatedAt == nil { return zh ? "整理失败，稍后自动重试" : "Indexing failed, will retry" }
        guard let d = s.updatedDate else { return zh ? "还没整理过" : "Not indexed yet" }
        return zh ? "\(count(s.items)) 条 · \(ago(d, now: now, zh: true))" : "\(count(s.items)) items · \(ago(d, now: now, zh: false))"
    }

    public static func count(_ n: Int) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = Locale(identifier: "en_US_POSIX")
        f.usesGroupingSeparator = true
        f.groupingSeparator = ","
        f.groupingSize = 3
        return f.string(from: NSNumber(value: n)) ?? String(n)
    }

    /// One spacing rule for both languages ("2 分钟前", "2 min ago").
    public static func ago(_ d: Date, now: Date, zh: Bool) -> String {
        let s = max(0, now.timeIntervalSince(d))
        let m = Int(s / 60), h = Int(s / 3600), day = Int(s / 86400)
        if m < 1 { return zh ? "刚刚" : "just now" }
        if m < 60 { return zh ? "\(m) 分钟前" : "\(m) min ago" }
        if h < 24 { return zh ? "\(h) 小时前" : "\(h) h ago" }
        return zh ? "\(day) 天前" : "\(day) d ago"
    }
}

/// One-line human messages for a core that cannot run (menu top row and the panel's miss card).
public enum CoreMessage {
    public static func headline(_ f: CoreFailure, zh: Bool) -> String {
        switch f {
        case .coreNotFound: return zh ? "Sesame 的核心没装好" : "Sesame's core is not installed"
        case .nodeMissing: return zh ? "Sesame 需要 Node.js 22.18 或更新版本" : "Sesame needs Node.js 22.18 or newer"
        case .nodeTooOld: return zh ? "Node.js 版本太旧，需要 22.18 或更新" : "Node.js is too old, 22.18 or newer is needed"
        case .crashing: return zh ? "Sesame 的核心启动不起来" : "Sesame's core keeps stopping"
        }
    }

    public static func fix(_ f: CoreFailure, zh: Bool) -> String {
        switch f {
        case .coreNotFound: return zh ? "在源码目录里运行 make install，然后点菜单里的「重新连接」" : "Run make install in the source folder, then choose Reconnect in the menu"
        case .nodeMissing, .nodeTooOld: return zh ? "装上 Node.js（brew install node，或从 nodejs.org 下载），然后点菜单里的「重新连接」" : "Install Node.js (brew install node, or from nodejs.org), then choose Reconnect in the menu"
        case .crashing: return zh ? "点菜单里的「重新连接」；还不行就看 ~/Library/Logs/Sesame/sesame.log" : "Choose Reconnect in the menu; if it keeps failing see ~/Library/Logs/Sesame/sesame.log"
        }
    }
}
