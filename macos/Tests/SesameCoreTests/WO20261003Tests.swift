import XCTest
@testable import SesameCore

/// WO-20261003-002: no takeover card at launch; ⌥⇧Space by default, ⌘Space only after choosing it in Settings.
final class WO20261003Tests: XCTestCase {
    func testFirstLaunchNeverOffersTheTakeoverCard() {
        XCTAssertFalse(HotKeyPlan.takeoverAtLaunch)
    }

    func testDefaultIsTheBackupKeyWhateverHoldsCommandSpace() {
        for spotlight in [true, false] {
            for launcher in [nil, CommandSpaceHolder.alfred, .raycast] {
                let c = HotKeyPlan.choose(custom: nil, commandSpace: false, spotlightOn: spotlight, launcher: launcher)
                XCTAssertEqual(c.active, .fallback, "spotlight=\(spotlight) launcher=\(String(describing: launcher))")
                XCTAssertEqual(c.active.displayString, "⌥⇧Space")
                XCTAssertTrue(c.canTakeOver, "Settings still offers Take over ⌘Space…")
                // who holds ⌘Space is still known, so Settings can say where to free it
                XCTAssertEqual(c.blockedBy, spotlight ? .spotlight : launcher)
            }
        }
    }

    func testChosenInSettingsAndFreeMeansCommandSpace() {
        let c = HotKeyPlan.choose(custom: nil, commandSpace: true, spotlightOn: false, launcher: nil)
        XCTAssertEqual(c.active, .commandSpace)
        XCTAssertFalse(c.canTakeOver, "already on ⌘Space: no takeover button")
        let held = HotKeyPlan.choose(custom: nil, commandSpace: true, spotlightOn: false, launcher: .alfred)
        XCTAssertEqual(held.active, .fallback)
        XCTAssertEqual(held.blockedBy, .alfred)
    }

    func testUpgradeKeepsCommandSpaceForPeopleAlreadyOnIt() {
        // a new user: backup key, even when ⌘Space happens to be free
        XCTAssertFalse(HotKeyPlan.wantsCommandSpace(stored: nil, existingUser: false, commandSpaceFree: true))
        // upgrading, the old build had taken the free ⌘Space: keep it (no habit broken)
        XCTAssertTrue(HotKeyPlan.wantsCommandSpace(stored: nil, existingUser: true, commandSpaceFree: true))
        // upgrading, ⌘Space was held (so the old build was on the backup key already): stay there
        XCTAssertFalse(HotKeyPlan.wantsCommandSpace(stored: nil, existingUser: true, commandSpaceFree: false))
        // a choice made in Settings always wins
        XCTAssertFalse(HotKeyPlan.wantsCommandSpace(stored: false, existingUser: true, commandSpaceFree: true))
        XCTAssertTrue(HotKeyPlan.wantsCommandSpace(stored: true, existingUser: false, commandSpaceFree: false))
    }
}
