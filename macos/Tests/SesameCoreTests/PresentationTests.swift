import XCTest
@testable import SesameCore

/// Demo / screenshot / test runs never make a window key or activate the app (CLAUDE.md invariant 13).
@MainActor
final class PresentationTests: XCTestCase {
    final class Recorder: Presentable {
        var calls: [String] = []
        func makeKeyAndOrderFront(_ sender: Any?) { calls.append("makeKey") }
        func orderFrontRegardless() { calls.append("orderFront") }
    }

    override func tearDown() { Presentation.passive = false }

    func testPassiveNeverMakesKeyNorActivates() {
        Presentation.passive = true
        let w = Recorder()
        var activated = false
        Presentation.show(w, activateApp: { activated = true })
        XCTAssertEqual(w.calls, ["orderFront"])
        XCTAssertFalse(w.calls.contains("makeKey"))
        XCTAssertFalse(activated)
        XCTAssertFalse(Presentation.mayTakeFocus)
    }

    func testHotKeyPanelStillTakesFocus() {
        Presentation.passive = false
        let w = Recorder()
        var activated = false
        Presentation.show(w, activateApp: { activated = true })
        XCTAssertEqual(w.calls, ["makeKey"])
        XCTAssertTrue(activated)
        XCTAssertTrue(Presentation.mayTakeFocus)
    }
}
