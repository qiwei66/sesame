import XCTest
@testable import SesameCore

/// WO-20261002-041: results while typing, first-run counts, push-to-talk state machine (fake recognizer).
final class WO041LiveSearchTests: XCTestCase {
    private func c(_ id: String) -> Candidate { Candidate(id: id, title: id, address: "", url: "http://\(id)", kind: .web) }

    func testSentenceRuleSpaceOrVerbOrLongerThanSix() {
        XCTAssertTrue(LiveSearch.isSentence("打开上周让 Claude 做的那个交易大盘"))
        XCTAssertTrue(LiveSearch.isSentence("交易大盘复盘看板"), "longer than 6")
        XCTAssertTrue(LiveSearch.isSentence("库存 看板"), "has a space")
        XCTAssertTrue(LiveSearch.isSentence("打开看板"), "has a verb")
        XCTAssertTrue(LiveSearch.isSentence("open the inventory dashboard"))
        XCTAssertFalse(LiveSearch.isSentence("库存看板"), "a short keyword")
        XCTAssertFalse(LiveSearch.isSentence("期权作战手册"), "exactly 6, no verb, no space")
        XCTAssertFalse(LiveSearch.isSentence("看板"), "看 alone is not a verb (it is in 看板)")
        XCTAssertFalse(LiveSearch.isSentence("  "))
    }

    func testReturnOnTypedTextSentenceRunsTheFlowKeywordOpensTheSelectedRow() {
        let l = LiveList(items: [c("a"), c("b")], selected: 1, query: "x")
        XCTAssertEqual(LiveSearch.returnAction(query: "库存看板", list: l), .open(1))
        XCTAssertEqual(LiveSearch.returnAction(query: "打开上周做的库存看板", list: l), .submit("打开上周做的库存看板"))
        XCTAssertEqual(LiveSearch.returnAction(query: "库存 看板", list: l), .submit("库存 看板"))
        XCTAssertEqual(LiveSearch.returnAction(query: "打开看板", list: l), .submit("打开看板"))
        // nothing matched: the fallback row runs the flow even for a keyword
        XCTAssertEqual(LiveSearch.returnAction(query: "汇率表", list: LiveList(items: [], query: "汇率表")), .submit("汇率表"))
    }

    func testAlfredHotKeyParsing() {
        // real Alfred 5 file on this Mac: ⌘Space as AppKit flags
        XCTAssertEqual(AlfredHotKey.parse(["default": ["key": 49, "mod": 1048576, "string": "Space"]]), HotKeySpec(keyCode: 49, modifiers: HotKeySpec.cmd))
        XCTAssertEqual(AlfredHotKey.parse(["default": ["key": 49, "mod": 524288, "string": "Space"]]), .optionSpace, "⌥Space as AppKit flags")
        XCTAssertEqual(AlfredHotKey.parse(["default": ["key": 49, "mod": 2048]]), .optionSpace, "⌥Space as a Carbon mask")
        XCTAssertNotEqual(AlfredHotKey.parse(["default": ["key": 49, "mod": 1048576]]), .optionSpace)
        XCTAssertNil(AlfredHotKey.parse([:]))
    }

    func testSelectionStaysOnFirstRowUntilTheUserMoves() {
        XCTAssertEqual(LiveSearch.selection(in: [c("a"), c("b")], chosenId: nil), 0)
    }

    func testSelectionFollowsTheChosenItemAndFallsBackWhenItIsGone() {
        // user moved to "b"; the next keystroke reorders the list: selection follows "b"
        XCTAssertEqual(LiveSearch.selection(in: [c("x"), c("a"), c("b")], chosenId: "b"), 2)
        // "b" dropped out: back to the first row
        XCTAssertEqual(LiveSearch.selection(in: [c("x"), c("a")], chosenId: "b"), 0)
    }

    func testListCapsAtSixRowsAndEmptyMeansFallbackRow() {
        let l = LiveList(items: (0..<9).map { c("i\($0)") }, query: "大")
        XCTAssertEqual(l.items.count, 6)
        let none = LiveList(items: [], query: "交易大盘 v2")
        XCTAssertTrue(none.isFallback)
        XCTAssertNil(none.selectedItem)
    }

    func testLongIdsInAddressesAreCut() {
        XCTAssertEqual(ResultMapper.displayAddress("https://claude.ai/code/artifact/3115cd25-2dc2-478c-b013-c1ada4df904b"), "claude.ai/code/artifact/3115…04b")
        XCTAssertEqual(ResultMapper.displayAddress("https://github.com/acme/web-app/pull/628"), "github.com/acme/web-app/pull/628")
        XCTAssertEqual(ResultMapper.displayAddress("http://127.0.0.1:8787"), "localhost:8787")
        XCTAssertEqual(ResultMapper.displayAddress("https://example.org/articles/a-very-long-readable-slug"), "example.org/articles/a-very-long-readable-slug", "words, not an id")
    }

    func testAnimationKind() {
        XCTAssertEqual(LiveSearch.change(from: 0, to: 4), .appear)
        XCTAssertEqual(LiveSearch.change(from: 4, to: 1), .update)
        XCTAssertEqual(LiveSearch.change(from: 0, to: 0), .none)
    }
}

