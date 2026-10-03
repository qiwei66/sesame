import Foundation

/// Installed apps in the live list (docs/live-ranking.md). Matching and ranking are pure and unit tested; the scan reads
/// bundle files only (no subprocess), so it runs in the app process: no RPC round trip per keystroke, and the panel
/// needs the bundle path anyway for the real icon.
public struct AppRecord: Equatable, Sendable {
    /// bundle path, what `NSWorkspace.open` launches
    public let path: String
    /// the name Finder shows in the user's language ("飞书" for Lark.app on a Chinese Mac)
    public let displayName: String
    /// every name the app answers to: bundle file name, CFBundleDisplayName / CFBundleName, localized names
    public let names: [String]
    /// comparable forms, computed once at scan time (typing only compares strings), each with the name it came from
    let keys: [Keyed]
    let wordKeys: [Keyed]
    let acronyms: [Keyed]

    struct Keyed: Equatable, Sendable { let key: String; let name: String }

    public init(path: String, displayName: String, names: [String]) {
        self.path = path
        self.displayName = displayName
        var all: [String] = []
        for n in [displayName] + names where !n.isEmpty && !all.contains(n) { all.append(n) }
        self.names = all
        var keys: [Keyed] = [], words: [Keyed] = [], acr: [Keyed] = []
        func add(_ k: String, _ n: String, to list: inout [Keyed]) { if !k.isEmpty && !list.contains(where: { $0.key == k }) { list.append(Keyed(key: k, name: n)) } }
        for n in all {
            add(AppSearch.key(n), n, to: &keys)
            let ws = AppSearch.words(n)
            for w in ws.dropFirst() { add(AppSearch.key(w), n, to: &words) }
            if ws.count >= 2 { add(ws.map { String($0.prefix(1)) }.joined().lowercased(), n, to: &acr) }
        }
        // 飞书 → "feishu" (typed as a name) and "fs" (initials); after the real names, so a real "Feishu" wins the key
        for n in all {
            if let py = AppSearch.pinyin(n) {
                add(py.joined(), n, to: &keys)
                if py.count >= 2 { add(py.map { String($0.prefix(1)) }.joined(), n, to: &acr) }
            }
        }
        self.keys = keys; self.wordKeys = words; self.acronyms = acr
    }
}

public enum AppSearch {
    /// How an app name matched what was typed. Lower = stronger. Everything up to `.acronym` counts as "the app name
    /// clearly matches" and ranks above what the AI made; `.substring` ranks below it.
    public enum Match: Int, Comparable, Sendable {
        case exact = 0, prefix, wordPrefix, acronym, substring
        public static func < (a: Match, b: Match) -> Bool { a.rawValue < b.rawValue }
        public var isStrong: Bool { self != .substring }
    }

    /// At most this many app rows above what the AI made (one typed letter: fewer, so artifacts stay in view)
    public static let maxStrong = 3
    public static let maxStrongOneChar = 2
    public static let maxWeak = 2

    /// NFKC, lower-case, no spaces / punctuation / symbols, no trailing ".app" (same rule as the core's src/apps.ts nameKey)
    public static func key(_ s: String) -> String {
        var t = s.precomposedStringWithCompatibilityMapping.lowercased()
        if t.hasSuffix(".app") { t.removeLast(4) }
        return String(String.UnicodeScalarView(t.unicodeScalars.filter { !CharacterSet.punctuationCharacters.contains($0) && !CharacterSet.symbols.contains($0) && !CharacterSet.whitespacesAndNewlines.contains($0) }))
    }

    /// Words of a name: split on spaces, punctuation and lower→upper case changes ("Visual Studio Code", "WeChat" → We Chat)
    public static func words(_ s: String) -> [String] {
        var out: [String] = [], cur = ""
        var prevLower = false
        for ch in s {
            if ch.isWhitespace || ch.isPunctuation || ch.isSymbol {
                if !cur.isEmpty { out.append(cur); cur = "" }
                prevLower = false
                continue
            }
            if ch.isUppercase && prevLower && !cur.isEmpty { out.append(cur); cur = "" }
            cur.append(ch)
            prevLower = ch.isLowercase
        }
        if !cur.isEmpty { out.append(cur) }
        return out
    }

