import AppKit
import SesameCore

/// `Sesame --demo <state> [--dark|--light] [--lang en|zh-Hans] [--quit-after <s>]`
/// Shows one prototype state with the prototype's sample data (design/prototype.html), for screenshots and
/// review. No hot key, no core process, no input is synthesized. State numbers follow the prototype:
/// 1 listening · 2 intent preview · 3 success · 5 info card · 6 candidates · 7 confirm · 8 English · 9 menu · 0 not found
/// · 4 first run · h first run + hot key taken · t1 / t2 / t3 typing (4 rows / 1 row / none) · v hold to talk
/// · m microphone notice · k / k2 / kr takeover (Spotlight / Alfred / Raycast holds ⌘Space) · k3 takeover done · s settings (open at login). The first-run numbers are the prototype's sample data, never the
/// real index (these frames are for promo shots).
struct DemoOptions {
    var state: String
    var quitAfter: TimeInterval = 0

    static func parse(_ args: [String]) -> DemoOptions? {
        guard let i = args.firstIndex(of: "--demo"), i + 1 < args.count else { return nil }
        var o = DemoOptions(state: args[i + 1])
        if let q = args.firstIndex(of: "--quit-after"), q + 1 < args.count { o.quitAfter = Double(args[q + 1]) ?? 0 }
        return o
    }
}

@MainActor
enum Demo {
    /// the prototype's sample counts (design/prototype.html state 4)
    static let demoGroups: [IntroGroupKind: Int] = [.dashboard: 186, .report: 412, .deck: 37, .site: 64, .pr: 1293, .file: 716]

    static func phase(_ s: String) -> (String, PanelPhase)? {
        let zhQ = "打开上周让 Claude 做的那个交易大盘"
        let dash = IntentLine(verb: .open, target: "交易大盘", chip: .local)
        switch s {
        case "1": return ("打开上周让 Claude 做的那个交易", .listening(final: "打开上周让 Claude 做的那个交易", interim: "大盘"))
        case "2": return (zhQ, .resolving(dash))
        case "3": return (zhQ, .success(dash, OpenedCard(name: "交易大盘", address: "localhost:7341", source: "9月24日 Claude Code 会话产出", kind: .local)))
        case "5": return ("查一下磁盘空间", .info(IntentLine(verb: .query, target: "磁盘空间", chip: .system),
                                            InfoCard(name: "Macintosh HD", meta: "内置磁盘", value: "150", unit: "GB", valueNote: "可用", fraction: 0.162,
                                                     footLeft: "已用 776 GB，共 926 GB", footRight: "2 分钟前更新")))
        case "6": return ("打开交易大盘", .candidates(IntentLine(verb: .open, target: "交易大盘", chip: .candidates(3)), [
            Candidate(id: "a", title: "交易大盘", address: "localhost:7341", url: nil, kind: .local),
            Candidate(id: "b", title: "交易大盘改版预览", address: "claude.ai/artifact/7f3c…e21", url: nil, kind: .artifact),
            Candidate(id: "c", title: "交易大盘（旧版）", address: "localhost:5173", url: nil, kind: .local),
        ], selected: 0))
        case "7": return ("把下载里的 dmg 都扔掉", .confirm(IntentLine(verb: .trash, target: "下载 / *.dmg", chip: .files(60)),
                                                ConfirmCard(title: "把 60 个 .dmg 移到废纸篓？", detail: "“下载”文件夹里的全部安装包，共 **9.2 GB**。",
                                                            files: [("Docker.dmg", "612 MB"), ("Figma.dmg", "418 MB"), ("OrbStack.dmg", "142 MB")], moreCount: 57)))
        case "8": return ("open the trading dashboard", .success(IntentLine(verb: .open, target: "Trading Dashboard", chip: .local),
                                                             OpenedCard(name: "Trading Dashboard", address: "localhost:7341", source: "from a Claude Code session, Sep 24", kind: .local)))
        case "0": return ("打开昨天那个汇率换算表", .notFound(IntentLine(verb: .open, target: "汇率换算表", chip: .results(0)),
                                                 MissCard(message: "没找到“汇率换算表”", done: "搜过 **2533 条**索引、Chrome 最近 7 天历史和桌面文件，没有标题或内容对得上的。",
                                                          need: "说一个页面里出现过的词，比如币种或金额；或者告诉我是在哪个项目里做的。")))
        case "4", "4s", "h":
            let sample = Candidate(id: "demo", title: "上周那个交易大盘", address: "localhost:7341", url: nil, kind: .local)
            // 4s = right after Share: the button says the card was saved and copied
            return ("", .intro(IntroCard(total: 2708, groups: demoGroups, sample: sample, hotKeyTaken: s == "h", shared: s == "4s")))
        case "t1": return ("大", .live(LiveList(items: [
            Candidate(id: "a", title: "交易大盘", address: "localhost:7341", url: nil, kind: .local),
            Candidate(id: "b", title: "年度大事记", address: "claude.ai/artifact/2b91…c04", url: nil, kind: .artifact),
            Candidate(id: "c", title: "大客户名单.md", address: "~/Documents/销售/", url: nil, kind: .file),
            Candidate(id: "d", title: "大促活动页", address: "shop.example.com/sale", url: nil, kind: .web),
        ], query: "大")))
        case "t2": return ("交易大", .live(LiveList(items: [Candidate(id: "a", title: "交易大盘", address: "localhost:7341", url: nil, kind: .local)], query: "交易大")))
        case "t3": return ("交易大盘 v2", .live(LiveList(items: [], query: "交易大盘 v2")))
        case "v": return ("打开上周那个交易大盘", .listening(final: "打开上周那个交易", interim: "大盘"))
        case "m": return ("", .mic(.ask))
        // takeover: Spotlight / Alfred / Raycast holds ⌘Space (the backup key is in use), then "done"
        case "k": return ("", .takeover(TakeoverCard(holder: .spotlight)))
        case "k2": return ("", .takeover(TakeoverCard(holder: .alfred)))
        case "kr": return ("", .takeover(TakeoverCard(holder: .raycast)))
        case "k3": return ("", .takeover(TakeoverCard(holder: nil, done: true)))
        default: return nil
        }
    }

