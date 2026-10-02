#if SESAME_TEST_HOOKS
import AppKit
import SesameCore

/// Test builds only (`-Xswiftc -DSESAME_TEST_HOOKS`): `Sesame --test-script <file>` drives the app's own handlers
/// in-process, one command per line. No keyboard or mouse event is synthesized; the panel never opens anything
/// for real (`handle` runs as a dry run, candidate clicks only log).
///   show · submit <text> · waitPhase <idle|resolving|success|candidates|confirm|notFound|hidden> [timeout] · wait <s>
///   click <row> · esc · focuslost · dump · shot <name> · menushot <name> · waitIndex [timeout] · quit
/// WO-041: intro · waitSample [timeout] · type <text> (one typed change) · typechars <ms> <text> (one character at a time)
///   compose <text> (input method still composing) · paste <text> · down · up · return · hold · release · allowMic · notNow
///   taken on|off · settingsshot <name> · probeChoice · takeoverReal · takeoverFake <holder> · takeoverAnswer go|later · share (with SESAME_SHARE_DRY=1 SESAME_SHARE_DIR=…) · latency (p50/p90 of keystroke → list refreshed)
@MainActor
enum TestScript {
    static var active = false
    static var latencies: [Int] = []
    static func liveLatency(_ ms: Int) { if active { latencies.append(ms) } }

