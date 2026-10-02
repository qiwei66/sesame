import Foundation
import SesameCore

/// Log file: ~/Library/Logs/Sesame/sesame.log (and stderr). Never contains keys: the app never sees them.
enum Log {
    static let url: URL = {
        var dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Sesame", isDirectory: true)
        #if SESAME_TEST_HOOKS
        if let d = ProcessInfo.processInfo.environment["SESAME_LOG_DIR"], !d.isEmpty { dir = URL(fileURLWithPath: d, isDirectory: true) }
        #endif
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("sesame.log")
    }()
    private static let q = DispatchQueue(label: "sesame.log")
    private static let fmt: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()

    static func write(_ s: String) {
        let line = "\(fmt.string(from: Date())) \(s)\n"
        FileHandle.standardError.write(line.data(using: .utf8)!)
        q.async {
            if let h = try? FileHandle(forWritingTo: url) {
                h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); try? h.close()
            } else {
                try? line.data(using: .utf8)!.write(to: url)
            }
        }
    }
}

struct RecentItem: Codable, Equatable {
    var title: String
    var url: String?
    var query: String
    var kind: String
    var date: Date
}

/// Per-user app state in UserDefaults (bundle id domain). Keys are listed here so Settings and the app agree.
enum Store {
    static let hotKeyKey = "hotKey"
    static let previewKey = "previewBeforeRun"
    static let recentKey = "recent"
    static let usageKey = "usage"
    static let providerKey = "providerDraft"
    /// the first-run panel popped up once already (the menu can show it again)
    static let introShownKey = "introShown"
    /// login item registered once on first launch (the Settings switch owns it afterwards)
    static let loginInitKey = "loginItemInitialized"

    static var introShown: Bool {
        get { UserDefaults.standard.bool(forKey: introShownKey) }
        set { UserDefaults.standard.set(newValue, forKey: introShownKey) }
    }

    /// the takeover step (use ⌘Space?) was answered once: not offered again at launch (Settings still offers it)
    static let takeoverAskedKey = "takeoverAsked"

    /// The key recorded in Settings; nil = automatic (⌘Space when free, else the backup key). A stored ⌥Space (the old
    /// default, written by the old reset button) reads as automatic.
    static var customHotKey: HotKeySpec? {
        get { HotKeyPlan.custom(fromStored: UserDefaults.standard.string(forKey: hotKeyKey)) }
        set {
            if let v = newValue { UserDefaults.standard.set(v.storageString, forKey: hotKeyKey) }
            else { UserDefaults.standard.removeObject(forKey: hotKeyKey) }
        }
    }

    /// The key registered right now (set by AppController after every registration). Every text that names the hot
    /// key reads this, so the copy always shows the key that actually works.
    nonisolated(unsafe) static var hotKey: HotKeySpec = .fallback

    /// the user chose ⌘Space in Settings (true) or declined it (false); absent = never chose (backup key)
    static let commandSpaceKey = "commandSpace"
    static var commandSpaceChoice: Bool? {
        get { UserDefaults.standard.object(forKey: commandSpaceKey) as? Bool }
        set {
            if let v = newValue { UserDefaults.standard.set(v, forKey: commandSpaceKey) }
            else { UserDefaults.standard.removeObject(forKey: commandSpaceKey) }
        }
    }

    static var takeoverAsked: Bool {
        get { UserDefaults.standard.bool(forKey: takeoverAskedKey) }
        set { UserDefaults.standard.set(newValue, forKey: takeoverAskedKey) }
    }

    static var previewBeforeRun: Bool { UserDefaults.standard.bool(forKey: previewKey) }

    static var recent: [RecentItem] {
        get {
            guard let d = UserDefaults.standard.data(forKey: recentKey) else { return [] }
            return (try? JSONDecoder().decode([RecentItem].self, from: d)) ?? []
        }
        set { UserDefaults.standard.set(try? JSONEncoder().encode(Array(newValue.prefix(20))), forKey: recentKey) }
    }

    static func remember(_ item: RecentItem) {
        var r = recent.filter { $0.title != item.title }
        r.insert(item, at: 0)
        recent = r
    }

    /// Month-to-date usage of requests made from the app. Shown only in Settings > Usage.
    struct Usage: Codable, Equatable {
        var month: String
        var requests = 0
        var cacheHits = 0
        var tokens = 0
        var amount = 0.0
        var currency = ""
    }

    static func monthKey(_ d: Date = Date()) -> String {
        let c = Calendar(identifier: .gregorian).dateComponents([.year, .month], from: d)
        return String(format: "%04d-%02d", c.year ?? 0, c.month ?? 0)
    }

    static var usage: Usage {
        get {
            if let d = UserDefaults.standard.data(forKey: usageKey), let u = try? JSONDecoder().decode(Usage.self, from: d), u.month == monthKey() { return u }
            return Usage(month: monthKey())
        }
        set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: usageKey) }
    }

    static func record(_ cost: CostTag?) {
        var u = usage
        u.requests += 1
        if cost?.cacheHit == true { u.cacheHits += 1 }
        u.tokens += cost?.tokens ?? 0
        if let e = cost?.estimate { u.amount += e.amount; u.currency = e.currency }
        usage = u
    }
}
