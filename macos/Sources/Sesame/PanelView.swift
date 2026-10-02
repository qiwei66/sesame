import AppKit
import SwiftUI
import SesameCore

/// Observable state behind the floating panel.
@MainActor
final class PanelModel: ObservableObject {
    @Published var query = ""
    @Published var phase: PanelPhase = .idle
    @Published var shineToken = 0
    /// Demo/screenshot mode turns the sheen off so stills are deterministic.
    var animate = true
    /// Set by the controller: submit the query (Return or paste auto-commit).
    var onSubmit: (String) -> Void = { _ in }
    var onOpenCandidate: (Candidate) -> Void = { _ in }
    var onHoverCandidate: (Int) -> Void = { _ in }
    var onConfirm: (Bool) -> Void = { _ in }
    var onDismiss: () -> Void = {}
    /// text, where it came from, and whether an input method is still composing (marked text: no search yet)
    var onTextChange: (String, InsertSource, Bool) -> Void = { _, _, _ in }
    /// the user moved the live-list selection with ↑↓ (the selection then follows that item)
    var onLiveMove: (String) -> Void = { _ in }
    /// microphone notice: true = Allow microphone, false = Not now / OK
    var onMic: (Bool) -> Void = { _ in }
    /// "<hot key> is taken" → Change…
    var onChangeHotKey: () -> Void = {}
    /// first-run panel: Share (save the number card to Downloads, reveal it, copy it)
    var onShare: () -> Void = {}
    /// takeover step: true = Open Settings (System Settings / the launcher's settings), false = Use the backup key for now
    var onTakeover: (Bool) -> Void = { _ in }
    /// push-to-talk is down: the listening row says "release to send" with pressed key caps
    @Published var holding = false
    /// the live list just went from empty to N rows: rows fade in one by one (otherwise they are replaced in place)
    @Published var liveAppear = false

    var hasBody: Bool { if case .idle = phase { return false }; if case .listening = phase { return false }; return true }

    /// What the panel height depends on (animated when it changes): the state and, for lists, the row count
    var heightKey: String {
        switch phase {
        case .idle, .listening: return "bar"
        case .live(let l): return "live\(l.isFallback ? 1 : l.items.count)"
        case .intro(let c): return "intro\(c.sample == nil ? 0 : 1)\(c.hotKeyTaken ? 1 : 0)"
        case .takeover(let c): return "take\(c.done ? "done" : c.holder?.rawValue ?? "")"
        case .candidates(_, let c, _): return "cand\(c.count)"
        default: return String(describing: phase).prefix(12).description
        }
    }

    func moveSelection(_ delta: Int) {
        if case .live(var l) = phase, !l.items.isEmpty {
            l.selected = (l.selected + delta + l.items.count) % l.items.count
            phase = .live(l)
            if let it = l.selectedItem { onLiveMove(it.id) }
            return
        }
        guard case .candidates(let l, let c, let s) = phase, !c.isEmpty else { return }
        phase = .candidates(l, c, selected: (s + delta + c.count) % c.count)
    }

    /// ↩ in the field: open the selected candidate, answer the confirm card, or submit the text.
    func returnPressed() {
        switch phase {
        case .live(let l):
            // a sentence runs the full flow; a short keyword opens the selected row
            switch LiveSearch.returnAction(query: query, list: l) {
            case .submit(let q): if !q.isEmpty { onSubmit(q) }
            case .open(let i): onOpenCandidate(l.items[i])
            }
        case .intro(let card) where query.trimmingCharacters(in: .whitespaces).isEmpty:
            if let s = card.sample { onOpenCandidate(s) }
        case .takeover(let c) where !c.done: onTakeover(true)
        case .mic(.ask): onMic(true)
        case .mic: onMic(false)
        case .candidates(_, let c, let s) where c.indices.contains(s): onOpenCandidate(c[s])
        case .confirm: onConfirm(false)   // Return = the default button = Cancel
        default:
            let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
            if !q.isEmpty { onSubmit(q) }
        }
    }
}

struct PanelView: View {
    @ObservedObject var model: PanelModel

