import Foundation

// UI-agnostic description of what the panel shows. Labels that are UI chrome (verbs, chip names)
// stay semantic here and are localized by the app; names/urls come from the core's data.

public enum Verb: Equatable, Sendable { case open, query, trash, search, run }

public enum ChipKind: Equatable, Sendable {
    case local, web, artifact, file, system, app
    case candidates(Int)
    case results(Int)
    case files(Int)

    /// Map the index `kind` (docs/rpc.md search: artifact | local | web | file).
    public static func fromIndexKind(_ k: String) -> ChipKind {
        switch k {
        case "artifact": return .artifact
        case "local": return .local
        case "file": return .file
        case "app": return .app
        default: return .web
        }
    }
}

public struct IntentLine: Equatable, Sendable {
    public var verb: Verb
    public var target: String
    public var chip: ChipKind?
    public init(verb: Verb, target: String, chip: ChipKind?) { self.verb = verb; self.target = target; self.chip = chip }
}

public struct OpenedCard: Equatable, Sendable {
    public var name: String
    /// Monospaced address part of the provenance line (host[:port] or file name); may be empty.
    public var address: String
    /// Plain part of the provenance line; may be empty.
    public var source: String
    public var kind: ChipKind
    public init(name: String, address: String = "", source: String = "", kind: ChipKind) { self.name = name; self.address = address; self.source = source; self.kind = kind }
}

public struct InfoCard: Equatable, Sendable {
    public var name: String
    public var meta: String
    /// Big number, e.g. "150"; nil = show `text` as the headline instead.
    public var value: String?
    public var unit: String
    public var valueNote: String
    /// 0...1 for the meter; nil = no meter.
    public var fraction: Double?
    public var footLeft: String
    public var footRight: String
    public var text: String
    public init(name: String, meta: String = "", value: String? = nil, unit: String = "", valueNote: String = "", fraction: Double? = nil, footLeft: String = "", footRight: String = "", text: String = "") {
        self.name = name; self.meta = meta; self.value = value; self.unit = unit; self.valueNote = valueNote
        self.fraction = fraction; self.footLeft = footLeft; self.footRight = footRight; self.text = text
    }
}

public struct Candidate: Equatable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var address: String
    public var url: String?
    public var kind: ChipKind
    public init(id: String, title: String, address: String, url: String?, kind: ChipKind) { self.id = id; self.title = title; self.address = address; self.url = url; self.kind = kind }

    public init(hit: SearchHit) {
        self.init(id: hit.key, title: ResultMapper.displayTitle(hit.title, url: hit.url ?? "", kind: hit.kind),
                  address: ResultMapper.displayAddress(hit.url ?? ""), url: hit.url, kind: ChipKind.fromIndexKind(hit.kind))
    }
}

public struct ConfirmCard: Equatable, Sendable {
    public var title: String
    public var detail: String
    public var files: [(name: String, size: String)]
    public var moreCount: Int
    public init(title: String, detail: String, files: [(name: String, size: String)] = [], moreCount: Int = 0) {
        self.title = title; self.detail = detail; self.files = files; self.moreCount = moreCount
    }
    public static func == (a: ConfirmCard, b: ConfirmCard) -> Bool {
        a.title == b.title && a.detail == b.detail && a.moreCount == b.moreCount
            && a.files.map { $0.name + "|" + $0.size } == b.files.map { $0.name + "|" + $0.size }
    }
}

public struct MissCard: Equatable, Sendable {
    public var message: String
    public var done: String
    public var need: String
    public init(message: String, done: String, need: String) { self.message = message; self.done = done; self.need = need }
}

/// First-run groups, in the panel's fixed 3×2 order (core `indexStatus.groups` keys).
public enum IntroGroupKind: String, CaseIterable, Sendable { case dashboard, report, deck, site, pr, file }

/// First-run panel (prototype state 4 / h): live counts while the index builds, then one real example.
public struct IntroCard: Equatable, Sendable {
    /// counts shown right now (the app tweens them toward the core's numbers)
    public var total: Int
    public var groups: [IntroGroupKind: Int]
    /// "try: open …" row; nil = no clean recent example (the row is not shown)
    public var sample: Candidate?
    /// the hot key could not be registered: show "already used by another app" + "Change…"
    public var hotKeyTaken: Bool
    /// the share card was just saved to Downloads and copied: the Share button says so for a moment
    public var shared: Bool
    public init(total: Int = 0, groups: [IntroGroupKind: Int] = [:], sample: Candidate? = nil, hotKeyTaken: Bool = false, shared: Bool = false) {
        self.total = total; self.groups = groups; self.sample = sample; self.hotKeyTaken = hotKeyTaken; self.shared = shared
    }
    public func count(_ k: IntroGroupKind) -> Int { groups[k] ?? 0 }
}

/// Results while typing (prototype state t): ≤6 local matches, or one "let Sesame look for …" row when none match.
public struct LiveList: Equatable, Sendable {
    public static let maxRows = 6
    public var items: [Candidate]
    public var selected: Int
    /// the typed text, shown in the fallback row when `items` is empty
    public var query: String
    public init(items: [Candidate], selected: Int = 0, query: String) { self.items = Array(items.prefix(LiveList.maxRows)); self.selected = selected; self.query = query }
    public var isFallback: Bool { items.isEmpty }
    public var selectedItem: Candidate? { items.indices.contains(selected) ? items[selected] : nil }
}

/// Microphone notice outcomes shown in the panel (prototype state m and its follow-ups).
public enum MicNotice: Equatable, Sendable {
    /// before the system prompt: "Hold <hot key> and talk" + Allow microphone / Not now
    case ask
    /// the user (or a policy) said no: one human sentence + where to turn it on
    case denied
    /// this Mac has no speech recognizer for the language
    case unavailable
}

public enum PanelPhase: Equatable, Sendable {
    case idle
    case intro(IntroCard)
    /// first run: offer ⌘Space (prototype states k / k2 / k3)
    case takeover(TakeoverCard)
    case live(LiveList)
    case mic(MicNotice)
    case listening(final: String, interim: String)
    case resolving(IntentLine?)
    case success(IntentLine?, OpenedCard)
    case info(IntentLine?, InfoCard)
    case candidates(IntentLine?, [Candidate], selected: Int)
    case confirm(IntentLine?, ConfirmCard)
    case notFound(IntentLine?, MissCard)

    public var intentLine: IntentLine? {
        switch self {
        case .idle, .listening, .intro, .takeover, .live, .mic: return nil
        case .resolving(let l), .success(let l, _), .info(let l, _), .candidates(let l, _, _), .confirm(let l, _), .notFound(let l, _): return l
        }
    }
}

/// The "share my number" card (1200 × 675, the size X / Twitter shows uncropped). Only counts go on it: no titles,
/// paths or names. The footer points to the repository, the only public address.
public enum ShareCard {
    public static let width = 1200
    public static let height = 675
    public static let repo = "github.com/qiwei66/sesame"

    /// Groups printed on the card: the first-run groups that are not empty, in the panel's order
    public static func groups(_ g: [IntroGroupKind: Int]) -> [IntroGroupKind] { IntroCounts.visible(g) }

    /// Downloads/Sesame-<yyyyMMdd-HHmmss>.png
    public static func fileName(_ d: Date = Date()) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd-HHmmss"
        return "Sesame-\(f.string(from: d)).png"
    }

    /// A localized sentence with one "%@" for the number, split so the number can be styled: (before, after)
    public static func split(_ template: String) -> (String, String) {
        guard let r = template.range(of: "%@") else { return (template, "") }
        return (String(template[..<r.lowerBound]), String(template[r.upperBound...]))
    }
}