final class WO041FirstRunTests: XCTestCase {
    func testCountTweenRollsWithoutJumpingBack() {
        let t0 = Date(timeIntervalSince1970: 0)
        var tw = CountTween(value: 0, duration: 1.2, now: t0)
        tw.retarget(2708, now: t0)
        XCTAssertEqual(tw.value(at: t0), 0, accuracy: 0.001)
        XCTAssertEqual(tw.value(at: t0.addingTimeInterval(1.2)), 2708, accuracy: 0.001)
        let mid = tw.value(at: t0.addingTimeInterval(0.6))
        XCTAssertGreaterThan(mid, 2708 * 0.8, "ease-out: most of the way at half time")
        // the index keeps growing mid-roll: continue from the current value
        tw.retarget(3000, now: t0.addingTimeInterval(0.6), duration: 0.6)
        XCTAssertEqual(tw.value(at: t0.addingTimeInterval(0.6)), mid, accuracy: 0.001)
        XCTAssertEqual(tw.value(at: t0.addingTimeInterval(1.2)), 3000, accuracy: 0.001)
    }

    func testGroupsAndTotalFromIndexStatus() {
        let g = IntroCounts.groups(["dashboard": 3, "pr": 7, "bogus": 1])
        XCTAssertEqual(g[.dashboard], 3)
        XCTAssertEqual(g[.pr], 7)
        XCTAssertEqual(g[.deck], 0)
        XCTAssertEqual(g.count, 6)
        let running = IndexStatus(running: true, progress: .init(phase: "scan", filesDone: 1, filesTotal: 9, items: 120), items: 0, updatedAt: nil)
        XCTAssertEqual(IntroCounts.total(running), 120)
        XCTAssertEqual(IntroCounts.total(IndexStatus(running: false, items: 2708, updatedAt: nil)), 2708, "older core")
        XCTAssertEqual(IntroCounts.total(IndexStatus(running: false, items: 2648, updatedAt: nil, groups: ["pr": 88, "file": 51], made: 709)), 709, "only what the AI made")
        XCTAssertEqual(IntroCounts.total(IndexStatus(running: true, items: 10, updatedAt: nil, groups: ["pr": 2, "site": 3])), 5)
        XCTAssertEqual(IntroCounts.total(nil), 0)
    }

    func testEmptyGroupsAreHiddenAndFewerThanThreeIsOneRow() {
        let g: [IntroGroupKind: Int] = [.dashboard: 17, .report: 515, .deck: 0, .site: 38, .pr: 88, .file: 51]
        XCTAssertEqual(IntroCounts.visible(g), [.dashboard, .report, .site, .pr, .file])
        XCTAssertEqual(IntroCounts.columns(for: 5), 3)
        XCTAssertEqual(IntroCounts.visible([.pr: 3, .file: 1]), [.pr, .file])
        XCTAssertEqual(IntroCounts.columns(for: 2), 2, "two groups: one row of two")
        XCTAssertEqual(IntroCounts.columns(for: 1), 1)
    }