    static func path(_ args: [String]) -> String? {
        guard let i = args.firstIndex(of: "--test-script"), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    static func say(_ s: String) { print("[test] \(s)"); fflush(stdout); Log.write("[test] \(s)") }

    static func phaseName(_ p: PanelPhase) -> String {
        switch p {
        case .idle: return "idle"
        case .intro: return "intro"
        case .takeover: return "takeover"
        case .live: return "live"
        case .mic: return "mic"
        case .listening: return "listening"
        case .resolving: return "resolving"
        case .success: return "success"
        case .info: return "info"
        case .candidates: return "candidates"
        case .confirm: return "confirm"
        case .notFound: return "notFound"
        }
    }

    static func describe(_ app: AppController) -> String {
        let m = app.panel.model
        var d = "phase=\(phaseName(m.phase)) visible=\(app.panel.isVisible)"
        switch m.phase {
        case .success(_, let o): d += " opened=\"\(o.name)\" address=\"\(o.address)\""
        case .candidates(_, let c, let s): d += " candidates=\(c.map { "\"\($0.title)\"" }.joined(separator: ",")) selected=\(s)"
        case .notFound(_, let mc): d += " message=\"\(mc.message)\" done=\"\(mc.done)\" need=\"\(mc.need)\""
        case .confirm(_, let c): d += " confirm=\"\(c.title)\""
        case .intro(let c): d += " total=\(c.total) groups=\(IntroGroupKind.allCases.map { "\($0.rawValue):\(c.count($0))" }.joined(separator: ",")) sample=\(c.sample.map { "\"\($0.title)\"" } ?? "none") taken=\(c.hotKeyTaken)"
        case .live(let l): d += l.isFallback ? " live=fallback query=\"\(l.query)\"" : " live=\(l.items.count) selected=\(l.selected):\"\(l.selectedItem?.title ?? "")\""
        case .mic(let n): d += " mic=\(n)"
        case .takeover(let c): d += " takeover=\(c.done ? "done" : c.holder?.rawValue ?? "none") fallback=\(c.fallback.displayString)"
        case .listening(let f, let i): d += " final=\"\(f)\" interim=\"\(i)\" holding=\(m.holding)"
        default: break
        }
        return d + " core=\(app.coreState) index=\"\(app.indexStatusText())\""
    }

    static func run(_ file: String, app: AppController) {
        active = true
        if CommandLine.arguments.contains("--fake-login") {
            let i = CommandLine.arguments.firstIndex(of: "--fake-login")!
            LoginItem.fake = (i + 1 < CommandLine.arguments.count ? CommandLine.arguments[i + 1] : "on") != "off"
        }
        guard let text = try? String(contentsOfFile: file, encoding: .utf8) else { say("cannot read \(file)"); NSApp.terminate(nil); return }
        let lines = text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty && !$0.hasPrefix("#") }
        Task { @MainActor in
            for line in lines {
                let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
                let cmd = parts[0], arg = parts.count > 1 ? parts[1] : ""
                say("> \(line)")
                switch cmd {
                case "show": app.showPanel()
                case "submit": app.panel.model.query = arg; app.submit(arg)
                case "wait": try? await Task.sleep(nanoseconds: UInt64((Double(arg) ?? 1) * 1e9))
                case "waitPhase":
                    let a = arg.split(separator: " ").map(String.init)
                    let want = a.first ?? "success", timeout = Double(a.count > 1 ? a[1] : "15") ?? 15
                    let t0 = Date()
                    while Date().timeIntervalSince(t0) < timeout {
                        let now = want == "hidden" ? (app.panel.isVisible ? "visible" : "hidden") : phaseName(app.panel.model.phase)
                        if now == want { break }
                        try? await Task.sleep(nanoseconds: 50_000_000)
                    }
                    say("after \(String(format: "%.2f", Date().timeIntervalSince(t0)))s: \(describe(app))")
                case "waitIndex":
                    let timeout = Double(arg) ?? 120
                    let t0 = Date()
                    while Date().timeIntervalSince(t0) < timeout {
                        if let s = app.indexStatus, !s.running { break }
                        try? await Task.sleep(nanoseconds: 200_000_000)
                    }
                    say("index after \(String(format: "%.1f", Date().timeIntervalSince(t0)))s: \(app.indexStatusText())")
                case "click":
                    if case .candidates(_, let c, _) = app.panel.model.phase, let i = Int(arg), c.indices.contains(i) { app.panel.model.onOpenCandidate(c[i]) }
                case "esc": app.panel.model.onDismiss()
                case "focuslost": app.panelLostFocus()
                case "dump": say(describe(app))
                case "shot":
                    app.panel.fit()
                    try? await Task.sleep(nanoseconds: 450_000_000)   // let the 260 ms height animation settle
                    say("shot=\(arg) window=\(app.panel.panel.windowNumber)")
                    if !capture(arg, window: app.panel.panel.windowNumber) { try? await Task.sleep(nanoseconds: 1_500_000_000) }
                case "menushot": menuShot(arg, app: app)
                case "backdrop": backdrop(arg, app: app)
                case "screenshot":
                    // the screen area under the panel (panel + the test backdrop behind it), to judge the vibrancy
                    app.panel.fit()
                    try? await Task.sleep(nanoseconds: 450_000_000)
                    let fr = app.panel.panel.frame.insetBy(dx: -24, dy: -24)
                    let top = (NSScreen.screens.first?.frame.height ?? 0) - fr.maxY
                    if let dir = ProcessInfo.processInfo.environment["SESAME_SHOT_DIR"] {
                        let p = Process()
                        p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
                        p.arguments = ["-x", "-R", "\(Int(fr.minX)),\(Int(top)),\(Int(fr.width)),\(Int(fr.height))", "\(dir)/\(arg).png"]
                        try? p.run(); p.waitUntilExit()
                        say("captured screen \(arg) rc=\(p.terminationStatus)")
                    }
                case "intro": app.showIntro()
                case "firstLaunch": app.firstLaunchIntro()
                case "share": app.shareIntro()
                case "probeHotKey":
                    // really try to register the user's hot key from this process (the installed Sesame may hold it)
                    let hk = HotKey(onPress: {})
                    let st = hk.register(Store.hotKey)
                    say("probe \(Store.hotKey.displayString) register=\(st) system=\(HotKey.takenBySystem(Store.hotKey)) knownApp=\(HotKey.takenByKnownApp(Store.hotKey) ?? "none") taken=\(HotKey.isTaken(Store.hotKey, registerStatus: st))")
                    hk.unregister()
                    app.setHotKeyTaken(HotKey.isTaken(Store.hotKey, registerStatus: st))
                case "waitSample":
                    let timeout = Double(arg) ?? 30
                    let t0 = Date()
                    while Date().timeIntervalSince(t0) < timeout {
                        if case .intro(let c) = app.panel.model.phase, c.sample != nil, app.indexStatus?.running == false { break }
                        try? await Task.sleep(nanoseconds: 100_000_000)
                    }
                    try? await Task.sleep(nanoseconds: 1_400_000_000)   // let the roll finish
                    say("after \(String(format: "%.1f", Date().timeIntervalSince(t0)))s: \(describe(app))")
                case "type": feed(app, arg, .typed, composing: false)
                case "compose": feed(app, arg, .typed, composing: true)
                case "paste": feed(app, arg, .paste, composing: false)
                case "typechars":
                    let a = arg.split(separator: " ", maxSplits: 1).map(String.init)
                    let ms = Double(a.first ?? "250") ?? 250
                    let chars = Array(a.count > 1 ? a[1] : "")
                    for n in 1...max(1, chars.count) {
                        feed(app, String(chars[..<n]), .typed, composing: false)
                        try? await Task.sleep(nanoseconds: UInt64(ms * 1e6))
                    }
                case "down": app.panel.model.moveSelection(1)
                case "up": app.panel.model.moveSelection(-1)
                case "return": app.panel.model.returnPressed()
                case "hold": app.ptt.keyDown()
                case "release": app.ptt.keyUp()
                case "allowMic": app.panel.model.onMic(true)
                case "notNow": app.panel.model.onMic(false)
                case "taken": app.setHotKeyTaken(arg != "off")
                case "probeChoice":
                    // read-only: who holds ⌘Space on this Mac right now, and the key Sesame would use (nothing registered)
                    let c = HotKey.currentChoice()
                    say("choice spotlightOn=\(HotKey.spotlightHoldsCommandSpace()) launcher=\(HotKey.launcherOnCommandSpace()?.rawValue ?? "none") custom=\(Store.customHotKey?.displayString ?? "none") active=\(c.active.displayString) blockedBy=\(c.blockedBy?.rawValue ?? "none")")
                case "takeoverReal":
                    // the real first-run step on this Mac's real state (the hot key itself is still not registered)
                    app.applyChoiceForTest(HotKey.currentChoice()); app.showTakeover()
                case "takeoverFake":
                    // takeoverFake spotlight|alfred|raycast
                    let h = CommandSpaceHolder(rawValue: arg) ?? .spotlight
                    app.applyChoiceForTest(HotKeyChoice(active: .fallback, isCustom: false, blockedBy: h)); app.showTakeover(watch: false)
                case "takeoverAnswer": app.panel.model.onTakeover(arg != "later")
                case "takeoverDone": app.applyChoiceForTest(HotKeyChoice(active: .commandSpace, isCustom: false, blockedBy: nil)); app.showTakeoverDone()
                case "settingsshot":
                    app.openSettings()
                    try? await Task.sleep(nanoseconds: 700_000_000)
                    say("shot=\(arg) window=\(app.settingsController?.windowNumber ?? 0)")
                    if !capture(arg, window: app.settingsController?.windowNumber ?? 0) { try? await Task.sleep(nanoseconds: 1_500_000_000) }
                    app.settingsController?.close()
                case "latency":
                    let v = latencies.sorted()
                    func pct(_ p: Double) -> Int { v.isEmpty ? -1 : v[min(v.count - 1, Int((Double(v.count - 1) * p).rounded()))] }
                    say("latency n=\(v.count) p50=\(pct(0.5))ms p90=\(pct(0.9))ms max=\(v.last ?? -1)ms all=\(v)")
                case "quit": app.rpc?.stop(); NSApp.terminate(nil)
                default: say("unknown command \(cmd)")
                }
            }
        }
    }

    /// `SESAME_SHOT_DIR` set: capture this window now (screencapture -l, window only; no input involved), so the
    /// picture is the state the script just printed. Unset: an outside driver captures from the printed window id.
    static func capture(_ name: String, window: Int) -> Bool {
        guard let dir = ProcessInfo.processInfo.environment["SESAME_SHOT_DIR"], !dir.isEmpty, window > 0 else { return false }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        p.arguments = ["-x", "-o", "-l", String(window), "\(dir)/\(name).png"]
        do { try p.run(); p.waitUntilExit() } catch { say("capture failed: \(error.localizedDescription)"); return false }
        say("captured \(name) rc=\(p.terminationStatus)")
        return true
    }

    static var backdropWindow: NSWindow?
    /// Test only: a plain coloured window right behind the panel ("light desktop" #E9E4DC / "dark desktop" #1D2030), so the
    /// panel's vibrancy is judged over a known background instead of whatever is on this Mac's screen. `off` removes it.
    static func backdrop(_ arg: String, app: AppController) {
        backdropWindow?.orderOut(nil); backdropWindow = nil
        let hex: UInt32 = arg == "dark" ? 0x1D2030 : arg == "light" ? 0xE9E4DC : (UInt32(arg, radix: 16) ?? 0)
        guard arg != "off" else { return }
        let f = app.panel.panel.frame.insetBy(dx: -80, dy: -260)
        let w = NSWindow(contentRect: f, styleMask: [.borderless], backing: .buffered, defer: false)
        w.backgroundColor = NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
        w.level = .floating   // same level as the panel, ordered right below it (an agent app's normal windows sit behind other apps)
        w.ignoresMouseEvents = true
        w.isReleasedWhenClosed = false
        w.order(.below, relativeTo: app.panel.panel.windowNumber)
        backdropWindow = w
    }

    /// A text change as the field editor reports it (no key event is synthesized)
    static func feed(_ app: AppController, _ text: String, _ src: InsertSource, composing: Bool) {
        let m = app.panel.model
        m.query = text
        m.onTextChange(text, src, composing)
        app.panel.focusField()   // caret at the end, nothing selected (as after real typing)
    }

    /// Opens the status menu in-process (performClick, no synthesized events), prints its window id, closes it.
    static func menuShot(_ name: String, app: AppController) {
        // an open status menu takes every keystroke while it is up: only with --allow-menu
        guard CommandLine.arguments.contains("--allow-menu") else { Log.write("[test] menuShot \(name) skipped (needs --allow-menu)"); return }
        let t = Timer(timeInterval: 0.8, repeats: false) { _ in MainActor.assumeIsolated {
            let pid = ProcessInfo.processInfo.processIdentifier
            let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
            for w in list where (w[kCGWindowOwnerPID as String] as? Int32) == pid {
                let layer = w[kCGWindowLayer as String] as? Int ?? 0
                let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
                if layer > 25 { say("shot=\(name) window=\(w[kCGWindowNumber as String] ?? 0) layer=\(layer) h=\(b["Height"] ?? 0)") }
            }
        } }
        RunLoop.main.add(t, forMode: .common)
        let close = Timer(timeInterval: 2.6, repeats: false) { _ in MainActor.assumeIsolated { app.statusMenu?.cancelTracking() } }
        RunLoop.main.add(close, forMode: .common)
        app.statusItemButton?.performClick(nil)
    }
}
#endif