    var body: some View {
        VStack(spacing: 0) {
            inputRow
            if model.hasBody {
                Rectangle().fill(Tok.hairStrong).frame(height: 0.5).padding(.horizontal, 22)
                bodyContent
                    .padding(.horizontal, 12)
                    .padding(.bottom, 12)
            }
        }
        .frame(width: Tok.panelWidth)
        .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: input row (60pt)

    private var inputRow: some View {
        HStack(spacing: 14) {
            ZStack {
                if case .listening = model.phase {
                    WaveView()
                } else {
                    SeedMarkView(shineToken: model.shineToken, animate: model.animate)
                }
            }
            .frame(width: 22, height: 22)

            ZStack(alignment: .leading) {
                if case .listening(let fin, let interim) = model.phase {
                    (Text(fin).foregroundColor(Tok.text2) + Text(interim).foregroundColor(Tok.text4))
                        .font(.ui(17)).lineLimit(1)
                } else {
                    InputField(model: model)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if case .listening = model.phase {
                if model.holding {
                    // push-to-talk: how to finish is "let go", shown with the pressed key caps
                    HStack(spacing: 6) {
                        Text(L10n.t("listening.release")).font(.ui(12)).foregroundColor(Tok.text3)
                        ForEach(HotKeyCaps.caps(Store.hotKey), id: \.self) { k in
                            Kbd(down: true) { Text(k).font(.ui(11, .medium)) }
                        }
                    }
                } else {
                    HStack(spacing: 6) {
                        Text(L10n.t("listening")).font(.ui(12)).foregroundColor(Tok.text3)
                        Kbd { Text("esc").font(.ui(11, .medium)) }
                    }
                }
            }
        }
        .padding(.horizontal, 22)
        .frame(height: 60)
        .overlay(alignment: .bottom) {
            if case .resolving = model.phase {
                // indeterminate seam: static in v0.1 (the only animations are the panel fade and the mark sheen)
                LinearGradient(colors: [.clear, Tok.accentSoft, .clear], startPoint: .leading, endPoint: .trailing)
                    .frame(width: 180, height: 1.5)
            }
        }
    }

    // MARK: body

    @ViewBuilder private var bodyContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let line = model.phase.intentLine { IntentRow(line: line) }
            switch model.phase {
            case .resolving: SkeletonCard()
            case .success(_, let o): OpenedCardView(card: o)
            case .info(_, let i): InfoCardView(card: i)
            case .candidates(_, let c, let s):
                CandidateList(items: c, selected: s, onOpen: { i in if c.indices.contains(i) { model.onOpenCandidate(c[i]) } },
                              onHover: { i in model.onHoverCandidate(i) })
            case .confirm(_, let c): ConfirmCardView(card: c, onConfirm: model.onConfirm)
            case .notFound(_, let m): MissCardView(card: m)
            case .intro(let card): IntroView(card: card, onOpen: { if let s = card.sample { model.onOpenCandidate(s) } }, onChange: model.onChangeHotKey, onShare: model.onShare)
            case .takeover(let card): TakeoverView(card: card, onAnswer: model.onTakeover)
            case .live(let l):
                LiveListView(list: l, appear: model.liveAppear, onOpen: { i in
                    if l.items.indices.contains(i) { model.onOpenCandidate(l.items[i]) } else { model.onSubmit(l.query) }
                }, onHover: { i in
                    guard case .live(var cur) = model.phase, cur.items.indices.contains(i), cur.selected != i else { return }
                    cur.selected = i
                    model.phase = .live(cur)
                    model.onLiveMove(cur.items[i].id)
                })
            case .mic(let n): MicNoticeView(notice: n, onAnswer: model.onMic)
            case .idle, .listening: EmptyView()
            }
        }
    }
}

// MARK: - pieces

struct WaveView: View {
    // static bar heights from the prototype's screenshot mode (.shot .listening .wave)
    private let scales: [CGFloat] = [0.38, 0.80, 1, 0.56, 0.30]
    var body: some View {
        HStack(spacing: 2.5) {
            ForEach(0..<5, id: \.self) { i in
                RoundedRectangle(cornerRadius: 2).fill(Tok.accent).frame(width: 2.5, height: 20 * scales[i])
            }
        }
        .frame(height: 20)
    }
}

struct Kbd<C: View>: View {
    var onFill = false
    /// pressed key cap (push-to-talk held): the --sel fill with a small inner shadow, 0.5pt lower
    var down = false
    @ViewBuilder var content: C
    var body: some View {
        content
            .foregroundColor(onFill ? Tok.onFill : Tok.text2)
            .padding(.horizontal, 5)
            .frame(minWidth: 20, minHeight: 20, maxHeight: 20)
            .background(RoundedRectangle(cornerRadius: Tok.rKbd).fill(onFill ? Tok.kbdOnFill : down ? Tok.sel : Tok.kbd))
            .overlay(RoundedRectangle(cornerRadius: Tok.rKbd).strokeBorder(onFill || down ? Color.clear : Tok.kbdEdge, lineWidth: 0.5))
            .overlay(down ? RoundedRectangle(cornerRadius: Tok.rKbd).stroke(Color.black.opacity(0.18), lineWidth: 1).blur(radius: 0.75).offset(y: 0.5)
                        .clipShape(RoundedRectangle(cornerRadius: Tok.rKbd)) : nil)
            .offset(y: down ? 0.5 : 0)
    }
}

/// "⌥⇧Space" → ["⌥", "⇧", "space"] for key caps.
enum HotKeyCaps {
    static func caps(_ spec: HotKeySpec) -> [String] {
        var out: [String] = []
        if spec.modifiers & HotKeySpec.control != 0 { out.append("⌃") }
        if spec.modifiers & HotKeySpec.option != 0 { out.append("⌥") }
        if spec.modifiers & HotKeySpec.shift != 0 { out.append("⇧") }
        if spec.modifiers & HotKeySpec.cmd != 0 { out.append("⌘") }
        let k = HotKeySpec.keyName(spec.keyCode)
        out.append(k == "Space" ? "space" : k)
        return out
    }
}

struct ReturnKbd: View {
    var onFill = false
    var body: some View { Kbd(onFill: onFill) { Image(systemName: "return").font(.ui(10, .medium)) } }
}

enum Icons {
    static func chip(_ c: ChipKind) -> String {
        switch c {
        case .local: return "terminal"
        case .web: return "globe"
        case .artifact: return "sparkle"
        case .file, .files: return "doc"
        case .system: return "externaldrive"
        case .app: return "app"
        case .candidates, .results: return "magnifyingglass"
        }
    }
}

struct KindChip: View {
    var kind: ChipKind
    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: Icons.chip(kind)).font(.ui(10.5))
            Text(L10n.chip(kind)).font(.ui(11.5, .medium))
        }
        .foregroundColor(Tok.text3)
        .padding(.horizontal, 7)
        .frame(height: 20)
        .background(RoundedRectangle(cornerRadius: 6).fill(Tok.chip))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Tok.chipEdge, lineWidth: 0.5))
        .fixedSize()
    }
}

