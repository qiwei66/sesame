import XCTest
@testable import SesameCore

/// WO-20261003-040: installed apps in the live list, ranked around what the AI made (docs/live-ranking.md).
/// Every app here is a fixture record; nothing depends on what is installed on this Mac.
final class WO040AppTests: XCTestCase {
    let typeless = AppRecord(path: "/Applications/Typeless.app", displayName: "Typeless", names: ["Typeless"])
    let lark = AppRecord(path: "/Applications/Lark.app", displayName: "Lark", names: ["Lark", "飞书", "Feishu"])
    let vscode = AppRecord(path: "/Applications/Visual Studio Code.app", displayName: "Visual Studio Code", names: ["Visual Studio Code", "Code"])
    let settings = AppRecord(path: "/System/Applications/System Settings.app", displayName: "System Settings", names: ["System Settings", "系统设置"])
    let terminal = AppRecord(path: "/System/Applications/Utilities/Terminal.app", displayName: "Terminal", names: ["Terminal", "终端"])
    let tradingApp = AppRecord(path: "/Applications/我的交易大盘Pro.app", displayName: "我的交易大盘Pro", names: [])
    var apps: [AppRecord] { [typeless, lark, vscode, settings, terminal, tradingApp] }

    let dash = SearchHit(key: "local:8787", kind: "local", title: "交易大盘", url: "http://127.0.0.1:8787", made: true)
    let review = SearchHit(key: "artifact:ty", kind: "artifact", title: "typeless 测评报告", url: "https://claude.ai/artifact/aaaa", made: true)
    let repo = SearchHit(key: "web:repo", kind: "web", title: "typeless-tools", url: "https://github.com/example-user/typeless-tools", made: false)

    func testTypelessOpensTheAppFirst() {
        let l = AppSearch.merge(query: "typeless", apps: apps, hits: [review, repo])
        XCTAssertEqual(l.first?.title, "Typeless")
        XCTAssertEqual(l.first?.kind, .app)
        XCTAssertEqual(l.first?.url, "/Applications/Typeless.app")
        XCTAssertEqual(l.first?.address, "Applications")
        XCTAssertEqual(AppSearch.folder("/System/Applications/Utilities/Terminal.app", home: "/home/someone"), "System/Applications/Utilities")
        XCTAssertEqual(AppSearch.folder("/home/someone/Applications/X.app", home: "/home/someone"), "~/Applications")
        XCTAssertEqual(l.map(\.id), ["app:/Applications/Typeless.app", "artifact:ty", "web:repo"], "app > what the AI made > a link")
        // ↩ opens it although "typeless" is longer than six characters (would read as a sentence otherwise)
        XCTAssertTrue(LiveSearch.isSentence("typeless"))
        XCTAssertEqual(LiveSearch.returnAction(query: "typeless", list: LiveList(items: l, query: "typeless")), .open(0))
        // the prefix while typing already puts it first
        XCTAssertEqual(AppSearch.merge(query: "typel", apps: apps, hits: []).first?.title, "Typeless")
    }

    func testLocalizedAndPinyinNames() {
        XCTAssertEqual(AppSearch.merge(query: "飞书", apps: apps, hits: []).first?.url, "/Applications/Lark.app")
        // the row says the name that was typed (Finder may say "Lark" / "Feishu" on an English-first Mac)
        XCTAssertEqual(AppSearch.merge(query: "飞书", apps: apps, hits: []).first?.title, "飞书")
        XCTAssertEqual(AppSearch.merge(query: "feishu", apps: apps, hits: []).first?.title, "Feishu")
        XCTAssertEqual(AppSearch.merge(query: "lark", apps: apps, hits: []).first?.title, "Lark")
        XCTAssertEqual(AppSearch.merge(query: "xitong", apps: apps, hits: []).first?.title, "系统设置", "pinyin shows the Chinese name")
        XCTAssertEqual(AppSearch.merge(query: "feishu", apps: apps, hits: []).first?.url, "/Applications/Lark.app")
        XCTAssertEqual(AppSearch.merge(query: "lark", apps: apps, hits: []).first?.url, "/Applications/Lark.app")
        XCTAssertEqual(AppSearch.merge(query: "系统设置", apps: apps, hits: []).first?.url, settings.path)
        XCTAssertEqual(AppSearch.merge(query: "system settings", apps: apps, hits: []).first?.url, settings.path)
        XCTAssertEqual(AppSearch.merge(query: "终端", apps: apps, hits: []).first?.url, terminal.path)
        // pinyin initials of a Chinese-only name
        let wechat = AppRecord(path: "/Applications/微信.app", displayName: "微信", names: ["微信"])
        XCTAssertEqual(AppSearch.match("wx", wechat), .acronym)
        XCTAssertEqual(AppSearch.match("weixin", wechat), .exact)
    }

