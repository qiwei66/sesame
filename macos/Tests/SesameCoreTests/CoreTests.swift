import XCTest
@testable import SesameCore

final class HotKeySpecTests: XCTestCase {
    func testFirstChoiceIsCommandSpaceBackupIsOptionShiftSpace() {
        XCTAssertEqual(HotKeySpec.commandSpace.displayString, "⌘Space")
        XCTAssertEqual(HotKeySpec.fallback.keyCode, 49)
        XCTAssertEqual(HotKeySpec.fallback.modifiers, HotKeySpec.option | HotKeySpec.shift)
        XCTAssertEqual(HotKeySpec.fallback.displayString, "⌥⇧Space")
        XCTAssertNil(HotKeySpec.fallback.rejection)
    }

    func testCommandSpaceCanBeChosenModifierRulesStay() {
        XCTAssertNil(HotKeySpec(keyCode: 49, modifiers: HotKeySpec.cmd).rejection, "⌘Space is allowed; whether it is free is decided at run time")
        XCTAssertNil(HotKeySpec(keyCode: 49, modifiers: HotKeySpec.cmd | HotKeySpec.shift).rejection)
        XCTAssertEqual(HotKeySpec(keyCode: 0, modifiers: 0).rejection, .needsModifier)
        XCTAssertEqual(HotKeySpec(keyCode: 0, modifiers: HotKeySpec.shift).rejection, .needsModifier)
    }

    func testStorageRoundTrip() {
        let s = HotKeySpec(keyCode: 40, modifiers: HotKeySpec.control | HotKeySpec.option)
        XCTAssertEqual(HotKeySpec(storageString: s.storageString), s)
        XCTAssertEqual(s.displayString, "⌃⌥K")
        XCTAssertNil(HotKeySpec(storageString: "junk"))
    }
}

final class CoreLocatorTests: XCTestCase {
    let home = URL(fileURLWithPath: "/home/tester")

    func testEnvWinsThenSettingThenInstalledThenCheckoutThenPath() {
        let all: Set<String> = ["/opt/va", "/home/tester/custom/va", "/home/tester/.local/share/sesame/core/bin/va", "/home/tester/.voice-agent/bin/va", "/usr/local/bin/va"]
        let exe = { (p: String) in all.contains(p) }
        XCTAssertEqual(CoreLocator.resolve(env: ["SESAME_CORE": "/opt/va", "PATH": "/usr/local/bin"], setting: "~/custom/va", home: home, isExecutable: exe), "/opt/va")
        XCTAssertEqual(CoreLocator.resolve(env: ["PATH": "/usr/local/bin"], setting: "~/custom/va", home: home, isExecutable: exe), "/home/tester/custom/va")
        XCTAssertEqual(CoreLocator.resolve(env: ["PATH": "/usr/local/bin"], setting: nil, home: home, isExecutable: exe), "/home/tester/.local/share/sesame/core/bin/va")
        XCTAssertEqual(CoreLocator.resolve(env: ["PATH": "/usr/local/bin"], setting: nil, home: home, isExecutable: { $0 != "/home/tester/.local/share/sesame/core/bin/va" && exe($0) }), "/home/tester/.voice-agent/bin/va")
        XCTAssertEqual(CoreLocator.resolve(env: ["PATH": "/usr/local/bin"], setting: nil, home: home, isExecutable: { $0 == "/usr/local/bin/va" }), "/usr/local/bin/va")
        XCTAssertNil(CoreLocator.resolve(env: [:], setting: nil, home: home, isExecutable: { _ in false }))
        XCTAssertEqual(CoreLocator.command(for: "/x/va"), ["/x/va", "serve", "--stdio"])
    }
}

final class LineSplitterTests: XCTestCase {
    func testSplitsAcrossChunks() {
        var s = LineSplitter()
        XCTAssertEqual(s.feed(Data("{\"a\":1}\n{\"b\"".utf8)).map { String(decoding: $0, as: UTF8.self) }, ["{\"a\":1}"])
        XCTAssertEqual(s.feed(Data(":2}\n\n".utf8)).map { String(decoding: $0, as: UTF8.self) }, ["{\"b\":2}"])
    }
}

final class ResultMapperTests: XCTestCase {
    private func decode(_ json: String) throws -> HandleResult {
        try JSONDecoder().decode(HandleResult.self, from: Data(json.utf8))
    }

