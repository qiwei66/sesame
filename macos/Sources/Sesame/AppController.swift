import AppKit
import Combine
import SwiftUI
import SesameCore

@MainActor
final class AppController: NSObject, NSMenuDelegate {
    let panel = PanelController()
    private var statusItem: NSStatusItem!
    private var hotKey: HotKey!
    private(set) var rpc: RPCClient?
    private var detector = PasteCommitDetector()
    private var commitTimer: Timer?
    private var pendingConfirmText: String?
    private var settings: SettingsWindowController?
    var settingsController: SettingsWindowController? { settings }
    private var bag = Set<AnyCancellable>()
    private var requestSeq = 0
    /// Health of the core process; `.failed` = stopped retrying, the menu and the panel say what to fix.
    private(set) var coreState: CoreState = .starting
    /// Last index status from the core (`indexStatus`); drives the menu's index row.
    private(set) var indexStatus: IndexStatus?
    private var indexPoll: Task<Void, Never>?
    private var indexTimer: Timer?
    private var autoHide: DispatchWorkItem?
    private var resignObserver: NSObjectProtocol?
    private weak var indexMenuItem: NSMenuItem?
    // results while typing
    private var liveTimer: Timer?
    private var liveSeq = 0
    /// id of the row the user moved to with ↑↓ (nil = selection stays on the first row)
    private var liveChosenId: String?
    /// installed apps for the live list (scanned once, rescanned when an app folder changes)
    let apps = AppCatalog()
    // first run
    private var introVisible = false
    private var introTarget = IntroCard()
    private var tweens: [String: CountTween] = [:]
    private var tweenTimer: Timer?
    private var sampleTask: Task<Void, Never>?
    private var lastIntroLog = ""
    /// the hot key could not be registered (another app has it) or is a system shortcut
    private(set) var hotKeyTaken = false
    /// what is registered and why (⌘Space, the backup key while ⌘Space is held, or the key from Settings)
    private(set) var hotKeyChoice = HotKeyChoice(active: .fallback, isCustom: false, blockedBy: nil)
    /// takeover: re-reads who holds ⌘Space every second until it is free (or 10 minutes pass)
    private var takeoverTimer: Timer?
    private var takeoverUntil = Date.distantPast
    static let takeoverPoll: TimeInterval = 1.0
    static let takeoverWatchFor: TimeInterval = 600
    // push-to-talk
    private(set) var ptt: PushToTalkController!
    private var speech: SpeechRecognizing = SystemSpeech()
    /// Seconds the success card stays before the panel fades out (DESIGN.md: 「面板随后就会收起」).
    static let successDwell: TimeInterval = 0.8
    /// Incremental index while the app runs (the core keeps it cheap: byte offsets).
    static let indexInterval: TimeInterval = 30 * 60
    private var zh: Bool { L10n.language.hasPrefix("zh") }

    // MARK: launch