    func testAcronymAndWordStart() {
        XCTAssertEqual(AppSearch.match("vsc", vscode), .acronym)
        XCTAssertEqual(AppSearch.merge(query: "vsc", apps: apps, hits: []).first?.url, vscode.path)
        XCTAssertEqual(AppSearch.match("studio", vscode), .wordPrefix)
        XCTAssertEqual(AppSearch.match("code", vscode), .exact, "CFBundleName Code")
        XCTAssertEqual(AppSearch.match("settings", settings), .wordPrefix)
        XCTAssertEqual(AppSearch.match("ttings", settings), .substring)
        XCTAssertNil(AppSearch.match("zzq", vscode))
        XCTAssertEqual(AppSearch.words("WeChat"), ["We", "Chat"])
    }

    func testPrefixBeatsSubstring() {
        let notes = AppRecord(path: "/System/Applications/Notes.app", displayName: "Notes", names: [])
        let keynote = AppRecord(path: "/Applications/Keynote.app", displayName: "Keynote", names: [])
        let r = AppSearch.search("note", in: [keynote, notes])
        XCTAssertEqual(r.map(\.app.displayName), ["Notes", "Keynote"])
        XCTAssertEqual(r.map(\.match), [.prefix, .substring])
    }

    func testArtifactNameIsNotTakenByAnApp() {
        // 交易大盘 is in an app's name, but only inside it: what the AI made stays first
        let l = AppSearch.merge(query: "交易大盘", apps: apps, hits: [dash])
        XCTAssertEqual(l.map(\.id), ["local:8787", "app:/Applications/我的交易大盘Pro.app"])
        XCTAssertEqual(LiveSearch.returnAction(query: "交易大盘", list: LiveList(items: l, query: "交易大盘")), .open(0))
        XCTAssertEqual(l[0].kind, .local)
    }

    func testOneCharacterAndLimits() {
        // one letter: only names that start with it, at most two app rows, then what the AI made
        let t = AppSearch.merge(query: "t", apps: apps, hits: [dash])
        XCTAssertEqual(t.filter { $0.kind == .app }.map(\.title), ["Terminal", "Typeless"])
        XCTAssertEqual(t.last?.id, "local:8787")
        XCTAssertTrue(AppSearch.merge(query: "大", apps: apps, hits: [dash]).allSatisfy { $0.kind != .app }, "one Han character inside a name is not a match")
        let many = (0..<10).map { AppRecord(path: "/Applications/Test\($0).app", displayName: "Test\($0)", names: []) }
        XCTAssertEqual(AppSearch.merge(query: "test", apps: many, hits: [dash]).filter { $0.kind == .app }.count, AppSearch.maxStrong)
        XCTAssertLessThanOrEqual(AppSearch.merge(query: "test", apps: many, hits: [dash, review]).count, LiveList.maxRows)
    }

    func testOlderCoreWithoutMadeCountsAsMade() {
        let old = SearchHit(key: "artifact:x", kind: "artifact", title: "Typeless notes", url: "https://claude.ai/artifact/x")
        XCTAssertNil(old.made)
        XCTAssertEqual(AppSearch.merge(query: "typeless", apps: [typeless, tradingApp], hits: [old]).map(\.id), ["app:/Applications/Typeless.app", "artifact:x"])
    }

    func testDecodesMadeFromTheCore() throws {
        let json = #"{"query":"x","results":[{"key":"web:r","kind":"web","title":"r","url":"https://example.com","made":false},{"key":"a","kind":"artifact","title":"a","url":null}]}"#
        let r = try JSONDecoder().decode(SearchResult.self, from: Data(json.utf8))
        XCTAssertEqual(r.results.map(\.made), [false, nil])
    }