struct IntentRow: View {
    var line: IntentLine
    var body: some View {
        HStack(spacing: 8) {
            Text(L10n.verb(line.verb)).font(.ui(12.5, .semibold)).foregroundColor(Tok.accent)
            Image(systemName: "chevron.right").font(.ui(8.5, .semibold)).foregroundColor(Tok.text4)
            Text(line.target).font(.ui(12.5, .medium)).foregroundColor(Tok.text2).lineLimit(1)
            if let c = line.chip { KindChip(kind: c) }
        }
        .padding(.horizontal, 10)
        .frame(height: 40)
    }
}

struct Card<C: View>: View {
    var padding: EdgeInsets
    @ViewBuilder var content: C
    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: Tok.rCard).fill(Tok.card))
            .overlay(RoundedRectangle(cornerRadius: Tok.rCard).strokeBorder(Tok.cardEdge, lineWidth: 0.5))
    }
}

struct DashTile: View {
    var kind: ChipKind
    var body: some View {
        RoundedRectangle(cornerRadius: 12)
            .fill(LinearGradient(colors: [Tok.dashTop, Tok.dashBottom], startPoint: .topLeading, endPoint: .bottomTrailing))
            .overlay(Image(systemName: tileIcon).font(.ui(21)).foregroundColor(.white))
            .frame(width: 46, height: 46)
            .shadow(color: Color.black.opacity(0.25), radius: 3, y: 1.5)
    }
    private var tileIcon: String {
        switch kind {
        case .local: return "chart.line.uptrend.xyaxis"
        case .web: return "globe"
        case .artifact: return "sparkle"
        case .file, .files: return "doc.text"
        case .app: return "app"
        default: return "checkmark"
        }
    }
}