    func start(demo: DemoOptions?) {
        apps.onScan = { n, ms in Task { @MainActor in Log.write("[apps] scanned \(n) apps in \(ms)ms") } }
        if demo == nil { apps.start() }
        setupStatusItem()
        wirePanel()
        setupPushToTalk()
        if let demo {
            Demo.run(demo, app: self)
            return
        }
        #if SESAME_TEST_HOOKS
        if let script = TestScript.path(CommandLine.arguments) {
            // test builds only: no global hot key (the user's own Sesame keeps its key), drive handlers in-process
            startCore()
            TestScript.run(script, app: self)
            return
        }
        #endif
        hotKey = HotKey(onPress: { [weak self] in self?.ptt.keyDown() }, onRelease: { [weak self] in self?.ptt.keyUp() })
        applyHotKey(reason: "launch")
        LoginItem.registerOnFirstLaunch()
        startCore()
        firstLaunchIntro()
        let t = Timer(timeInterval: Self.indexInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.startIndex(reason: "timer") }
        }
        RunLoop.main.add(t, forMode: .common)
        indexTimer = t
    }

    func startCore() {
        rpc?.stop()
        rpc = nil
        let env = ProcessInfo.processInfo.environment
        let setting = UserDefaults.standard.string(forKey: CoreLocator.defaultsKey)
        guard let va = CoreLocator.resolve(env: env, setting: setting, home: FileManager.default.homeDirectoryForCurrentUser,
                                           isExecutable: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            Log.write("[rpc] core not found (set \(CoreLocator.envKey) or Settings > Core path)")
            setCoreState(.failed(.coreNotFound))
            return
        }
        setCoreState(.starting)
        let c = RPCClient(command: CoreLocator.command(for: va), log: { Log.write($0) })
        c.onStateChange = { [weak self] st in
            Task { @MainActor in self?.setCoreState(st) }
        }
        rpc = c
        c.start()
        Task {
            // first ping after launch; the client restarts the process if it exits (and gives up on node errors)
            for attempt in 1...5 {
                if case .failed = c.state { return }
                do {
                    let p = try await c.ping()
                    Log.write("[rpc] ping ok=\(p.ok) rpcVersion=\(p.rpcVersion) attempt=\(attempt)")
                    // every launch: incremental index in the background (the first one builds it from scratch)
                    startIndex(reason: "launch")
                    return
                } catch {
                    Log.write("[rpc] ping failed attempt=\(attempt): \(error.localizedDescription)")
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                }
            }
        }
    }

    private func setCoreState(_ s: CoreState) {
        coreState = s
        if case .failed(let f) = s { Log.write("[rpc] core unavailable: \(f)") }
        statusItem?.button?.appearsDisabled = { if case .failed = s { return true }; return false }()
        if let m = statusItem?.menu { rebuildMenu(m) }
    }

    // MARK: index (the core decides where it lives; the app only says "now" and shows progress)

    func startIndex(reason: String) {
        guard let rpc, indexPoll == nil else { return }
        indexPoll = Task { [weak self] in
            do {
                var st = try await rpc.index()
                Log.write("[index] start (\(reason)) running=\(st.running) items=\(st.items)")
                while true {
                    self?.updateIndex(st)
                    if !st.running { break }
                    try await Task.sleep(nanoseconds: (self?.introVisible ?? false) ? 400_000_000 : 1_500_000_000)
                    st = try await rpc.indexStatus()
                }
                Log.write("[index] finished last=\(st.last ?? "-") items=\(st.items)")
            } catch {
                Log.write("[index] status failed: \(error.localizedDescription)")
            }
            self?.indexPoll = nil
        }
    }

    private func updateIndex(_ st: IndexStatus) {
        indexStatus = st
        if introVisible { introIndexChanged(st) }
        // the menu may be open: update the row in place
        if let item = indexMenuItem { item.attributedTitle = Self.twoColumn(L10n.t("menu.index"), indexStatusText()) }
    }

    /// Decide the key (Settings key, else ⌘Space when free, else the backup key) and register it. Every text that
    /// names the hot key reads `Store.hotKey`, set here, so the copy follows the key that really works.
    @discardableResult
    func applyHotKey(reason: String) -> OSStatus {
        let choice = HotKey.currentChoice()
        hotKeyChoice = choice
        Store.hotKey = choice.active
        let st = hotKey?.register(choice.active) ?? noErr
        hotKeyTaken = HotKey.isTaken(choice.active, registerStatus: st)
        Log.write("[hotkey] \(reason): register \(choice.active.displayString) custom=\(choice.isCustom) blockedBy=\(choice.blockedBy?.rawValue ?? "none") status=\(st) taken=\(hotKeyTaken)")
        if introVisible { introTarget.hotKeyTaken = hotKeyTaken; renderIntro() }
        return st
    }

    func reregisterHotKey() -> OSStatus { applyHotKey(reason: "settings") }

    /// Settings opened: pick up a ⌘Space that was freed since launch.
    func refreshHotKeyIfChanged() {
        let c = HotKey.currentChoice()
        if c != hotKeyChoice { applyHotKey(reason: "changed") }
    }

    // MARK: takeover (first run: use ⌘Space?)

    /// `watch: false` only in test builds (a faked holder must not be corrected by this Mac's real settings).
    /// Shown only from Settings (Take over ⌘Space…), never at launch.
    func showTakeover(watch: Bool = true) {
        let c = hotKeyChoice
        guard c.canTakeOver, c.blockedBy != nil else { return }
        if !panel.isVisible { showPanel() }
        stopIntro()
        panel.model.phase = .takeover(TakeoverCard(holder: c.blockedBy, fallback: c.active))
        Log.write("[takeover] shown holder=\(c.blockedBy?.rawValue ?? "none") fallback=\(c.active.displayString)")
        if watch { watchTakeover() }
    }

    /// true = open the page where the user frees ⌘Space (Sesame changes nothing there); false = keep the backup key.
    func answerTakeover(_ yes: Bool) {
        guard case .takeover(let card) = panel.model.phase, !card.done else { return }
        if yes {
            openTakeoverSettings(card.holder)
            watchTakeover()
        } else {
            Store.takeoverAsked = true
            Store.commandSpaceChoice = false
            stopTakeoverWatch()
            applyHotKey(reason: "takeover declined")
            Log.write("[takeover] later: keeping \(Store.hotKey.displayString)")
            continueAfterTakeover()
        }
    }

    /// Opens a page or an app, never writes a setting.
    func openTakeoverSettings(_ holder: CommandSpaceHolder?) {
        switch holder {
        case .alfred, .raycast:
            let id = holder == .alfred ? SettingsLinks.alfredPreferences : SettingsLinks.raycast
            if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) {
                NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
            }
            Log.write("[takeover] opened \(id)")
        default:
            if let url = URL(string: SettingsLinks.keyboardShortcuts) { NSWorkspace.shared.open(url) }
            Log.write("[takeover] opened \(SettingsLinks.keyboardShortcuts)")
        }
    }

    /// From Settings (the only way in): the user wants ⌘Space. Free already → take it and say so; held by Spotlight /
    /// a launcher → the takeover card says where to free it, then Sesame waits and takes it.
    func beginTakeoverFromSettings() {
        Store.commandSpaceChoice = true
        applyHotKey(reason: "takeover from settings")
        Log.write("[takeover] from settings: holder=\(hotKeyChoice.blockedBy?.rawValue ?? "none")")
        if hotKeyChoice.active == .commandSpace { Store.takeoverAsked = true; showTakeoverDone(); return }
        showTakeover()
    }

    private func watchTakeover() {
        takeoverUntil = Date().addingTimeInterval(Self.takeoverWatchFor)
        guard takeoverTimer == nil else { return }
        let t = Timer(timeInterval: Self.takeoverPoll, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.takeoverTick() } }
        RunLoop.main.add(t, forMode: .common)
        takeoverTimer = t
    }

    private func stopTakeoverWatch() { takeoverTimer?.invalidate(); takeoverTimer = nil }

    private func takeoverTick() {
        if Date() > takeoverUntil { stopTakeoverWatch(); Log.write("[takeover] stopped watching (timeout)"); return }
        let c = HotKey.currentChoice()
        if !c.canTakeOver {
            stopTakeoverWatch()
            applyHotKey(reason: "takeover")
            Store.takeoverAsked = true
            if hotKeyChoice.active == .commandSpace { showTakeoverDone() }
            return
        }
        // Spotlight turned off but a launcher still has ⌘Space (or the other way round): say who it is now
        if case .takeover(let card) = panel.model.phase, !card.done, card.holder != c.blockedBy {
            panel.model.phase = .takeover(TakeoverCard(holder: c.blockedBy, fallback: c.active))
            Log.write("[takeover] holder now \(c.blockedBy?.rawValue ?? "none")")
        }
    }

    func showTakeoverDone() {
        if !panel.isVisible { showPanel() }
        panel.model.phase = .takeover(TakeoverCard(holder: nil, done: true))
        Log.write("[takeover] done: \(Store.hotKey.displayString)")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { [weak self] in
            guard let self, case .takeover(let c) = self.panel.model.phase, c.done else { return }
            self.continueAfterTakeover()
        }
    }

    /// After the takeover step: the first-run counts if they were never shown, otherwise close.
    private func continueAfterTakeover() {
        if !Store.introShown { Store.introShown = true; showIntro() } else { dismiss(reason: "takeover answered") }
    }

    /// Test builds: set the choice (and the copy's key) without registering anything.
    func applyChoiceForTest(_ c: HotKeyChoice) { hotKeyChoice = c; Store.hotKey = c.active }

    /// Test builds drive the "taken" notice without fighting the user's own Sesame for the key.
    func setHotKeyTaken(_ v: Bool) {
        hotKeyTaken = v
        if introVisible { introTarget.hotKeyTaken = v; renderIntro() }
    }

    // MARK: status item + menu (recent 5, index status, settings, quit; never cost)

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = SeedPath.templateImage()
        statusItem.button?.setAccessibilityLabel("Sesame")
        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false
        statusItem.menu = menu
        rebuildMenu(menu)
    }

    nonisolated func menuNeedsUpdate(_ menu: NSMenu) {
        MainActor.assumeIsolated { rebuildMenu(menu) }
        Task { @MainActor in await self.refreshIndexStatus() }
    }

    private func refreshIndexStatus() async {
        guard indexPoll == nil, let rpc, let st = try? await rpc.indexStatus() else { return }
        updateIndex(st)
    }

    var statusItemButton: NSStatusBarButton? { statusItem?.button }
    var statusMenu: NSMenu? { statusItem?.menu }
    var demoRecent: [RecentItem]?
    var demoIndexLine: String?

    func rebuildMenu(_ menu: NSMenu) {
        menu.removeAllItems()
        menu.appearance = NSApp.appearance   // nil = follow the system; --light/--dark in demo mode
        if case .failed(let f) = coreState {
            // the core cannot run: one line saying why, one saying how to fix, and a way to try again
            let h = NSMenuItem(title: CoreMessage.headline(f, zh: zh), action: nil, keyEquivalent: "")
            h.isEnabled = false
            h.image = NSImage(systemSymbolName: "exclamationmark.circle", accessibilityDescription: nil)
            menu.addItem(h)
            let fix = NSMenuItem(title: "", action: nil, keyEquivalent: "")
            fix.attributedTitle = NSAttributedString(string: CoreMessage.fix(f, zh: zh), attributes: [.font: NSFont.menuFont(ofSize: 12), .foregroundColor: NSColor.secondaryLabelColor])
            fix.isEnabled = false
            menu.addItem(fix)
            let retry = NSMenuItem(title: L10n.t("menu.reconnect"), action: #selector(reconnect), keyEquivalent: "")
            retry.target = self
            retry.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: nil)
            menu.addItem(retry)
            menu.addItem(.separator())
        }
        let header = NSMenuItem(title: L10n.t("menu.recent"), action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        let items = Array((demoRecent ?? Store.recent).prefix(5))
        if items.isEmpty {
            let e = NSMenuItem(title: L10n.t("menu.empty"), action: nil, keyEquivalent: "")
            e.isEnabled = false
            menu.addItem(e)
        }
        for (i, r) in items.enumerated() {
            let mi = NSMenuItem(title: r.title, action: #selector(openRecent(_:)), keyEquivalent: "")
            mi.target = self
            mi.tag = i
            mi.attributedTitle = Self.twoColumn(r.title, Self.relative(r.date))
            mi.image = NSImage(systemSymbolName: Icons.chip(ChipKind.fromIndexKind(r.kind)), accessibilityDescription: nil)
            menu.addItem(mi)
        }
        menu.addItem(.separator())
        let idx = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        idx.attributedTitle = Self.twoColumn(L10n.t("menu.index"), demoIndexLine ?? indexStatusText())
        idx.image = NSImage(systemSymbolName: "folder", accessibilityDescription: nil)
        idx.isEnabled = false
        indexMenuItem = idx
        menu.addItem(idx)
        menu.addItem(.separator())
        let w = NSMenuItem(title: L10n.t("menu.intro"), action: #selector(showIntroFromMenu), keyEquivalent: "")
        w.target = self
        w.image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: nil)
        menu.addItem(w)
        let s = NSMenuItem(title: L10n.t("menu.settings"), action: #selector(openSettings), keyEquivalent: ",")
        s.target = self
        s.image = NSImage(systemSymbolName: "gearshape", accessibilityDescription: nil)
        menu.addItem(s)
        let q = NSMenuItem(title: L10n.t("menu.quit"), action: #selector(quit), keyEquivalent: "q")
        q.target = self
        q.image = NSImage(systemSymbolName: "power", accessibilityDescription: nil)
        menu.addItem(q)
    }

    /// "label<TAB>right" with a right-aligned tab stop at 250pt (menu width ~300).
    static func twoColumn(_ left: String, _ right: String) -> NSAttributedString {
        let p = NSMutableParagraphStyle()
        p.tabStops = [NSTextTab(textAlignment: .right, location: 250)]
        p.lineBreakMode = .byTruncatingTail
        let s = NSMutableAttributedString(string: left, attributes: [.font: NSFont.menuFont(ofSize: 13), .paragraphStyle: p])
        if !right.isEmpty {
            s.append(NSAttributedString(string: "\t" + right, attributes: [.font: NSFont.menuFont(ofSize: 12), .foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: p]))
        }
        return s
    }

    /// Same wording and spacing as the index row ("2 分钟前" / "2 min ago")
    static func relative(_ d: Date) -> String { IndexLine.ago(d, now: Date(), zh: L10n.language.hasPrefix("zh")) }

    /// "正在整理… 1,204 条" / "313 条 · 2 分钟前" from structured fields (never a path)
    func indexStatusText() -> String {
        if case .failed = coreState { return L10n.t("menu.indexUnavailable") }
        return IndexLine.text(indexStatus, zh: zh)
    }

    @objc private func reconnect() { startCore() }

    @objc private func showIntroFromMenu() { showIntro() }

    /// First launch: the intro pops up once by itself; afterwards only the menu shows it.
    func firstLaunchIntro() {
        // no takeover card at launch: the backup key works right away, ⌘Space is a choice in Settings
        if !HotKeyPlan.takeoverAtLaunch, hotKeyChoice.canTakeOver {
            Log.write("[takeover] not offered at launch: using \(hotKeyChoice.active.displayString); ⌘Space is in Settings")
        }
        guard !Store.introShown else { Log.write("[intro] already shown once: not popping up"); return }
        Store.introShown = true
        showIntro()
    }

    @objc private func openRecent(_ sender: NSMenuItem) {
        let items = Store.recent
        guard items.indices.contains(sender.tag) else { return }
        let r = items[sender.tag]
        if let u = r.url, !u.isEmpty, let url = u.hasPrefix("/") ? URL(fileURLWithPath: u) : URL(string: u) { NSWorkspace.shared.open(url) }
        else { showPanel(); submit(r.query) }
    }

    @objc func openSettings() {
        if settings == nil { settings = SettingsWindowController(app: self) }
        settings?.show()
    }

    @objc private func quit() { rpc?.stop(); NSApp.terminate(nil) }

    // MARK: panel

    private func wirePanel() {
        let m = panel.model
        m.onSubmit = { [weak self] q in self?.submit(q) }
        m.onDismiss = { [weak self] in self?.dismiss(reason: "esc") }
        panel.panel.onCancel = { [weak self] in self?.dismiss(reason: "esc") }
        m.onOpenCandidate = { [weak self] c in self?.open(c) }
        m.onConfirm = { [weak self] yes in self?.answerConfirm(yes) }
        m.onTextChange = { [weak self] text, src, composing in self?.textChanged(text, src, composing: composing) }
        m.onHoverCandidate = { [weak self] i in self?.hoverCandidate(i) }
        m.onLiveMove = { [weak self] id in self?.liveChosenId = id }
        m.onMic = { [weak self] yes in self?.answerMic(yes) }
        m.onTakeover = { [weak self] yes in self?.answerTakeover(yes) }
        m.onChangeHotKey = { [weak self] in self?.dismiss(reason: "change hot key"); self?.openSettings() }
        m.onShare = { [weak self] in self?.shareIntro() }
        m.objectWillChange.sink { [weak self] _ in DispatchQueue.main.async { self?.panel.fit() } }.store(in: &bag)
        // clicking anywhere else takes the key focus away: close, except while the user still has to choose
        resignObserver = NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: panel.panel, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.panelLostFocus() }
        }
    }

    func toggle() { panel.isVisible ? dismiss(reason: "hotkey") : showPanel() }

    func showPanel() {
        cancelAutoHide()
        let m = panel.model
        // a closed panel never keeps a request alive (dismiss cancels it), so always start clean
        m.phase = .idle
        m.query = ""
        m.holding = false
        liveChosenId = nil
        detector.reset(text: m.query)
        panel.show(animated: true)
    }

    /// Close the panel. Anything still running is cancelled in the core and its answer is ignored here,
    /// so nothing opens a few seconds after the user pressed Esc.
    func dismiss(reason: String) {
        cancelAutoHide()
        commitTimer?.invalidate()
        liveTimer?.invalidate()
        liveSeq += 1
        stopIntro()
        ptt?.cancel()
        panel.model.holding = false
        if case .resolving = panel.model.phase {
            requestSeq += 1
            let ids = rpc?.cancelHandles() ?? []
            Log.write("[panel] \(reason): cancelled \(ids.count) running request(s)")
        }
        pendingConfirmText = nil
        // Esc on the takeover card = "not now": this takeover is dropped, back to the backup key (Settings offers it again)
        if reason == "esc", case .takeover(let c) = panel.model.phase, !c.done {
            Store.takeoverAsked = true
            Store.commandSpaceChoice = false
            stopTakeoverWatch()
            DispatchQueue.main.async { [weak self] in self?.applyHotKey(reason: "takeover esc") }
            Log.write("[takeover] esc: keeping \(Store.hotKey.displayString)")
        }
        panel.hide()
    }

    /// Focus moved to another window/app. Success: the auto-hide timer is already running; candidates / confirm
    /// still need the user, so they stay; everything else closes (and cancels).
    func panelLostFocus() {
        guard panel.isVisible else { return }
        switch panel.model.phase {
        case .candidates, .confirm, .success, .mic: return
        case .takeover(let c) where c.done: return
        case .listening where panel.model.holding: return   // still holding the key
        default: dismiss(reason: "focus lost")
        }
    }

    private func scheduleAutoHide() {
        cancelAutoHide()
        let w = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, case .success = self.panel.model.phase else { return }
                self.panel.hide(fade: true)
            }
        }
        autoHide = w
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.successDwell, execute: w)
    }

    private func cancelAutoHide() { autoHide?.cancel(); autoHide = nil }

    private func hoverCandidate(_ i: Int) {
        guard case .candidates(let l, let c, let s) = panel.model.phase, c.indices.contains(i), i != s else { return }
        panel.model.phase = .candidates(l, c, selected: i)
    }

    /// Every change in the field: live results (debounced 60 ms, not while an input method is composing), and the
    /// paste rule: a pasted whole sentence runs at once like speech (400 ms after it stops changing).
    private func textChanged(_ text: String, _ source: InsertSource, composing: Bool) {
        let typedAt = Date()
        commitTimer?.invalidate()
        if composing { return }   // marked text (pinyin…) is not what the user means yet
        let q = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let deadline = detector.textDidChange(to: text, source: source, at: typedAt), LiveSearch.isSentence(q) {
            liveTimer?.invalidate(); liveSeq += 1
            let t = Timer(fire: deadline, interval: 0, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    if let q = self.detector.fire(at: Date()) {
                        Log.write("[input] paste auto-commit (\(q.count) chars)")
                        self.submit(q)
                    }
                }
            }
            RunLoop.main.add(t, forMode: .common)
            commitTimer = t
            return
        }
        scheduleLive(q, typedAt: typedAt)
    }

    // MARK: results while typing

    private func scheduleLive(_ q: String, typedAt: Date) {
        liveTimer?.invalidate()
        liveSeq += 1
        let m = panel.model
        if q.isEmpty {
            liveChosenId = nil
            if introVisible { renderIntro() } else if case .live = m.phase { m.phase = .idle } else if case .resolving = m.phase {} else { m.phase = .idle }
            return
        }
        // editing after a result (success / candidates / miss…): back to the live list
        let seq = liveSeq
        let t = Timer(timeInterval: LiveSearch.debounce, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.runLive(q, seq: seq, typedAt: typedAt) }
        }
        RunLoop.main.add(t, forMode: .common)
        liveTimer = t
    }

    private func runLive(_ q: String, seq: Int, typedAt: Date) {
        guard seq == liveSeq else { return }
        let rpc = rpc
        // apps are matched in-process (no disk access while typing); the core returns what the AI made
        let installed = apps.records
        Task {
            let hits = (try? await rpc?.search(query: q, limit: LiveList.maxRows, live: true).results) ?? []
            guard seq == self.liveSeq, self.panel.isVisible else { return }
            let m = self.panel.model
            // a request already running (↩ pressed) owns the panel
            if case .resolving = m.phase { return }
            let items = AppSearch.merge(query: q, apps: installed, hits: hits)
            let sel = LiveSearch.selection(in: items, chosenId: self.liveChosenId)
            if sel == 0, let id = self.liveChosenId, !items.contains(where: { $0.id == id }) { self.liveChosenId = nil }
            let before: Int = { if case .live(let l) = m.phase { return l.isFallback ? 0 : l.items.count }; return 0 }()
            m.liveAppear = LiveSearch.change(from: before, to: items.count) == .appear
            if self.introVisible { self.stopIntro() }
            m.phase = .live(LiveList(items: items, selected: sel, query: q))
            let ms = Int(Date().timeIntervalSince(typedAt) * 1000)
            Log.write("[live] q.len=\(q.count) rows=\(items.count) ms=\(ms)")
            #if SESAME_TEST_HOOKS
            TestScript.liveLatency(ms)
            #endif
        }
    }

    // MARK: first run

    /// The first-run panel: counts from the core's index (climbing while it builds), then one real example.
    func showIntro() {
        showPanel()
        introVisible = true
        introTarget = IntroCard(hotKeyTaken: hotKeyTaken)
        let now = Date()
        tweens = ["total": CountTween(value: 0, duration: 1.2, now: now)]
        for k in IntroGroupKind.allCases { tweens[k.rawValue] = CountTween(value: 0, duration: 1.2, now: now) }
        renderIntro()
        if let st = indexStatus { introIndexChanged(st) }
        // a running index is polled by startIndex; otherwise ask once (a finished index still has to roll up)
        if indexPoll == nil { Task { await self.refreshIndexStatus() } }
        let t = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.renderIntro() } }
        RunLoop.main.add(t, forMode: .common)
        tweenTimer = t
        Log.write("[intro] shown")
    }

    private func stopIntro() {
        guard introVisible else { return }
        introVisible = false
        tweenTimer?.invalidate(); tweenTimer = nil
        sampleTask?.cancel(); sampleTask = nil
    }

    private func introIndexChanged(_ st: IndexStatus) {
        let now = Date()
        let total = Double(IntroCounts.total(st))
        let groups = IntroCounts.groups(st.groups)
        // the first roll takes 1.2 s; later increases while indexing glide over 0.6 s
        func retarget(_ key: String, _ v: Double) {
            var tw = tweens[key] ?? CountTween(value: 0, duration: 1.2, now: now)
            let first = tw.to == 0
            tw.retarget(v, now: now, duration: first ? 1.2 : 0.6)
            tweens[key] = tw
        }
        retarget("total", total)
        for (k, v) in groups { retarget(k.rawValue, Double(v)) }
        let line = "running=\(st.running) total=\(Int(total)) groups=\(IntroGroupKind.allCases.map { "\($0.rawValue):\(groups[$0] ?? 0)" }.joined(separator: ","))"
        if line != lastIntroLog { lastIntroLog = line; Log.write("[intro] index \(line)") }
        if !st.running && st.items > 0 && introTarget.sample == nil && sampleTask == nil { loadSample() }
    }

    private func loadSample() {
        guard let rpc else { return }
        sampleTask = Task {
            let r = try? await rpc.sample()
            guard self.introVisible else { return }
            if let o = r?.sample {
                let hit = SearchHit(key: o.key ?? o.url, kind: o.kind, title: o.title, url: o.url, lastSeen: o.lastSeen)
                self.introTarget.sample = Candidate(hit: hit)
                Log.write("[intro] sample kind=\(o.kind) title.len=\(o.title.count)")
            } else {
                Log.write("[intro] no clean recent example: the try row stays hidden")
            }
            self.renderIntro()
        }
    }

    private func renderIntro() {
        guard introVisible, panel.isVisible else { return }
        let m = panel.model
        // the user started typing: the live list owns the panel now
        if !m.query.trimmingCharacters(in: .whitespaces).isEmpty { return }
        let now = Date()
        var card = introTarget
        card.total = Int((tweens["total"]?.value(at: now) ?? 0).rounded())
        var g: [IntroGroupKind: Int] = [:]
        for k in IntroGroupKind.allCases { g[k] = Int((tweens[k.rawValue]?.value(at: now) ?? 0).rounded()) }
        card.groups = g
        if case .intro(let cur) = m.phase, cur == card { return }
        m.phase = .intro(card)
    }

    var introShowing: Bool { introVisible }

    /// Share: the final numbers (where the roll-up is heading, not the frame it is on), in the panel's light / dark look.
    /// Outside a live first run (demo states) the card on screen is used as is.
    func shareIntro() {
        var total = 0
        var g: [IntroGroupKind: Int] = [:]
        if introVisible {
            total = Int((tweens["total"]?.to ?? 0).rounded())
            for k in IntroGroupKind.allCases { g[k] = Int((tweens[k.rawValue]?.to ?? 0).rounded()) }
        } else if case .intro(let c) = panel.model.phase {
            total = c.total; g = c.groups
        }
        let dark = panel.panel.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        guard ShareExport.run(total: total, groups: g, dark: dark) != nil else { return }
        introTarget.shared = true
        if case .intro(var c) = panel.model.phase { c.shared = true; panel.model.phase = .intro(c) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self else { return }
            self.introTarget.shared = false
            if case .intro(var c) = self.panel.model.phase, c.shared { c.shared = false; self.panel.model.phase = .intro(c) }
        }
    }

    // MARK: push-to-talk

    private func setupPushToTalk() {
        #if SESAME_TEST_HOOKS
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--fake-speech"), i + 1 < args.count {
            var auth = SpeechAuth.authorized
            if let j = args.firstIndex(of: "--fake-speech-auth"), j + 1 < args.count {
                switch args[j + 1] { case "notDetermined": auth = .notDetermined; case "denied": auth = .denied; case "unavailable": auth = .unavailable; default: break }
            }
            speech = FakeSpeech(sentence: args[i + 1], auth: auth)
        }
        #endif
        ptt = PushToTalkController(recognizer: speech, schedule: { d, block in
            let t = Timer(timeInterval: d, repeats: false) { _ in block() }
            RunLoop.main.add(t, forMode: .common)
            return { t.invalidate() }
        }, languageCode: { [weak self] in self?.speechLanguage() ?? "zh-CN" }, output: { [weak self] o in
            MainActor.assumeIsolated { self?.pttOutput(o) }
        })
    }

    /// Any Chinese in the user's preferred languages → zh-CN (it also understands English words mixed in);
    /// otherwise en-US. Not tied to the UI language: an English-UI Mac with Chinese listed should still hear Chinese.
    private func speechLanguage() -> String {
        let wantsChinese = zh || Locale.preferredLanguages.contains { $0.lowercased().hasPrefix("zh") }
        let code = wantsChinese ? "zh-CN" : "en-US"
        (speech as? SystemSpeech)?.languageCode = code
        return code
    }

    private func pttOutput(_ o: PushToTalkOutput) {
        let m = panel.model
        Log.write("[ptt] \(Self.describe(o))")
        switch o {
        case .tap: toggle()
        case .listening(let f, let i):
            if !panel.isVisible { showPanel() }
            stopIntro()
            commitTimer?.invalidate(); liveTimer?.invalidate(); liveSeq += 1
            m.holding = true
            m.phase = .listening(final: f, interim: i)
        case .askPermission: showMic(.ask)
        case .denied: showMic(.denied)
        case .unavailable: showMic(.unavailable)
        case .submit(let t):
            m.holding = false
            submit(t)
        case .cancelled:
            m.holding = false
            if case .listening = m.phase { m.phase = .idle }
        case .ready:
            m.phase = .idle
            panel.focusField()
        }
    }

    private func showMic(_ n: MicNotice) {
        if !panel.isVisible { showPanel() }
        stopIntro()
        panel.model.holding = false
        panel.model.phase = .mic(n)
    }

    private func answerMic(_ yes: Bool) {
        guard case .mic(let n) = panel.model.phase else { return }
        if n == .ask && yes {
            ptt.allow()
        } else {
            if n == .ask { ptt.decline() }
            panel.model.phase = .idle
            panel.focusField()
        }
    }

    static func describe(_ o: PushToTalkOutput) -> String {
        switch o {
        case .listening(let f, let i): return "listening final=\(f.count) interim=\(i.count)"
        case .submit(let t): return "submit \(t.count) chars"
        default: return "\(o)"
        }
    }

    func submit(_ q: String, confirmed: Bool = false) {
        commitTimer?.invalidate()
        liveTimer?.invalidate()
        liveSeq += 1
        stopIntro()
        cancelAutoHide()
        detector.reset(text: q)
        let m = panel.model
        m.query = q
        if !confirmed { m.phase = .resolving(nil) }
        requestSeq += 1
        let seq = requestSeq
        if case .failed(let f) = coreState {
            m.phase = .notFound(nil, MissCard(message: CoreMessage.headline(f, zh: zh), done: "", need: CoreMessage.fix(f, zh: zh)))
            return
        }
        guard let rpc else { m.phase = .notFound(nil, MissCard(message: CoreMessage.headline(.coreNotFound, zh: zh), done: "", need: CoreMessage.fix(.coreNotFound, zh: zh))); return }
        Task {
            do {
                if Store.previewBeforeRun && !confirmed {
                    let plan = try await rpc.handle(text: q, dryRun: true)
                    Store.record(plan.cost)
                    guard seq == requestSeq else { return }
                    m.phase = .resolving(ResultMapper.intentLine(plan))
                    if plan.intent.contains(where: { $0.needsConfirm }) {
                        pendingConfirmText = q
                        await apply(plan, seq: seq)
                        return
                    }
                }
                var dry = false
                #if SESAME_TEST_HOOKS
                dry = TestScript.active   // test runs never open anything for real
                #endif
                let r = try await rpc.handle(text: q, dryRun: dry, confirmed: confirmed)
                Store.record(r.cost)
                guard seq == requestSeq, r.cancelled != true else { return }
                await apply(r, seq: seq)
            } catch {
                guard seq == requestSeq else { return }
                m.phase = .notFound(nil, requestErrorCard(error))
            }
        }
    }

    /// Human text for a request that did not come back (no internal error strings on the panel).
    private func requestErrorCard(_ e: Error) -> MissCard {
        if case .failed(let f) = coreState { return MissCard(message: CoreMessage.headline(f, zh: zh), done: "", need: CoreMessage.fix(f, zh: zh)) }
        switch e as? RPCError {
        case .timeout?: return MissCard(message: L10n.t("err.timeout"), done: "", need: L10n.t("err.again"))
        case .processExited?, .notRunning?: return MissCard(message: L10n.t("err.restarting"), done: "", need: L10n.t("err.again"))
        default: return MissCard(message: L10n.t("err.generic"), done: "", need: L10n.t("err.again"))
        }
    }

    private func apply(_ r: HandleResult, seq: Int) async {
        let m = panel.model
        switch ResultMapper.map(r) {
        case .phase(.success(let line, var o)):
            if r.opened == nil, r.intent.first?.tool == "open_saved", let q = r.intent.first?.args["query"]?.stringValue,
               let hit = try? await rpc?.search(query: q, limit: 1).results.first {
                // older core without `opened`: best effort
                o = ResultMapper.enrich(o, with: hit)
            }
            guard seq == requestSeq else { return }
            var l = line
            if var x = l, x.chip == nil { x.chip = o.kind; l = x }
            m.phase = .success(l, o)
            Store.remember(RecentItem(title: o.name, url: r.opened?.url, query: r.input, kind: r.opened?.kind ?? kindString(o.kind), date: Date()))
            scheduleAutoHide()
        case .phase(let p):
            if case .confirm = p { pendingConfirmText = r.input }
            m.phase = p
        case .searchCandidates(let q, var line):
            let hits = (try? await rpc?.search(query: q, limit: 5).results) ?? []
            guard seq == requestSeq else { return }
            if hits.isEmpty {
                line.chip = .results(0)
                m.phase = .notFound(line, ResultMapper.missCard(r))
            } else {
                line.chip = .candidates(hits.count)
                m.phase = .candidates(line, hits.map(Candidate.init(hit:)), selected: 0)
            }
        }
    }

    private func kindString(_ k: ChipKind) -> String {
        switch k { case .artifact: return "artifact"; case .local: return "local"; case .file, .files: return "file"; case .app: return "app"; default: return "web" }
    }

    func open(_ c: Candidate) {
        guard let u = c.url, !u.isEmpty else { return }
        stopIntro()
        liveTimer?.invalidate()
        liveSeq += 1
        let url = u.hasPrefix("/") ? URL(fileURLWithPath: u) : (URL(string: u) ?? URL(fileURLWithPath: u))
        #if SESAME_TEST_HOOKS
        if TestScript.active { Log.write("[test] would open \(u)") } else { NSWorkspace.shared.open(url) }
        #else
        NSWorkspace.shared.open(url)
        #endif
        let m = panel.model
        var line = m.phase.intentLine
        line?.chip = c.kind
        m.phase = .success(line, OpenedCard(name: c.title, address: c.address, source: "", kind: c.kind))
        Store.remember(RecentItem(title: c.title, url: u, query: m.query, kind: kindString(c.kind), date: Date()))
        scheduleAutoHide()
    }

    /// Confirm card answered. Yes = run it for real with confirmed: true (the core asks nothing else).
    private func answerConfirm(_ yes: Bool) {
        guard yes, let q = pendingConfirmText else { pendingConfirmText = nil; dismiss(reason: "confirm cancelled"); return }
        pendingConfirmText = nil
        panel.model.phase = .resolving(panel.model.phase.intentLine)
        submit(q, confirmed: true)
    }
}
