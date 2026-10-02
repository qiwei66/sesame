import XCTest
@testable import SesameCore

/// WO-20261002-034: success card = what the core opened, candidates / confirm from the core, human miss text,
/// empty-title fallback, index row text, restart policy, cancel notification.
final class WO034MapperTests: XCTestCase {
    private func step(_ tool: String, _ args: [String: JSONValue] = [:], confirm: Bool = false) -> IntentStep {
        IntentStep(tool: tool, args: args, needsConfirm: confirm)
    }

    func testSuccessCardShowsWhatTheCoreOpenedNotTheFirstSearchHit() {
        let r = HandleResult(input: "打开上周那个交易大盘", result: "已打开 库存看板（本机服务）", intent: [step("open_saved", ["query": .string("交易大盘")])],
                             cards: [ResultCard(title: "已打开 库存看板（本机服务）", tool: "open_saved", ok: true)], opened: nil, candidates: [])
        // a core with `opened`
        let r2 = HandleResult(input: r.input, layer: "llm", result: r.result, intent: r.intent, cards: r.cards,
                              opened: OpenedItem(key: "local:host:8787", title: "库存看板", url: "http://127.0.0.1:8787", kind: "local"), candidates: [])
        guard case .phase(.success(let line, let o)) = ResultMapper.map(r2) else { return XCTFail("expected success") }
        XCTAssertEqual(o.name, "库存看板")
        XCTAssertEqual(o.address, "localhost:8787")
        XCTAssertEqual(o.kind, .local)
        XCTAssertEqual(line?.chip, ChipKind.local)
        // without opened the card falls back to the core's own sentence, never a different item
        guard case .phase(.success(_, let o1)) = ResultMapper.map(r) else { return XCTFail("expected success") }
        XCTAssertEqual(o1.name, "已打开 库存看板（本机服务）")
    }

    func testCandidatesFromTheCoreBecomeTheListWithTitleFallback() {
        let hits = [SearchHit(key: "a", kind: "local", title: "库存看板", url: "http://127.0.0.1:8787"),
                    SearchHit(key: "b", kind: "web", title: "", url: "https://www.example.org/x"),
                    SearchHit(key: "c", kind: "file", title: " ", url: "/home/x/Desktop/报价单.pdf")]
        let r = HandleResult(input: "打开库存", layer: "local", result: "找到 3 个相近的，选一个", attention: true, intent: [step("open_saved", ["query": .string("库存")])],
                             cards: [ResultCard(title: "找到 3 个相近的，选一个", tool: "open_saved", ok: true, attention: false)], candidates: hits)
        guard case .phase(.candidates(let line, let c, let sel)) = ResultMapper.map(r) else { return XCTFail("expected candidates") }
        XCTAssertEqual(sel, 0)
        XCTAssertEqual(line?.chip, ChipKind.candidates(3))
        XCTAssertEqual(c.map(\.title), ["库存看板", "example.org", "报价单.pdf"])
        XCTAssertEqual(c.map(\.url), ["http://127.0.0.1:8787", "https://www.example.org/x", "/home/x/Desktop/报价单.pdf"])
    }

    func testNeedsConfirmationShowsTheConfirmCard() {
        let r = HandleResult(input: "把下载里的 dmg 都扔掉", result: "已取消删除", intent: [step("trash_files", confirm: true)],
                             cards: [ResultCard(title: "已取消删除", tool: "trash_files", ok: true)], candidates: [],
                             needsConfirmation: ConfirmRequest(message: "确定把 60 个 .dmg 移到废纸篓？"))
        guard case .phase(.confirm(_, let c)) = ResultMapper.map(r) else { return XCTFail("expected confirm") }
        XCTAssertEqual(c.title, "确定把 60 个 .dmg 移到废纸篓？")
    }

