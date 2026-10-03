import Foundation

// Wire types for `va serve --stdio` (docs/rpc.md, RPC_VERSION 1). Unknown fields are ignored.

public struct PingResult: Codable, Equatable, Sendable {
    public let ok: Bool
    public let rpcVersion: Int
}

public struct IntentStep: Codable, Equatable, Sendable {
    public let tool: String
    public let args: [String: JSONValue]
    public let needsConfirm: Bool
    public let readOnly: Bool
    public let origin: String?

    public init(tool: String, args: [String: JSONValue] = [:], needsConfirm: Bool = false, readOnly: Bool = false, origin: String? = "builtin") {
        self.tool = tool; self.args = args; self.needsConfirm = needsConfirm; self.readOnly = readOnly; self.origin = origin
    }
}

public struct ResultCard: Codable, Equatable, Sendable {
    public let title: String
    public let detail: String
    public let tool: String
    public let ok: Bool
    public let dryRun: Bool
    public let attention: Bool

    public init(title: String, detail: String = "", tool: String, ok: Bool, dryRun: Bool = false, attention: Bool = false) {
        self.title = title; self.detail = detail; self.tool = tool; self.ok = ok; self.dryRun = dryRun; self.attention = attention
    }
}

/// Cost tag. Decoded so the Settings > Usage page can total it; never shown on the panel or the menu.
public struct CostTag: Codable, Equatable, Sendable {
    public struct Estimate: Codable, Equatable, Sendable {
        public let amount: Double
        public let currency: String
    }
    public let cacheHit: Bool?
    public let tokens: Int?
    public let ms: Int?
    public let estimate: Estimate?
}

/// What the core actually opened (handle `opened`, docs/rpc.md). `title` already falls back to host / file name.
public struct OpenedItem: Codable, Equatable, Sendable {
    public let key: String?
    public let title: String
    public let url: String
    /// artifact | local | web | file | app
    public let kind: String
    public let lastSeen: String?
    public let firstSeen: String?
    public let session: String?

    public init(key: String? = nil, title: String, url: String, kind: String, lastSeen: String? = nil, firstSeen: String? = nil, session: String? = nil) {
        self.key = key; self.title = title; self.url = url; self.kind = kind; self.lastSeen = lastSeen; self.firstSeen = firstSeen; self.session = session
    }
}

public struct ConfirmRequest: Codable, Equatable, Sendable {
    public let message: String
    public init(message: String) { self.message = message }
}

public struct HandleResult: Codable, Equatable, Sendable {
    public let input: String
    public let layer: String
    public let dryRun: Bool
    public let result: String
    public let attention: Bool
    public let error: String?
    /// Human "what you can do next" sentence for a miss (never an error code)
    public let need: String?
    public let intent: [IntentStep]
    public let cards: [ResultCard]
    public let cost: CostTag?
    /// The item the core really opened (success card shows this, not a second search)
    public let opened: OpenedItem?
    /// open_saved could not decide and left it to the user (no model, or the model was unsure)
    public let candidates: [SearchHit]?
    /// An irreversible step is waiting for the panel's confirm card; resend with confirmed: true on yes
    public let needsConfirmation: ConfirmRequest?
    public let cancelled: Bool?

    public init(input: String, layer: String = "llm", dryRun: Bool = false, result: String, attention: Bool = false, error: String? = nil, need: String? = nil,
                intent: [IntentStep], cards: [ResultCard], cost: CostTag? = nil, opened: OpenedItem? = nil, candidates: [SearchHit]? = nil,
                needsConfirmation: ConfirmRequest? = nil, cancelled: Bool? = nil) {
        self.input = input; self.layer = layer; self.dryRun = dryRun; self.result = result; self.attention = attention
        self.error = error; self.need = need; self.intent = intent; self.cards = cards; self.cost = cost
        self.opened = opened; self.candidates = candidates; self.needsConfirmation = needsConfirmation; self.cancelled = cancelled
    }
}

/// `indexStatus` / `index` result (docs/rpc.md). No paths: the core decides where the index lives.
public struct IndexStatus: Codable, Equatable, Sendable {
    public struct Progress: Codable, Equatable, Sendable {
        public let phase: String
        public let filesDone: Int
        public let filesTotal: Int
        public let items: Int
        public init(phase: String, filesDone: Int, filesTotal: Int, items: Int) { self.phase = phase; self.filesDone = filesDone; self.filesTotal = filesTotal; self.items = items }
    }
    public let running: Bool
    public let progress: Progress?
    public let items: Int
    public let updatedAt: String?
    public let last: String?
    public let lastError: String?
    /// First-run counts per group (dashboard / report / deck / site / pr / file); live while running. nil = older core
    public let groups: [String: Int]?
    /// What the AI made (= sum of `groups`); `items` also counts links that were only mentioned. nil = older core
    public let made: Int?

    public init(running: Bool, progress: Progress? = nil, items: Int, updatedAt: String?, last: String? = nil, lastError: String? = nil, groups: [String: Int]? = nil, made: Int? = nil) {
        self.running = running; self.progress = progress; self.items = items; self.updatedAt = updatedAt; self.last = last; self.lastError = lastError
        self.groups = groups; self.made = made
    }

    public var updatedDate: Date? {
        guard let s = updatedAt else { return nil }
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }
}

public struct SearchHit: Codable, Equatable, Sendable {
    public let key: String
    public let kind: String
    public let title: String
    public let url: String?
    public let score: Double?
    public let needsAuth: Bool?
    public let lastSeen: String?
    /// live search: the AI made it (false = a link that was only mentioned or read). nil = older core, counts as made
    public let made: Bool?

    public init(key: String, kind: String, title: String, url: String?, score: Double? = nil, needsAuth: Bool? = nil, lastSeen: String? = nil, made: Bool? = nil) {
        self.key = key; self.kind = kind; self.title = title; self.url = url; self.score = score; self.needsAuth = needsAuth; self.lastSeen = lastSeen
        self.made = made
    }
}

public struct SearchResult: Codable, Equatable, Sendable {
    public let query: String
    public let results: [SearchHit]
}

public struct DoctorCheck: Codable, Equatable, Sendable {
    public let name: String
    public let level: String
    public let detail: String
    public let fix: String?
}

public struct DoctorResult: Codable, Equatable, Sendable {
    public struct Summary: Codable, Equatable, Sendable { public let total: Int; public let ok: Int; public let warn: Int; public let fail: Int }
    public let checks: [DoctorCheck]
    public let summary: Summary
}

/// `sample` result: the first-run "try: open …" example from the user's own recent items (nil = show none).
public struct SampleResult: Codable, Equatable, Sendable {
    public let sample: OpenedItem?
    public init(sample: OpenedItem?) { self.sample = sample }
}