    func testDecodesDocumentedHandleResultAndMapsToSuccess() throws {
        // the example from docs/rpc.md
        let r = try decode("""
        {"input":"open the inventory dashboard","normalized":"x","layer":"llm","dryRun":false,"result":"打开 Inventory Dashboard","attention":false,"error":null,
         "intent":[{"tool":"open_saved","args":{"query":"inventory dashboard"},"needsConfirm":false,"readOnly":false,"origin":"builtin"}],
         "cards":[{"title":"打开 Inventory Dashboard","detail":"","tool":"open_saved","ok":true,"dryRun":false,"attention":false}],
         "plan":[],"cost":{"cacheHit":false,"tokens":2930,"ms":1997,"estimate":{"amount":0.00031,"currency":"¥"},"provider":"deepseek","model":"m"},
         "cache":{"written":false,"candidate":true},"llmRounds":1}
        """)
        XCTAssertEqual(r.cost?.tokens, 2930)
        guard case .phase(.success(let line, let card)) = ResultMapper.map(r) else { return XCTFail("expected success") }
        XCTAssertEqual(line, IntentLine(verb: .open, target: "inventory dashboard", chip: nil))
        let enriched = ResultMapper.enrich(card, with: SearchHit(key: "k", kind: "local", title: "Inventory Dashboard", url: "http://127.0.0.1:8787/"))
        XCTAssertEqual(enriched.name, "Inventory Dashboard")
        XCTAssertEqual(enriched.address, "localhost:8787")
        XCTAssertEqual(enriched.kind, .local)
    }

    func testFailedOpenSavedAsksForCandidates() {
        let r = HandleResult(input: "打开咖啡店的官网", result: "没找到", attention: true,
                             intent: [IntentStep(tool: "open_saved", args: ["query": .string("咖啡店官网")])],
                             cards: [ResultCard(title: "没找到", tool: "open_saved", ok: false, attention: true)])
        XCTAssertEqual(ResultMapper.map(r), .searchCandidates(query: "咖啡店官网", line: IntentLine(verb: .open, target: "咖啡店官网", chip: nil)))
    }

    func testErrorLayerIsNotFound() {
        let r = HandleResult(input: "x", layer: "error", result: "模型调用失败", attention: true, error: "timeout", intent: [], cards: [ResultCard(title: "模型调用失败", tool: "", ok: false, attention: true)])
        guard case .phase(.notFound(nil, let m)) = ResultMapper.map(r) else { return XCTFail("expected notFound") }
        // the internal error code never reaches the panel (WO-20261002-034 P0-2)
        XCTAssertEqual(m.message, "模型调用失败")
        XCTAssertEqual(m.need, "")
    }

    func testReadOnlyBecomesInfoCardWithBigNumber() {
        let r = HandleResult(input: "电量", result: "电量 100%，已充满",
                             intent: [IntentStep(tool: "run_shell", args: ["command_id": .string("battery")], readOnly: true)],
                             cards: [ResultCard(title: "电量 100%，已充满", tool: "run_shell", ok: true)])
        guard case .phase(.info(let line, let card)) = ResultMapper.map(r) else { return XCTFail("expected info") }
        XCTAssertEqual(line?.verb, .query)
        XCTAssertEqual(line?.chip, .system)
        XCTAssertEqual(card.value, "100")
        XCTAssertEqual(card.unit, "%")
        XCTAssertEqual(card.fraction, 1)
    }

    func testDryRunConfirmBecomesConfirmCard() {
        let r = HandleResult(input: "扔掉 dmg", dryRun: true, result: "（演练）移到废纸篓 60 个文件",
                             intent: [IntentStep(tool: "trash_files", args: ["pattern": .string("*.dmg")], needsConfirm: true)],
                             cards: [ResultCard(title: "（演练）移到废纸篓 60 个文件", tool: "trash_files", ok: true, dryRun: true)])
        guard case .phase(.confirm(let line, _)) = ResultMapper.map(r) else { return XCTFail("expected confirm") }
        XCTAssertEqual(line?.verb, .trash)
    }

    func testDisplayAddress() {
        XCTAssertEqual(ResultMapper.displayAddress("https://www.example.com/a/b?k=1"), "example.com/a/b")
        XCTAssertEqual(ResultMapper.displayAddress("http://127.0.0.1:5173/"), "localhost:5173")
        XCTAssertEqual(ResultMapper.displayAddress("/tmp/report.md"), "report.md")
        XCTAssertEqual(ResultMapper.displayAddress(""), "")
    }

    func testCostNeverReachesPanelModel() {
        // PanelPhase has no cost field: the only consumer of CostTag is Settings > Usage.
        let mirror = Mirror(reflecting: OpenedCard(name: "a", kind: .web))
        XCTAssertFalse(mirror.children.contains { ($0.label ?? "").lowercased().contains("cost") || ($0.label ?? "").lowercased().contains("token") })
    }
}

final class LogFileNameTests: XCTestCase {
    func testTestHookBuildsWriteTheirOwnLogFile() {
        XCTAssertEqual(LogFileName.name(testHooks: false), "sesame.log")
        XCTAssertEqual(LogFileName.name(testHooks: true), "sesame-test.log")
        XCTAssertNotEqual(LogFileName.test, LogFileName.release)
    }
}