    func testMissCardIsHumanNoErrorCodeNoRepeatNoEcho() {
        let r = HandleResult(input: "打开汇率换算表", layer: "error", result: "没找到「汇率换算表」", attention: true, error: "no_model",
                             need: "换个说法，或者说出它标题里的一个词。没配模型也能用；配上后能听懂更模糊的说法", intent: [],
                             cards: [ResultCard(title: "没找到「汇率换算表」", detail: "换个说法，或者说出它标题里的一个词。没配模型也能用；配上后能听懂更模糊的说法", tool: "", ok: false, attention: true)], candidates: [])
        guard case .phase(.notFound(_, let m)) = ResultMapper.map(r) else { return XCTFail("expected notFound") }
        XCTAssertEqual(m.message, "没找到「汇率换算表」")
        XCTAssertEqual(m.done, "", "same sentence is not shown twice")
        XCTAssertTrue(m.need.contains("没配模型也能用"))
        for s in [m.message, m.done, m.need] {
            XCTAssertFalse(s.contains("no_model") || s.contains("no model key") || s.contains("va doctor"))
            XCTAssertNotEqual(s, r.input)
        }
    }

    func testOldCoreWithoutCandidatesStillAsksTheAppToSearch() {
        let r = HandleResult(input: "打开库存", result: "x", attention: true, intent: [step("open_saved", ["query": .string("库存")])],
                             cards: [ResultCard(title: "x", tool: "open_saved", ok: false)])
        guard case .searchCandidates(let q, _) = ResultMapper.map(r) else { return XCTFail("expected searchCandidates") }
        XCTAssertEqual(q, "库存")
    }

    func testDisplayTitleFallbacks() {
        XCTAssertEqual(ResultMapper.displayTitle("", url: "https://www.example.org/a/b", kind: "web"), "example.org")
        XCTAssertEqual(ResultMapper.displayTitle("", url: "http://127.0.0.1:7341/", kind: "local"), "localhost:7341")
        XCTAssertEqual(ResultMapper.displayTitle("", url: "/home/x/a/报告.md", kind: "file"), "报告.md")
        XCTAssertEqual(ResultMapper.displayTitle("", url: "https://claude.ai/artifact/B6DM", kind: "artifact"), "B6DM")
        XCTAssertEqual(ResultMapper.displayTitle("库存看板", url: "http://127.0.0.1:8787", kind: "local"), "库存看板")
    }

    func testHandleResultDecodesNewFieldsAndOldCoreJSON() throws {
        let new = #"{"input":"x","layer":"local","dryRun":false,"result":"已打开 A","attention":false,"error":null,"need":null,"intent":[],"cards":[],"opened":{"key":"k","title":"A","url":"http://127.0.0.1:1","kind":"local","lastSeen":"2026-10-01T00:00:00Z"},"candidates":[],"needsConfirmation":null,"cancelled":false}"#
        let r = try JSONDecoder().decode(HandleResult.self, from: Data(new.utf8))
        XCTAssertEqual(r.opened?.title, "A")
        XCTAssertEqual(r.candidates, [])
        let old = #"{"input":"x","layer":"llm","dryRun":false,"result":"ok","attention":false,"error":null,"intent":[],"cards":[]}"#
        let o = try JSONDecoder().decode(HandleResult.self, from: Data(old.utf8))
        XCTAssertNil(o.opened)
        XCTAssertNil(o.candidates)
    }
}