struct OpenedCardView: View {
    var card: OpenedCard
    var body: some View {
        Card(padding: EdgeInsets(top: 12, leading: 10, bottom: 12, trailing: 12)) {
            HStack(spacing: 14) {
                DashTile(kind: card.kind)
                VStack(alignment: .leading, spacing: 3) {
                    (Text(L10n.t("done.opened") + " ").font(.ui(19, .medium)).foregroundColor(Tok.text3)
                        + Text(card.name).font(.ui(19, .semibold)).foregroundColor(Tok.text1))
                        .kerning(-0.38).lineLimit(1).truncationMode(.tail)
                    if !card.address.isEmpty || !card.source.isEmpty {
                        subline.lineLimit(1).truncationMode(.tail)
                    }
                }
            }
        }
    }
    private var subline: Text {
        var t = Text(card.address).font(.mono(12)).foregroundColor(Tok.text2)
        if !card.address.isEmpty && !card.source.isEmpty { t = t + Text("  ·  ").font(.ui(12.5)).foregroundColor(Tok.text4) }
        return t + Text(card.source).font(.ui(12.5)).foregroundColor(Tok.text3)
    }
}

struct SkeletonCard: View {
    var body: some View {
        HStack(spacing: 14) {
            RoundedRectangle(cornerRadius: 12).fill(Tok.skeleton).frame(width: 46, height: 46)
            GeometryReader { g in
                VStack(alignment: .leading, spacing: 8) {
                    RoundedRectangle(cornerRadius: 6).fill(Tok.skeleton).frame(width: g.size.width * 0.42, height: 14)
                    RoundedRectangle(cornerRadius: 6).fill(Tok.skeleton).frame(width: g.size.width * 0.64, height: 10)
                }
                .frame(maxHeight: .infinity, alignment: .center)
            }
            .frame(height: 46)
        }
        .padding(EdgeInsets(top: 12, leading: 10, bottom: 12, trailing: 12))
    }
}

struct InfoCardView: View {
    var card: InfoCard
    var body: some View {
        Card(padding: EdgeInsets(top: 14, leading: 16, bottom: 16, trailing: 16)) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    RoundedRectangle(cornerRadius: 8).fill(Tok.chip).frame(width: 28, height: 28)
                        .overlay(Image(systemName: "externaldrive").font(.ui(14)).foregroundColor(Tok.text2))
                    Text(card.name).font(.ui(13.5, .semibold)).foregroundColor(Tok.text1)
                    if !card.meta.isEmpty { Text(card.meta).font(.ui(12)).foregroundColor(Tok.text3) }
                }
                if let v = card.value {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(v).font(.ui(40, .semibold)).kerning(-1.4).monospacedDigit().foregroundColor(Tok.text1)
                        if !card.unit.isEmpty { Text(card.unit).font(.ui(17, .medium)).foregroundColor(Tok.text2) }
                        if !card.valueNote.isEmpty { Text(card.valueNote).font(.ui(13)).foregroundColor(Tok.text3).padding(.leading, 2) }
                    }
                    .padding(.top, 14)
                } else {
                    Text(card.text).font(.ui(19, .semibold)).foregroundColor(Tok.text1).padding(.top, 14)
                }
                if let f = card.fraction {
                    GeometryReader { g in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Tok.track)
                            Capsule().fill(Tok.fill).frame(width: g.size.width * f)
                        }
                    }
                    .frame(height: 6)
                    .padding(.top, 12)
                }
                if !card.footLeft.isEmpty || !card.footRight.isEmpty {
                    HStack {
                        Text(card.footLeft).font(.ui(12)).foregroundColor(Tok.text3).monospacedDigit()
                        Spacer(minLength: 8)
                        if !card.footRight.isEmpty {
                            HStack(spacing: 5) {
                                Image(systemName: "clock").font(.ui(11))
                                Text(card.footRight).font(.ui(12)).monospacedDigit()
                            }
                            .foregroundColor(Tok.text3)
                        }
                    }
                    .padding(.top, 10)
                }
            }
        }
    }
}

