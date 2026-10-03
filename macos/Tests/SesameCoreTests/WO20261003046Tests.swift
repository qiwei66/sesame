import XCTest
@testable import SesameCore

/// WO-20261003-046: the share card footer names the site and the repository.
final class WO20261003046Tests: XCTestCase {
    func testShareCardFooterNamesSiteThenRepo() {
        XCTAssertEqual(ShareCard.site, "qiwei66.github.io/sesame")
        XCTAssertEqual(ShareCard.repo, "github.com/qiwei66/sesame")
        XCTAssertEqual(ShareCard.footer, "qiwei66.github.io/sesame  ·  github.com/qiwei66/sesame")
    }
}
