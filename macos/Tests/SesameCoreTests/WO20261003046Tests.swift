import XCTest
@testable import SesameCore

/// WO-20261003-046: the share card footer gives the install command, then names the repository.
final class WO20261003046Tests: XCTestCase {
    func testShareCardFooterNamesInstallThenRepo() {
        XCTAssertEqual(ShareCard.install, "brew install qiwei66/tap/sesame")
        XCTAssertEqual(ShareCard.repo, "github.com/qiwei66/sesame")
        XCTAssertEqual(ShareCard.site, "qiwei66.github.io/sesame")
        XCTAssertEqual(ShareCard.footer, "brew install qiwei66/tap/sesame  ·  github.com/qiwei66/sesame")
    }
}