final class WO034StatusTests: XCTestCase {
    func testIndexLineIsHumanAndNeverAPath() {
        let now = ISO8601DateFormatter().date(from: "2026-10-02T06:00:00Z")!
        XCTAssertEqual(IndexLine.text(IndexStatus(running: true, progress: .init(phase: "scan", filesDone: 3, filesTotal: 9, items: 1204), items: 0, updatedAt: nil), now: now, zh: true), "正在整理… 1,204 条")
        XCTAssertEqual(IndexLine.text(IndexStatus(running: false, items: 2708, updatedAt: "2026-10-02T05:58:00.000Z"), now: now, zh: true), "2,708 条 · 2 分钟前")
        XCTAssertEqual(IndexLine.text(IndexStatus(running: false, items: 2708, updatedAt: "2026-10-02T05:58:00Z"), now: now, zh: false), "2,708 items · 2 min ago")
        XCTAssertEqual(IndexLine.text(IndexStatus(running: false, items: 0, updatedAt: nil), now: now, zh: true), "还没整理过")
        XCTAssertEqual(IndexLine.text(nil, now: now, zh: true), "正在连接…")
        XCTAssertEqual(IndexLine.ago(now.addingTimeInterval(-3 * 3600), now: now, zh: true), "3 小时前")
    }

    func testRestartPolicyStopsOnNodeErrorsAndAfterThreeSilentCrashes() {
        var p = RestartPolicy()
        XCTAssertEqual(p.didExit(status: 127, answeredSinceLaunch: false), .nodeMissing)
        XCTAssertEqual(p.didExit(status: 125, answeredSinceLaunch: false), .nodeTooOld)
        var q = RestartPolicy()
        XCTAssertNil(q.didExit(status: 1, answeredSinceLaunch: false))
        XCTAssertNil(q.didExit(status: 1, answeredSinceLaunch: false))
        XCTAssertEqual(q.didExit(status: 1, answeredSinceLaunch: false), .crashing(status: 1))
        var r = RestartPolicy()
        XCTAssertNil(r.didExit(status: 1, answeredSinceLaunch: false))
        XCTAssertNil(r.didExit(status: 1, answeredSinceLaunch: true), "an answer in between resets the count")
        XCTAssertNil(r.didExit(status: 1, answeredSinceLaunch: false))
    }

    func testCoreMessagesSayWhatToDo() {
        XCTAssertTrue(CoreMessage.headline(.nodeMissing, zh: true).contains("Node.js 22.18"))
        XCTAssertTrue(CoreMessage.fix(.nodeMissing, zh: true).contains("brew install node"))
        XCTAssertTrue(CoreMessage.fix(.nodeTooOld, zh: false).contains("nodejs.org"))
    }
}

final class WO034RPCClientTests: XCTestCase {
    func testGivesUpAtOnceWhenNodeIsMissing() {
        let c = RPCClient(command: ["/bin/sh", "-c", "exit 127"], log: { _ in })
        let failed = expectation(description: "failed")
        c.onStateChange = { s in if case .failed(.nodeMissing) = s { failed.fulfill() } }
        c.start()
        wait(for: [failed], timeout: 5)
        Thread.sleep(forTimeInterval: 1.5)   // a restart would have happened by now (backoff 1s)
        XCTAssertEqual(c.launchCount, 1, "no restart loop")
        c.stop()
    }

    func testCancelHandlesSendsACancelNotificationForTheRunningRequest() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("sesame-wo034-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("stdin.ndjson").path
        let c = RPCClient(command: ["/bin/sh", "-c", "cat > '\(file)'"], log: { _ in })
        c.start()
        Thread.sleep(forTimeInterval: 0.3)
        c.callRaw("handle", params: ["text": "打开库存看板"], timeout: 5) { _ in }
        XCTAssertEqual(c.inFlight("handle"), [1])
        XCTAssertEqual(c.cancelHandles(), [1])
        Thread.sleep(forTimeInterval: 0.3)
        c.stop()
        Thread.sleep(forTimeInterval: 0.2)
        let lines = try String(contentsOfFile: file, encoding: .utf8).split(separator: "\n")
        XCTAssertEqual(lines.count, 2)
        let cancel = try JSONSerialization.jsonObject(with: Data(lines[1].utf8)) as? [String: Any]
        XCTAssertEqual(cancel?["method"] as? String, "cancel")
        XCTAssertNil(cancel?["id"], "a notification, no id")
        XCTAssertEqual((cancel?["params"] as? [String: Any])?["id"] as? Int, 1)
    }
}
