import Foundation

/// Turns a `handle` result into a panel phase. Uses only structured fields (`intent`, `cards[].ok`,
/// `layer`, `attention`, `dryRun`); display strings are shown as-is, never parsed for logic.
public enum ResultMapper {
    public enum Outcome: Equatable, Sendable {
        case phase(PanelPhase)
        /// open_saved did not land on one item: the app should run `search(query)` and show candidates.
        /// Only for an older core that does not return `candidates` itself.
        case searchCandidates(query: String, line: IntentLine)
    }

    public static func verb(for tool: String, readOnly: Bool) -> Verb {
        switch tool {
        case "open_saved", "open_url", "open_app": return .open
        case "trash_files": return .trash
        case "search_files": return .search
        default: return readOnly ? .query : .run
        }
    }

    public static func chip(for step: IntentStep) -> ChipKind? {
        switch step.tool {
        case "open_url": return .web
        case "open_app": return .app
        case "open_saved": return nil   // known only after search(); the app fills it in
        case "trash_files", "search_files": return .file
        default: return step.readOnly ? .system : nil
        }
    }

    public static func target(for step: IntentStep, fallback: String) -> String {
        for k in ["query", "name", "app", "title", "path", "command_id"] {
            if let s = step.args[k]?.stringValue, !s.isEmpty { return s }
        }
        if let u = step.args["url"]?.stringValue { return displayAddress(u) }
        return fallback
    }

    public static func intentLine(_ r: HandleResult) -> IntentLine? {
        guard let s = r.intent.first else { return nil }
        return IntentLine(verb: verb(for: s.tool, readOnly: s.readOnly), target: target(for: s, fallback: r.input), chip: chip(for: s))
    }

    public static func map(_ r: HandleResult) -> Outcome {
        var line = intentLine(r)
        let primary = r.intent.first
        let card = r.cards.first
        let failed = r.layer == "error" || r.cards.isEmpty || r.cards.allSatisfy { !$0.ok }
        let newCore = r.candidates != nil   // a core that returns candidates / opened itself (no second search)

        // the panel asks once; on yes the app resends with confirmed: true (the core shows no dialog of its own)
        if let c = r.needsConfirmation {
            return .phase(.confirm(line, ConfirmCard(title: c.message, detail: "")))
        }
        if let c = r.candidates, !c.isEmpty {
            line?.chip = .candidates(c.count)
            return .phase(.candidates(line, c.map(Candidate.init(hit:)), selected: 0))
        }
        if failed {
            if !newCore, let p = primary, p.tool == "open_saved", let q = p.args["query"]?.stringValue, !q.isEmpty, let line {
                return .searchCandidates(query: q, line: line)
            }
            if primary?.tool == "open_saved" { line?.chip = .results(0) }
            return .phase(.notFound(line, missCard(r)))
        }
        if let p = primary, p.needsConfirm, r.dryRun {
            return .phase(.confirm(line, ConfirmCard(title: card?.title ?? r.result, detail: card?.detail ?? "")))
        }
        if !newCore, let p = primary, p.tool == "open_saved", r.attention {
            // ran, but only a choice list came back (no single winner)
            if let q = p.args["query"]?.stringValue, let line { return .searchCandidates(query: q, line: line) }
        }
        if let p = primary, p.readOnly {
            return .phase(.info(line, infoCard(name: line?.target ?? "", text: card?.title ?? r.result)))
        }
        if let o = r.opened {
            let kind = ChipKind.fromIndexKind(o.kind)
            if var l = line, l.chip == nil { l.chip = kind; line = l }
            return .phase(.success(line, OpenedCard(name: displayTitle(o.title, url: o.url, kind: o.kind), address: displayAddress(o.url), source: "", kind: kind)))
        }
        let opened = OpenedCard(name: card?.title ?? r.result, address: "", source: card?.detail ?? "", kind: primary.flatMap(chip(for:)) ?? .web)
        return .phase(.success(line, opened))
    }

    /// Miss card: headline, what was already done, what the user can do next. Never an internal error code,
    /// never the same sentence twice, never the user's own words echoed back.
    public static func missCard(_ r: HandleResult) -> MissCard {
        let card = r.cards.first
        let message = card?.title.isEmpty == false ? card!.title : r.result
        var done = r.result == message ? "" : r.result
        var need = r.need ?? card?.detail ?? ""
        if done == r.input { done = "" }
        if need == r.input || need == message || need == done { need = "" }
        return MissCard(message: message, done: done, need: need)
    }

    /// Empty title → host (web / local) or file name → last path segment → the address.
    public static func displayTitle(_ title: String, url: String, kind: String) -> String {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty { return t }
        if kind == "file" || url.hasPrefix("/") || url.hasPrefix("~") {
            let n = (url as NSString).lastPathComponent
            if !n.isEmpty && n != "/" { return n }
        }
        if let u = URLComponents(string: url), let host = u.host, !host.isEmpty {
            if kind == "web" || kind == "local" {
                if (host == "127.0.0.1" || host == "localhost" || host == "::1"), let p = u.port { return "localhost:\(p)" }
                return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
            }
            if let seg = u.path.split(separator: "/").last { return String(seg).removingPercentEncoding ?? String(seg) }
            return host
        }
        if let seg = url.split(separator: "/").last { return String(seg) }
        return url
    }

    /// Success card for open_saved, using the index entry that was opened (structured title/url/kind).
    public static func enrich(_ c: OpenedCard, with hit: SearchHit) -> OpenedCard {
        var o = c
        o.name = hit.title
        o.address = displayAddress(hit.url ?? "")
        o.kind = ChipKind.fromIndexKind(hit.kind)
        return o
    }

    /// Info card from a one-line read-only result: the first number becomes the big figure.
    public static func infoCard(name: String, text: String) -> InfoCard {
        let pattern = #"(\d[\d,]*(?:\.\d+)?)\s*(%|[A-Za-z]{1,4})?"#
        guard let re = try? NSRegularExpression(pattern: pattern),
              let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let vr = Range(m.range(at: 1), in: text) else {
            return InfoCard(name: name, text: text)
        }
        let unit = Range(m.range(at: 2), in: text).map { String(text[$0]) } ?? ""
        var fraction: Double? = nil
        if unit == "%", let v = Double(text[vr].replacingOccurrences(of: ",", with: "")) { fraction = max(0, min(1, v / 100)) }
        return InfoCard(name: name, value: String(text[vr]), unit: unit, fraction: fraction, footLeft: text)
    }

    /// "https://example.com/a/b?x" -> "example.com/a/b"; "http://127.0.0.1:7341/" -> "localhost:7341"; files -> last path component.
    public static func displayAddress(_ url: String) -> String {
        guard !url.isEmpty else { return "" }
        if url.hasPrefix("/") || url.hasPrefix("~") { return (url as NSString).lastPathComponent }
        guard let u = URLComponents(string: url), let host = u.host else { return url }
        var h = (host == "127.0.0.1" || host == "::1") ? "localhost" : host
        if h.hasPrefix("www.") { h.removeFirst(4) }
        if let port = u.port { h += ":\(port)" }
        let path = u.path == "/" ? "" : u.path
        // long ids in the path (artifact ids, hashes) are cut like the design: "2b91…c04"
        let segs = path.split(separator: "/", omittingEmptySubsequences: false).map { seg -> String in
            let s = String(seg)
            guard s.count > 16, s.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }),
                  s.contains(where: { $0.isNumber }) else { return s }
            return "\(s.prefix(4))…\(s.suffix(3))"
        }
        return h + segs.joined(separator: "/")
    }
}
