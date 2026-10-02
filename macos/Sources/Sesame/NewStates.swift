import SwiftUI
import SesameCore

// Second-batch panel states (design/prototype.html states 4 / h / t / m; DESIGN.md「第二批功能」).

/// First run: what your AI already made for you. Big number (level 1), six group counts (level 2), one real example
/// the user can open with ↩ (level 3, selected by default). Numbers come from the core's index as it builds.
struct IntroView: View {
    var card: IntroCard
    var onOpen: () -> Void
    var onChange: () -> Void
    var onShare: () -> Void = {}

    var body: some View {
        let shown = IntroCounts.visible(card.groups)
        let columns = Array(repeating: GridItem(.flexible(), spacing: 8), count: IntroCounts.columns(for: shown.count))
        return content(shown: shown, columns: columns)
    }

    @ViewBuilder private func content(shown: [IntroGroupKind], columns: [GridItem]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            // level 1: the line itself; the number rolls up inside the line under it (both strings: Localizable.strings)
            Text(L10n.t("intro.headline")).font(.ui(34, .semibold)).kerning(-1.0).foregroundColor(Tok.text1)
                .lineLimit(1).minimumScaleFactor(0.7)
            countLine.padding(.top, 8)
            HStack(alignment: .center, spacing: 8) {
                Text(L10n.t("intro.source")).font(.ui(12.5)).foregroundColor(Tok.text3)
                Spacer(minLength: 8)
                ShareChip(shared: card.shared, action: onShare)
            }
            .padding(.top, 6)
            LazyVGrid(columns: columns, spacing: 8) {
                // groups with nothing in them are not shown; the rest reflow (fewer than 3 = one row)
                ForEach(shown, id: \.self) { k in
                    HStack(spacing: 10) {
                        Image(systemName: IntroView.icon(k)).font(.ui(16)).foregroundColor(Tok.text2).frame(width: 20)
                        Text(L10n.t("intro.group.\(k.rawValue)")).font(.ui(13.5)).foregroundColor(Tok.text2)
                        Spacer(minLength: 4)
                        Text(IndexLine.count(card.count(k))).font(.ui(17, .semibold)).kerning(-0.34).monospacedDigit().foregroundColor(Tok.text1)
                    }
                    .padding(.leading, 12).padding(.trailing, 14)
                    .frame(height: 52)
                    .background(RoundedRectangle(cornerRadius: Tok.rRow).fill(Tok.card))
                    .overlay(RoundedRectangle(cornerRadius: Tok.rRow).strokeBorder(Tok.cardEdge, lineWidth: 0.5))
                }
            }
            .padding(.top, 18)
            if let s = card.sample {
                HStack(spacing: 12) {
                    Text(L10n.t("intro.try")).font(.ui(13)).foregroundColor(Tok.text3)
                    Text(L10n.f("intro.tryOpen", s.title)).font(.ui(15.5, .medium)).kerning(-0.15).foregroundColor(Tok.text1).lineLimit(1)
                    Spacer(minLength: 8)
                    ReturnKbd()
                }
                .padding(.leading, 14).padding(.trailing, 12)
                .frame(height: 56)
                .background(RoundedRectangle(cornerRadius: Tok.rRow).fill(Tok.sel))
                .overlay(RoundedRectangle(cornerRadius: Tok.rRow).strokeBorder(Tok.hair, lineWidth: 0.5))
                .contentShape(RoundedRectangle(cornerRadius: Tok.rRow))
                .onTapGesture(perform: onOpen)
                .accessibilityAddTraits(.isButton)
                .padding(.top, 12)
                .transition(.opacity)
            }
            if card.hotKeyTaken {
                HStack(spacing: 8) {
                    Image(systemName: "keyboard").font(.ui(14)).foregroundColor(Tok.text3)
                    Text(L10n.f("intro.hotkeyTaken", Store.hotKey.displayString)).font(.ui(12.5)).foregroundColor(Tok.text2)
                    Spacer(minLength: 8)
                    Button(action: onChange) {
                        Text(L10n.t("intro.change")).font(.ui(12.5, .medium)).foregroundColor(Tok.accent)
                            .padding(.horizontal, 10).frame(height: 26)
                            .background(RoundedRectangle(cornerRadius: Tok.rChip).fill(Tok.chip))
                            .overlay(RoundedRectangle(cornerRadius: Tok.rChip).strokeBorder(Tok.chipEdge, lineWidth: 0.5))
                    }
                    .buttonStyle(.plain)
                }
                .padding(.leading, 12).padding(.trailing, 6)
                .frame(height: 36)
                .padding(.top, 10)
            }
        }
        .padding(EdgeInsets(top: 18, leading: 10, bottom: 4, trailing: 10))
        .animation(.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.26), value: card.sample)
    }

    /// "2,708 个 AI 产物，一句话的事。": the number in a heavier, larger cut of the same line
    private var countLine: some View {
        let (a, b) = ShareCard.split(L10n.t("intro.count"))
        return (Text(a).font(.ui(17)).foregroundColor(Tok.text2)
            + Text(IndexLine.count(card.total)).font(.ui(24, .semibold)).foregroundColor(Tok.text1)
            + Text(b).font(.ui(17)).foregroundColor(Tok.text2))
            .monospacedDigit()
            .frame(height: 30, alignment: .bottomLeading)
    }

    static func icon(_ k: IntroGroupKind) -> String {
        switch k {
        case .dashboard: return "chart.line.uptrend.xyaxis"
        case .report: return "doc.text"
        case .deck: return "chart.bar.doc.horizontal"
        case .site: return "globe"
        case .pr: return "arrow.triangle.branch"
        case .file: return "doc"
        }
    }
}