    static func run(_ o: DemoOptions, app: AppController) {
        // demo windows are for looking at: on screen, never the key window, the app never activated
        Presentation.passive = true
        // `--share-out <file.png>`: write the share card (demo numbers, current --light / --dark) and quit
        if let i = CommandLine.arguments.firstIndex(of: "--share-out"), i + 1 < CommandLine.arguments.count {
            let dark = CommandLine.arguments.contains("--dark")
            let url = URL(fileURLWithPath: CommandLine.arguments[i + 1])
            if let d = ShareCardView.png(total: 2708, groups: demoGroups, dark: dark), (try? d.write(to: url)) != nil {
                print("[demo] share card -> \(url.path) bytes=\(d.count)")
            } else { print("[demo] share card FAILED") }
            fflush(stdout)
            DispatchQueue.main.async { NSApp.terminate(nil) }
            return
        }
        if o.state == "9" && !CommandLine.arguments.contains("--allow-menu") {
            // an open status menu takes every keystroke while it is up: only when asked for explicitly
            print("[demo] state 9 opens the status menu, which takes the keyboard while open; pass --allow-menu to show it")
            fflush(stdout)
            DispatchQueue.main.async { NSApp.terminate(nil) }
            return
        }
        if o.state == "9" {
            let now = Date()
            app.demoRecent = [
                RecentItem(title: "交易大盘", url: nil, query: "", kind: "local", date: now.addingTimeInterval(-120)),
                RecentItem(title: "磁盘空间", url: nil, query: "", kind: "local", date: now.addingTimeInterval(-38 * 60)),
                RecentItem(title: "竞品调研报告", url: nil, query: "", kind: "file", date: now.addingTimeInterval(-6 * 3600)),
                RecentItem(title: "Q3 复盘图表", url: nil, query: "", kind: "artifact", date: now.addingTimeInterval(-26 * 3600)),
                RecentItem(title: "供应商比价表.md", url: nil, query: "", kind: "file", date: now.addingTimeInterval(-4 * 86400)),
            ]
            app.demoIndexLine = L10n.language == "en" ? "2533 items · 2 min ago" : "2533 条 · 2 分钟前更新"
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { app.popMenuForDemo() }
        } else if o.state == "s" {
            app.openSettings()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                print("[demo] state=s window=\(app.settingsController?.windowNumber ?? 0)")
                fflush(stdout)
            }
        } else if let (q, p) = phase(o.state) {
            // the copy names the key in use: the default ⌥⇧Space; ⌘Space only once it was taken over (k3)
            Store.hotKey = o.state == "k3" ? .commandSpace : .fallback
            let m = app.panel.model
            m.query = q
            m.phase = p
            m.holding = o.state == "v"   // push-to-talk: "release to send" + pressed key caps
            app.panel.show(animated: false)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                app.panel.fit()
                print("[demo] state=\(o.state) window=\(app.panel.panel.windowNumber) frame=\(NSStringFromRect(app.panel.panel.frame))")
                fflush(stdout)
            }
        } else {
            print("[demo] unknown state \(o.state)")
        }
        if o.quitAfter > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + o.quitAfter) { NSApp.terminate(nil) }
        }
    }
}

extension AppController {
    /// Opens the status menu in-process (NSStatusBarButton.performClick, no synthesized events) and prints the
    /// menu's window id so the window can be captured with `screencapture -l`.
    func popMenuForDemo() {
        let t = Timer(timeInterval: 0.7, repeats: false) { _ in
            let pid = ProcessInfo.processInfo.processIdentifier
            let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
            for w in list where (w[kCGWindowOwnerPID as String] as? Int32) == pid {
                let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
                print("[demo] state=9 window=\(w[kCGWindowNumber as String] ?? 0) layer=\(w[kCGWindowLayer as String] ?? 0) bounds=\(b)")
            }
            fflush(stdout)
            // menu tracking runs its own loop, so the --quit-after dispatch never fires: close it from a .common timer
            let close = Timer(timeInterval: 3, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.statusMenu?.cancelTracking()
                    DispatchQueue.main.async { NSApp.terminate(nil) }
                }
            }
            RunLoop.main.add(close, forMode: .common)
        }
        RunLoop.main.add(t, forMode: .common)
        statusItemButton?.performClick(nil)
    }
}
