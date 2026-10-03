import XCTest
@testable import SesameCore

/// WO-20261003-057: the first-run count line says what to do next (find one by saying it),
/// not "one sentence makes N creations". The share card keeps its own line.
final class WO057Tests: XCTestCase {
    private func strings(_ lang: String) throws -> [String: String] {
        let res = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../Resources")
        let url = res.appendingPathComponent("\(lang).lproj/Localizable.strings")
        return try XCTUnwrap(NSDictionary(contentsOf: url) as? [String: String], "\(lang) strings load")
    }

    func testIntroCountCopy() throws {
        let want = ["zh-Hans": ("", " 个 AI 产物，想找哪个，说一句就行。"),
                    "en": ("", " AI creations. Say which one you need.")]
        for (lang, parts) in want {
            let t = try XCTUnwrap(try strings(lang)["intro.count"], "\(lang) intro.count")
            let (a, b) = ShareCard.split(t)
            XCTAssertEqual(a, parts.0, "\(lang) number leads the line")
            XCTAssertEqual(b, parts.1, "\(lang) intro.count")
            XCTAssertFalse(t.contains("一句话的事") || t.contains("one sentence away"), "\(lang) old copy is gone")
        }
    }

    func testShareHeadlineUnchanged() throws {
        XCTAssertEqual(try strings("zh-Hans")["share.headline"], "我的 %@ 个 AI 产物，\n动动嘴就调出来。")
    }
}