/// Results while typing: ≤6 rows right under the field, or the one "let Sesame look for …" row.
struct LiveListView: View {
    var list: LiveList
    /// 0 → N: rows fade in 25 ms apart; N → M: replaced in place (no flashing on every keystroke)
    var appear: Bool
    var onOpen: (Int) -> Void
    var onHover: (Int) -> Void

    var body: some View {
        VStack(spacing: 2) {
            if list.isFallback {
                SeekRow(query: list.query)
                    .onTapGesture { onOpen(-1) }
            } else {
                // identity = position: the next keystroke replaces rows in place instead of inserting new ones
                ForEach(Array(list.items.enumerated()), id: \.offset) { i, c in
                    ResultRow(item: c, selected: i == list.selected)
                        .onHover { inside in if inside { onHover(i) } }
                        .onTapGesture { onOpen(i) }
                        .transition(appear ? .opacity.animation(.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.16).delay(Double(i) * 0.025)) : .identity)
                }
            }
        }
        .padding(.top, 8)
    }
}

/// "让 Sesame 去找「…」": nothing local matches, ↩ runs the full flow (intent preview → result).
struct SeekRow: View {
    var query: String
    var body: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: Tok.rTile).fill(Tok.chip)
                .overlay(RoundedRectangle(cornerRadius: Tok.rTile).strokeBorder(Tok.chipEdge, lineWidth: 0.5))
                .overlay(SeedMarkView(shineToken: 0, animate: false, size: 18).frame(width: 18, height: 18))
                .frame(width: 34, height: 34)
            VStack(alignment: .leading, spacing: 2) {
                Text(L10n.f("live.seek", query)).font(.ui(14.5, .medium)).foregroundColor(Tok.text1).lineLimit(1).truncationMode(.middle)
                Text(L10n.t("live.seekHint")).font(.ui(12)).foregroundColor(Tok.text3).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            ReturnKbd().frame(width: 22)
        }
        .padding(.leading, 10).padding(.trailing, 12)
        .frame(height: 56)
        .background(RoundedRectangle(cornerRadius: Tok.rRow).fill(Tok.sel))
        .overlay(RoundedRectangle(cornerRadius: Tok.rRow).strokeBorder(Tok.hair, lineWidth: 0.5))
        .contentShape(RoundedRectangle(cornerRadius: Tok.rRow))
        .accessibilityAddTraits(.isButton)
    }
}

/// Microphone notice before the system prompt (state m), and the follow-ups when it is off or unavailable.
struct MicNoticeView: View {
    var notice: MicNotice
    var onAnswer: (Bool) -> Void