struct Favicon: View {
    var item: Candidate
    var body: some View {
        Group {
            switch item.kind {
            case .local where Favicon.isDashboard(item.title):
                RoundedRectangle(cornerRadius: Tok.rTile)
                    .fill(LinearGradient(colors: [Tok.dashTop, Tok.dashBottom], startPoint: .topLeading, endPoint: .bottomTrailing))
                    .overlay(Image(systemName: "chart.line.uptrend.xyaxis").font(.ui(15)).foregroundColor(.white))
            case .web:
                RoundedRectangle(cornerRadius: Tok.rTile)
                    .fill(LinearGradient(colors: [Tok.siteTop, Tok.siteBottom], startPoint: .topLeading, endPoint: .bottomTrailing))
                    .overlay(Text(String(item.title.prefix(1))).font(.ui(16, .bold)).foregroundColor(Tok.siteInk))
            case .artifact:
                RoundedRectangle(cornerRadius: Tok.rTile).fill(Tok.claudeBg)
                    .overlay(Image(systemName: "sparkle").font(.ui(15)).foregroundColor(Tok.claudeInk))
            default:
                RoundedRectangle(cornerRadius: Tok.rTile).fill(Tok.card)
                    .overlay(RoundedRectangle(cornerRadius: Tok.rTile).strokeBorder(Tok.hairStrong, lineWidth: 0.5))
                    .overlay(Image(systemName: Icons.chip(item.kind)).font(.ui(14)).foregroundColor(Tok.text1))
            }
        }
        .frame(width: 34, height: 34)
    }
    static func isDashboard(_ t: String) -> Bool { t.range(of: "看板|大盘|仪表盘|dashboard|board", options: [.regularExpression, .caseInsensitive]) != nil }
}

struct CandidateList: View {
    var items: [Candidate]
    var selected: Int
    /// click opens the row; hover moves the selection (the same --sel highlight the arrow keys use)
    var onOpen: (Int) -> Void = { _ in }
    var onHover: (Int) -> Void = { _ in }
    var body: some View {
        VStack(spacing: 2) {
            ForEach(Array(items.enumerated()), id: \.element.id) { i, c in
                ResultRow(item: c, selected: i == selected)
                    .onHover { inside in if inside { onHover(i) } }
                    .onTapGesture { onOpen(i) }
            }
        }
    }
}

/// One result row (candidates and the live list share it): favicon, title, address, kind chip, ↩ on the selected row.
struct ResultRow: View {
    var item: Candidate
    var selected: Bool
    var body: some View {
        HStack(spacing: 12) {
            Favicon(item: item)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title).font(.ui(14.5, .medium)).foregroundColor(Tok.text1).lineLimit(1)
                ResultRow.addressText(item.address).lineLimit(1).truncationMode(.middle)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            KindChip(kind: item.kind)
            ReturnKbd().opacity(selected ? 1 : 0).frame(width: 22)
        }
        .padding(.leading, 10).padding(.trailing, 12)
        .frame(height: 56)
        .background(RoundedRectangle(cornerRadius: Tok.rRow).fill(selected ? Tok.sel : Color.clear))
        .overlay(RoundedRectangle(cornerRadius: Tok.rRow).strokeBorder(selected ? Tok.hair : Color.clear, lineWidth: 0.5))
        .contentShape(RoundedRectangle(cornerRadius: Tok.rRow))
        .accessibilityAddTraits(.isButton)
    }
    /// Host part highlighted (text-2), rest text-3, like `.row .d .hl`.
    static func addressText(_ a: String) -> Text {
        let host = a.split(separator: "/", maxSplits: 1).first.map(String.init) ?? a
        let rest = String(a.dropFirst(host.count))
        return Text(host).font(.mono(11.5)).foregroundColor(Tok.text2) + Text(rest).font(.mono(11.5)).foregroundColor(Tok.text3)
    }
}