    // MARK: scanning fixture bundles

    private func makeApp(_ dir: URL, _ name: String, info: [String: String] = [:], zh: [String: String]? = nil, loctable: [String: [String: String]]? = nil) throws {
        let c = dir.appendingPathComponent("\(name).app/Contents", isDirectory: true)
        try FileManager.default.createDirectory(at: c.appendingPathComponent("Resources"), withIntermediateDirectories: true)
        var plist = info; plist["CFBundleIdentifier"] = "test.\(name)"
        (plist as NSDictionary).write(to: c.appendingPathComponent("Info.plist"), atomically: true)
        if let zh {
            let l = c.appendingPathComponent("Resources/zh_CN.lproj", isDirectory: true)
            try FileManager.default.createDirectory(at: l, withIntermediateDirectories: true)
            let body = zh.map { "\"\($0.key)\" = \"\($0.value)\";" }.joined(separator: "\n")
            try body.write(to: l.appendingPathComponent("InfoPlist.strings"), atomically: true, encoding: .utf16)
        }
        if let loctable { (loctable as NSDictionary).write(to: c.appendingPathComponent("Resources/InfoPlist.loctable"), atomically: true) }
    }

    func testScanReadsLocalizedNamesFromBundleFiles() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("sesame-apps-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try makeApp(dir, "Lark", info: ["CFBundleName": "Feishu"], zh: ["CFBundleDisplayName": "飞书"])
        try makeApp(dir, "System Settings", loctable: ["zh_CN": ["CFBundleName": "系统设置"], "en": ["CFBundleName": "System Settings"]])
        try makeApp(dir, "Visual Studio Code", info: ["CFBundleName": "Code"])
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("Not An App"), withIntermediateDirectories: true)
        let cat = AppCatalog(folders: [dir.path, dir.path + "/missing"])
        cat.scanNow()
        let recs = cat.records
        XCTAssertEqual(recs.count, 3)
        let byFile = Dictionary(uniqueKeysWithValues: recs.map { (($0.path as NSString).lastPathComponent, $0) })
        XCTAssertTrue(byFile["Lark.app"]!.names.contains("飞书"))
        XCTAssertTrue(byFile["Lark.app"]!.names.contains("Feishu"))
        XCTAssertTrue(byFile["System Settings.app"]!.names.contains("系统设置"))
        XCTAssertEqual(AppSearch.merge(query: "飞书", apps: recs, hits: []).first?.url, byFile["Lark.app"]!.path)
        XCTAssertEqual(AppSearch.merge(query: "vsc", apps: recs, hits: []).first?.url, byFile["Visual Studio Code.app"]!.path)
    }

    func testFolderChangesRescan() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("sesame-apps-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try makeApp(dir, "Alpha")
        let cat = AppCatalog(folders: [dir.path])
        cat.start()
        func wait(_ what: String, _ cond: () -> Bool) {
            let t0 = Date()
            while !cond() && Date().timeIntervalSince(t0) < 8 { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
            XCTAssertTrue(cond(), what)
        }
        wait("first scan") { cat.records.map(\.displayName) == ["Alpha"] }
        try makeApp(dir, "Beta")   // a new app is installed
        wait("new app shows up") { Set(cat.records.map(\.displayName)) == ["Alpha", "Beta"] }
        try FileManager.default.removeItem(at: dir.appendingPathComponent("Alpha.app"))   // an app is deleted
        wait("removed app goes away") { cat.records.map(\.displayName) == ["Beta"] }
    }

    func testMatchingAThousandAppsIsFast() {
        let many = (0..<1000).map { AppRecord(path: "/Applications/App \($0) Studio.app", displayName: "App \($0) Studio", names: ["应用\($0)"]) }
        let t0 = Date()
        for q in ["a", "ap", "app", "app 5", "studio", "as", "应用", "typeless"] { _ = AppSearch.merge(query: q, apps: many, hits: []) }
        let ms = Date().timeIntervalSince(t0) * 1000 / 8
        XCTAssertLessThan(ms, 20, "per keystroke over 1000 apps: \(ms) ms")
    }
}
