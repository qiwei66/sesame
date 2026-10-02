import XCTest
@testable import SesameCore

final class PasteCommitTests: XCTestCase {
    let t0 = Date(timeIntervalSince1970: 1_000_000)

    func testPasteOfTwoOrMoreCharsCommitsAfter400msOfStability() {
        var d = PasteCommitDetector()
        let deadline = d.textDidChange(to: "打开库存看板", source: .paste, at: t0)
        XCTAssertEqual(deadline, t0.addingTimeInterval(0.4))
        XCTAssertNil(d.fire(at: t0.addingTimeInterval(0.399)), "must not commit before the text has been stable for 400ms")
        XCTAssertEqual(d.fire(at: t0.addingTimeInterval(0.4)), "打开库存看板")
        XCTAssertFalse(d.isArmed, "fires once")
        XCTAssertNil(d.fire(at: t0.addingTimeInterval(1)))
    }

    func testSingleCharacterPasteDoesNotArm() {
        var d = PasteCommitDetector()
        XCTAssertNil(d.textDidChange(to: "a", source: .paste, at: t0))
        XCTAssertNil(d.fire(at: t0.addingTimeInterval(5)))
    }

    func testTypingNeverAutoCommitsEvenWhenAnInputMethodCommitsAWord() {
        var d = PasteCommitDetector()
        // pinyin IME commits "你好" in one insertText call: still keyboard input -> Return required
        XCTAssertNil(d.textDidChange(to: "你好", source: .typed, at: t0))
        XCTAssertNil(d.textDidChange(to: "你好世界", source: .typed, at: t0.addingTimeInterval(1)))
        XCTAssertNil(d.fire(at: t0.addingTimeInterval(10)))
    }

    func testExternalValueChangeCountsLikePaste() {
        var d = PasteCommitDetector()
        XCTAssertNotNil(d.textDidChange(to: "open the dashboard", source: .external, at: t0))
        XCTAssertEqual(d.fire(at: t0.addingTimeInterval(0.5)), "open the dashboard")
    }

    func testStreamingChunksExtendTheWindow() {
        var d = PasteCommitDetector()
        d.textDidChange(to: "打开上周", source: .paste, at: t0)
        // next chunk 300ms later (before the first deadline): deadline moves
        let dl = d.textDidChange(to: "打开上周的看板", source: .paste, at: t0.addingTimeInterval(0.3))
        XCTAssertEqual(dl?.timeIntervalSince(t0) ?? -1, 0.7, accuracy: 1e-6)
        XCTAssertNil(d.fire(at: t0.addingTimeInterval(0.4)), "the old deadline is void")
        // a one-character tail from the same tool keeps it armed
        XCTAssertNotNil(d.textDidChange(to: "打开上周的看板。", source: .external, at: t0.addingTimeInterval(0.5)))
        XCTAssertEqual(d.fire(at: t0.addingTimeInterval(0.9)), "打开上周的看板。")
    }

    func testTypingAfterPasteDisarms() {
        var d = PasteCommitDetector()
        d.textDidChange(to: "打开看板", source: .paste, at: t0)
        XCTAssertNil(d.textDidChange(to: "打开看板x", source: .typed, at: t0.addingTimeInterval(0.2)))
        XCTAssertNil(d.fire(at: t0.addingTimeInterval(1)))
    }

    func testDeletionAfterPasteDisarms() {
        var d = PasteCommitDetector()
        d.textDidChange(to: "打开看板", source: .paste, at: t0)
        XCTAssertNil(d.textDidChange(to: "打开看", source: .external, at: t0.addingTimeInterval(0.2)))
        XCTAssertNil(d.fire(at: t0.addingTimeInterval(1)))
    }

    func testWhitespaceOnlyPasteDoesNotSubmit() {
        var d = PasteCommitDetector()
        d.textDidChange(to: "   ", source: .paste, at: t0)
        XCTAssertNil(d.fire(at: t0.addingTimeInterval(1)))
    }

    func testPasteIntoExistingTypedText() {
        var d = PasteCommitDetector()
        d.textDidChange(to: "打开", source: .typed, at: t0)
        XCTAssertNotNil(d.textDidChange(to: "打开库存看板", source: .paste, at: t0.addingTimeInterval(1)))
        XCTAssertEqual(d.fire(at: t0.addingTimeInterval(1.4)), "打开库存看板")
    }

    func testInsertedCount() {
        XCTAssertEqual(PasteCommitDetector.insertedCount(old: "", new: "abc"), 3)
        XCTAssertEqual(PasteCommitDetector.insertedCount(old: "ac", new: "abbc"), 2)
        XCTAssertEqual(PasteCommitDetector.insertedCount(old: "abc", new: "ab"), 0)
        XCTAssertEqual(PasteCommitDetector.insertedCount(old: "aa", new: "aaa"), 1)
        XCTAssertEqual(PasteCommitDetector.insertedCount(old: "看板", new: "库存看板"), 2)
        XCTAssertEqual(PasteCommitDetector.insertedCount(old: "abc", new: "xyz"), 3, "replace-all counts the new text")
    }

    func testResetClearsArmedState() {
        var d = PasteCommitDetector()
        d.textDidChange(to: "打开看板", source: .paste, at: t0)
        d.reset()
        XCTAssertNil(d.fire(at: t0.addingTimeInterval(1)))
    }
}