struct ConfirmCardView: View {
    var card: ConfirmCard
    var onConfirm: (Bool) -> Void
    var body: some View {
        Card(padding: EdgeInsets(top: 16, leading: 16, bottom: 16, trailing: 16)) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 14) {
                    RoundedRectangle(cornerRadius: 12).fill(Tok.chip).frame(width: 46, height: 46)
                        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Tok.chipEdge, lineWidth: 0.5))
                        .overlay(Image(systemName: "trash").font(.ui(21)).foregroundColor(Tok.danger))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(card.title).font(.ui(16, .semibold)).kerning(-0.24).foregroundColor(Tok.text1).padding(.top, 1)
                        md(card.detail).font(.ui(13)).foregroundColor(Tok.text2)
                    }
                }
                if !card.files.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(card.files.indices, id: \.self) { i in
                            HStack(spacing: 6) {
                                Text(card.files[i].name).font(.ui(12)).foregroundColor(Tok.text2)
                                Text(card.files[i].size).font(.mono(11)).foregroundColor(Tok.text3)
                            }
                            .padding(.horizontal, 9).frame(height: 26)
                            .background(RoundedRectangle(cornerRadius: Tok.rChip).fill(Tok.chip))
                            .overlay(RoundedRectangle(cornerRadius: Tok.rChip).strokeBorder(Tok.chipEdge, lineWidth: 0.5))
                            .fixedSize()
                        }
                        if card.moreCount > 0 {
                            Text(L10n.f("confirm.more", card.moreCount)).font(.ui(12)).foregroundColor(Tok.text3)
                                .padding(.horizontal, 9).frame(height: 26)
                                .overlay(RoundedRectangle(cornerRadius: Tok.rChip).strokeBorder(Tok.hairStrong, lineWidth: 0.5))
                                .fixedSize()
                        }
                    }
                    .padding(.leading, 60).padding(.top, 14)
                }
                HStack(spacing: 8) {
                    Spacer()
                    Button { onConfirm(true) } label: {
                        Text(L10n.t("confirm.trash")).font(.ui(13, .medium)).foregroundColor(Tok.danger)
                            .padding(.leading, 14).padding(.trailing, 12).frame(height: 32)
                            .background(RoundedRectangle(cornerRadius: 9).fill(Tok.chip))
                            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Tok.chipEdge, lineWidth: 0.5))
                    }
                    .buttonStyle(.plain)
                    Button { onConfirm(false) } label: {
                        HStack(spacing: 8) {
                            Text(L10n.t("confirm.cancel")).font(.ui(13, .medium))
                            ReturnKbd(onFill: true)
                        }
                        .foregroundColor(Tok.onFill)
                        .padding(.leading, 14).padding(.trailing, 6).frame(height: 32)
                        .background(RoundedRectangle(cornerRadius: 9).fill(Tok.fill))
                        .padding(3)
                        .background(RoundedRectangle(cornerRadius: 12).fill(Tok.focusRing))
                        .padding(-3)
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(.defaultAction)
                }
                .padding(.top, 16)
            }
        }
    }
}

struct MissCardView: View {
    var card: MissCard
    var body: some View {
        Card(padding: EdgeInsets(top: 14, leading: 16, bottom: 16, trailing: 16)) {
            VStack(alignment: .leading, spacing: 0) {
                Text(card.message).font(.ui(15, .semibold)).kerning(-0.15).foregroundColor(Tok.text1)
                Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 10) {
                    if !card.done.isEmpty {   // nothing done (e.g. the core cannot run): no empty "已经做了" row
                        GridRow {
                            Text(L10n.t("miss.done")).foregroundColor(Tok.text3).frame(width: 74, alignment: .leading)
                            md(card.done).foregroundColor(Tok.text2).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    if !card.need.isEmpty {
                        GridRow {
                            Text(L10n.t("miss.need")).foregroundColor(Tok.text3).frame(width: 74, alignment: .leading)
                            Text(card.need).foregroundColor(Tok.text1).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .font(.ui(13))
                .lineSpacing(3)
                .padding(.top, 12)
            }
        }
    }
}

/// Inline **bold** only (core strings and fixtures may mark the figure the user should read first).
func md(_ s: String) -> Text {
    Text((try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s))
}