    var body: some View {
        Card(padding: EdgeInsets(top: 16, leading: 16, bottom: 16, trailing: 16)) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 14) {
                    RoundedRectangle(cornerRadius: 12).fill(Tok.chip).frame(width: 46, height: 46)
                        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Tok.chipEdge, lineWidth: 0.5))
                        .overlay(Image(systemName: notice == .ask ? "mic" : "mic.slash").font(.ui(21)).foregroundColor(Tok.accent))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(title).font(.ui(16, .semibold)).kerning(-0.24).foregroundColor(Tok.text1).padding(.top, 1)
                        Text(detail).font(.ui(13)).foregroundColor(Tok.text2).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
                    }
                }
                HStack(spacing: 8) {
                    Spacer()
                    if notice == .ask {
                        Button { onAnswer(false) } label: {
                            Text(L10n.t("mic.notNow")).font(.ui(13, .medium)).foregroundColor(Tok.text1)
                                .padding(.horizontal, 14).frame(height: 32)
                                .background(RoundedRectangle(cornerRadius: 9).fill(Tok.chip))
                                .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Tok.chipEdge, lineWidth: 0.5))
                        }
                        .buttonStyle(.plain)
                    }
                    Button { onAnswer(notice == .ask) } label: {
                        HStack(spacing: 8) {
                            Text(notice == .ask ? L10n.t("mic.allow") : L10n.t("mic.ok")).font(.ui(13, .medium))
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
                }
                .padding(.top, 16)
            }
        }
    }

    private var title: String {
        switch notice {
        case .ask: return L10n.f("mic.title", Store.hotKey.displayString)
        case .denied: return L10n.t("mic.deniedTitle")
        case .unavailable: return L10n.t("mic.unavailableTitle")
        }
    }
    private var detail: String {
        switch notice {
        case .ask: return L10n.t("mic.body")
        case .denied: return L10n.t("mic.deniedBody")
        case .unavailable: return L10n.t("mic.unavailableBody")
        }
    }
}

/// First-run takeover (prototype states k / k2 / k3): offer ⌘Space while Spotlight or a launcher still holds it.
/// Sesame never changes their settings: "Open Settings" only opens the right page, then Sesame notices the change.
struct TakeoverView: View {
    var card: TakeoverCard
    var onAnswer: (Bool) -> Void

    var body: some View {
        Card(padding: EdgeInsets(top: 16, leading: 16, bottom: 16, trailing: 16)) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 14) {
                    RoundedRectangle(cornerRadius: 12).fill(Tok.chip).frame(width: 46, height: 46)
                        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Tok.chipEdge, lineWidth: 0.5))
                        .overlay(Image(systemName: card.done ? "checkmark" : "command").font(.ui(card.done ? 19 : 20)).foregroundColor(Tok.accent))
                    VStack(alignment: .leading, spacing: 4) {
                        Text(title).font(.ui(16, .semibold)).kerning(-0.24).foregroundColor(Tok.text1).padding(.top, 1)
                        md(note).font(.ui(12)).foregroundColor(Tok.text3).lineSpacing(2).fixedSize(horizontal: false, vertical: true)
                    }
                }
                if !card.done {
                    HStack(spacing: 8) {
                        Spacer()
                        Button { onAnswer(false) } label: {
                            Text(L10n.f("takeover.later", card.fallback.displayString)).font(.ui(13, .medium)).foregroundColor(Tok.text1)
                                .padding(.horizontal, 14).frame(height: 32)
                                .background(RoundedRectangle(cornerRadius: 9).fill(Tok.chip))
                                .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Tok.chipEdge, lineWidth: 0.5))
                        }
                        .buttonStyle(.plain)
                        Button { onAnswer(true) } label: {
                            HStack(spacing: 8) {
                                Text(primary).font(.ui(13, .medium))
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
                    }
                    .padding(.top, 16)
                }
            }
        }
    }

    private var key: String { HotKeySpec.commandSpace.displayString }
    private var title: String { card.done ? L10n.f("takeover.doneTitle", key) : L10n.f("takeover.title", key) }
    private var note: String {
        if card.done { return L10n.t("takeover.doneBody") }
        switch card.holder {
        case .alfred, .raycast: return L10n.f("takeover.launcher", key, card.holder!.appName)
        default: return L10n.t("takeover.spotlight")
        }
    }
    private var primary: String {
        switch card.holder {
        case .alfred, .raycast: return L10n.f("takeover.openApp", card.holder!.appName)
        default: return L10n.t("takeover.openSettings")
        }
    }
}

/// Secondary button on the first-run panel: same chip as "Change…" (Tok.chip / Tok.chipEdge), never the default.
struct ShareChip: View {
    var shared: Bool
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: shared ? "checkmark" : "square.and.arrow.up").font(.ui(11.5, .medium))
                Text(shared ? L10n.t("intro.shared") : L10n.t("intro.share")).font(.ui(12.5, .medium))
            }
            .foregroundColor(Tok.accent)
            .padding(.horizontal, 10).frame(height: 26)
            .background(RoundedRectangle(cornerRadius: Tok.rChip).fill(Tok.chip))
            .overlay(RoundedRectangle(cornerRadius: Tok.rChip).strokeBorder(Tok.chipEdge, lineWidth: 0.5))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("sesame.share")
    }
}