    /// Han characters → toneless pinyin syllables ("飞书" → ["fei", "shu"]); nil when the name has no Han characters
    public static func pinyin(_ s: String) -> [String]? {
        guard s.unicodeScalars.contains(where: { $0.properties.isIdeographic }) else { return nil }
        guard let latin = s.applyingTransform(.mandarinToLatin, reverse: false)?.applyingTransform(.stripDiacritics, reverse: false) else { return nil }
        let parts = latin.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
        return parts.isEmpty ? nil : parts
    }

    /// Best match of `query` against one app, or nil
    public static func match(_ query: String, _ app: AppRecord) -> Match? { hit(key: key(query), app)?.match }

    /// `q` already in `key` form (computed once per keystroke, not once per app). `name` = the name that matched, shown
    /// as the row title: typing 飞书 shows 飞书 even where Finder says "Feishu" (an English-first Mac)
    static func hit(key q: String, _ app: AppRecord) -> (match: Match, name: String)? {
        guard !q.isEmpty else { return nil }
        if let k = app.keys.first(where: { $0.key == q }) { return (.exact, k.name) }
        if let k = app.keys.first(where: { $0.key.hasPrefix(q) }) { return (.prefix, k.name) }
        // one typed character only matches the start of the name (Spotlight does the same)
        guard q.count >= 2 else { return nil }
        if let k = app.wordKeys.first(where: { $0.key.hasPrefix(q) }) { return (.wordPrefix, k.name) }
        if let k = app.acronyms.first(where: { $0.key.hasPrefix(q) }) { return (.acronym, k.name) }
        if let k = app.keys.first(where: { $0.key.contains(q) }) { return (.substring, k.name) }
        return nil
    }

    /// Matching apps, strongest first; ties: shorter name, then alphabetical (stable across keystrokes)
    public static func search(_ query: String, in apps: [AppRecord]) -> [(app: AppRecord, match: Match, name: String)] {
        let q = key(query)
        return apps.compactMap { a in hit(key: q, a).map { (app: a, match: $0.match, name: $0.name) } }
            .sorted { x, y in
                if x.match != y.match { return x.match < y.match }
                if x.app.displayName.count != y.app.displayName.count { return x.app.displayName.count < y.app.displayName.count }
                return x.app.displayName.localizedStandardCompare(y.app.displayName) == .orderedAscending
            }
    }

    /// The live list: app clearly named (prefix / whole name / word start / initials) > what the AI made (name hit) >
    /// app name only contains it > everything else the core returned (links, when the user asked for them).
    /// `hits` are the core's live `search` results in its order; `made == nil` (older core) counts as made.
    public static func merge(query: String, apps: [AppRecord], hits: [SearchHit], limit: Int = LiveList.maxRows) -> [Candidate] {
        let found = search(query, in: apps)
        let oneChar = key(query).count <= 1
        let strong = found.filter { $0.match.isStrong }.prefix(oneChar ? maxStrongOneChar : maxStrong)
        let weak = found.filter { !$0.match.isStrong }.prefix(maxWeak)
        let made = hits.filter { $0.made ?? true }
        let other = hits.filter { !($0.made ?? true) }
        var out: [Candidate] = []
        out += strong.map { candidate($0.app, title: $0.name) }
        out += made.map(Candidate.init(hit:))
        out += weak.map { candidate($0.app, title: $0.name) }
        out += other.map(Candidate.init(hit:))
        var seen = Set<String>()
        return Array(out.filter { seen.insert($0.id).inserted }.prefix(limit))
    }

    public static func candidate(_ a: AppRecord, title: String? = nil) -> Candidate {
        Candidate(id: "app:" + a.path, title: title ?? a.displayName, address: folder(a.path), url: a.path, kind: .app)
    }

    /// The row's address line: the folder, without the leading "/" (the row highlights the first segment like a host):
    /// "/System/Applications/Utilities/Terminal.app" → "System/Applications/Utilities"; the home folder reads "~"
    static func folder(_ path: String, home: String = NSHomeDirectory()) -> String {
        let dir = (path as NSString).deletingLastPathComponent
        if dir == home { return "~" }
        if dir.hasPrefix(home + "/") { return "~" + dir.dropFirst(home.count) }
        return dir.hasPrefix("/") ? String(dir.dropFirst()) : dir
    }
}