    func testIndexStatusDecodesGroupsAndSample() throws {
        let s = try JSONDecoder().decode(IndexStatus.self, from: Data(#"{"running":false,"progress":null,"items":2,"updatedAt":null,"last":"done","lastError":null,"groups":{"dashboard":1,"report":0,"deck":0,"site":0,"pr":1,"file":0}}"#.utf8))
        XCTAssertEqual(s.groups?["pr"], 1)
        let old = try JSONDecoder().decode(IndexStatus.self, from: Data(#"{"running":false,"items":2,"updatedAt":null}"#.utf8))
        XCTAssertNil(old.groups, "older core without groups still decodes")
        let r = try JSONDecoder().decode(SampleResult.self, from: Data(#"{"sample":{"key":"local:host:8787","title":"库存看板","url":"http://127.0.0.1:8787","kind":"local"}}"#.utf8))
        XCTAssertEqual(r.sample?.title, "库存看板")
        XCTAssertNil(try JSONDecoder().decode(SampleResult.self, from: Data(#"{"sample":null}"#.utf8)).sample)
    }
}

/// Fake recognizer: the test decides authorization and feeds partials.
final class FakeRecognizer: SpeechRecognizing {
    var authorization: SpeechAuth
    var grantOnRequest: SpeechAuth = .authorized
    var requested = 0
    var started: [String] = []
    var stopped = 0
    var cancelled = 0
    var finalText = ""
    var partial: (@Sendable (String) -> Void)?
    var failed: (@Sendable (String) -> Void)?
    init(_ a: SpeechAuth) { authorization = a }
    func requestAuthorization(_ done: @escaping @Sendable (SpeechAuth) -> Void) { requested += 1; authorization = grantOnRequest; done(grantOnRequest) }
    func start(languageCode: String, partial: @escaping @Sendable (String) -> Void, failed: @escaping @Sendable (String) -> Void) {
        started.append(languageCode); self.partial = partial; self.failed = failed
    }
    func stop(_ final: @escaping @Sendable (String) -> Void) { stopped += 1; final(finalText) }
    func cancel() { cancelled += 1 }
}

final class WO041PushToTalkTests: XCTestCase {
    private var pending: [(TimeInterval, () -> Void, Bool)] = []
    private var out: [PushToTalkOutput] = []

    private func make(_ r: FakeRecognizer, lang: String = "zh-CN") -> PushToTalkController {
        pending = []; out = []
        return PushToTalkController(recognizer: r, schedule: { [unowned self] d, b in
            self.pending.append((d, b, false))
            let i = self.pending.count - 1
            return { [unowned self] in self.pending[i].2 = true }
        }, languageCode: { lang }, onMain: { $0() }, output: { [unowned self] in self.out.append($0) })
    }

    /// fire the hold timer (if it was not cancelled)
    private func elapse() { for (i, p) in pending.enumerated() where !p.2 { pending[i].2 = true; p.1() } }

    func testShortPressIsATapNoListening() {
        let r = FakeRecognizer(.authorized)
        let p = make(r)
        p.keyDown()
        XCTAssertEqual(pending.first?.0, 0.3)
        p.keyUp()
        elapse()   // the cancelled timer must not fire
        XCTAssertEqual(out, [.tap])
        XCTAssertTrue(r.started.isEmpty)
        XCTAssertEqual(p.state, .idle)
    }

    func testHoldListensStreamsAndSendsOnRelease() {
        let r = FakeRecognizer(.authorized)
        let p = make(r, lang: "en-US")
        p.keyDown(); elapse()
        XCTAssertEqual(r.started, ["en-US"])
        XCTAssertEqual(out.last, .listening(final: "", interim: ""))
        r.partial?("打开上周")
        r.partial?("打开上周那个交易")
        XCTAssertEqual(out.last, .listening(final: "打开上周", interim: "那个交易"))
        r.finalText = "打开上周那个交易大盘"
        p.keyUp()
        XCTAssertEqual(out.last, .submit("打开上周那个交易大盘"))
        XCTAssertEqual(p.state, .idle)
        // late partials after release are ignored
        r.partial?("garbage")
        XCTAssertEqual(out.last, .submit("打开上周那个交易大盘"))
    }

    func testReleaseWithNothingHeardCancels() {
        let r = FakeRecognizer(.authorized)
        let p = make(r)
        p.keyDown(); elapse(); p.keyUp()
        XCTAssertEqual(out.last, .cancelled)
    }

    func testFirstHoldShowsTheNoticeAndAsksTheSystemOnlyAfterAllow() {
        let r = FakeRecognizer(.notDetermined)
        let p = make(r)
        p.keyDown(); elapse()
        XCTAssertEqual(out.last, .askPermission)
        XCTAssertEqual(r.requested, 0, "no system prompt before the user pressed Allow")
        XCTAssertTrue(r.started.isEmpty)
        p.keyUp()
        XCTAssertEqual(out.last, .askPermission, "releasing the key leaves the notice up")
        p.allow()
        XCTAssertEqual(r.requested, 1)
        XCTAssertEqual(out.last, .ready)
        // next hold listens
        p.keyDown(); elapse()
        XCTAssertEqual(r.started.count, 1)
    }

    func testNotNowThenDeniedSaysHowToTurnItOn() {
        let r = FakeRecognizer(.notDetermined)
        r.grantOnRequest = .denied
        let p = make(r)
        p.keyDown(); elapse(); p.decline()
        XCTAssertEqual(p.state, .idle)
        p.keyDown(); elapse()
        XCTAssertEqual(out.last, .askPermission, "after Not now the notice comes back, no penalty")
        p.allow()
        XCTAssertEqual(out.last, .denied)
        p.keyDown(); elapse()
        XCTAssertEqual(out.last, .denied, "denied: never listens, says how to fix")
        XCTAssertTrue(r.started.isEmpty)
    }

    func testAutoRepeatDownIsIgnoredAndEscCancels() {
        let r = FakeRecognizer(.authorized)
        let p = make(r)
        p.keyDown(); p.keyDown(); p.keyDown()
        XCTAssertEqual(pending.count, 1)
        elapse()
        p.cancel()
        XCTAssertEqual(r.cancelled, 1)
        XCTAssertEqual(p.state, .idle)
        r.partial?("late")
        XCTAssertEqual(out.last, .listening(final: "", interim: ""))
    }

    func testUnavailableRecognizer() {
        let r = FakeRecognizer(.unavailable)
        let p = make(r)
        p.keyDown(); elapse()
        XCTAssertEqual(out.last, .unavailable)
    }

    func testTranscriptSplit() {
        XCTAssertEqual(TranscriptSplit.split(previous: "", current: "打开").final, "")
        let s = TranscriptSplit.split(previous: "打开上周那个", current: "打开上周那个交易大盘")
        XCTAssertEqual(s.final, "打开上周那个")
        XCTAssertEqual(s.interim, "交易大盘")
        let r = TranscriptSplit.split(previous: "open the comp", current: "open the computer")
        XCTAssertEqual(r.final, "open the comp")
        XCTAssertEqual(r.interim, "uter")
    }
}
