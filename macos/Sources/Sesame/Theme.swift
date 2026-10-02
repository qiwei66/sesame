import AppKit
import SwiftUI

/// Design tokens from design/DESIGN.md + design/prototype.html (:root and :root[data-theme="dark"]).
/// Every color resolves per appearance, so the panel follows light/dark like the system.
enum Tok {
    static func dynNS(_ light: NSColor, _ dark: NSColor) -> NSColor {
        NSColor(name: nil) { ap in ap.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light }
    }
    private static func dyn(_ light: NSColor, _ dark: NSColor) -> Color { Color(nsColor: dynNS(light, dark)) }

    // AppKit copies for the NSTextField (stay dynamic across appearance changes)
    static let nsText2 = dynNS(hex(0x45454D), hex(0xC9C9D1))
    static let nsText4 = dynNS(hex(0x8C8C95), hex(0x7A7A85))
    static let nsAccent = dynNS(hex(0x34323A), hex(0xEFE6D8))
    private static func hex(_ v: UInt32, _ a: CGFloat = 1) -> NSColor {
        NSColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: a)
    }
    private static func rgba(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat) -> NSColor {
        NSColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a)
    }

    static let accent = dyn(hex(0x34323A), hex(0xEFE6D8))
    static let accentSheen = dyn(hex(0xA9A4AE), hex(0xFFFFFF))
    static let accentSoft = dyn(rgba(52, 50, 58, 0.55), rgba(239, 230, 216, 0.55))
    static let text1 = dyn(hex(0x1C1C20), hex(0xF4F4F6))
    static let text2 = dyn(hex(0x45454D), hex(0xC9C9D1))
    static let text3 = dyn(hex(0x66666F), hex(0xA0A0AA))
    static let text4 = dyn(hex(0x8C8C95), hex(0x7A7A85))
    static let hair = dyn(rgba(28, 28, 40, 0.09), rgba(255, 255, 255, 0.08))
    static let hairStrong = dyn(rgba(28, 28, 40, 0.14), rgba(255, 255, 255, 0.13))
    static let glass = dyn(rgba(246, 246, 249, 0.72), rgba(30, 30, 36, 0.64))
    /// tint laid over the vibrancy material: light keeps the old 0.72 × 0.55 wash; dark is the deep graphite --glass
    /// at 0.85 so the panel stays deep graphite on light desktops too (0.62 measured #3F3F41 over #E9E4DC)
    static let panelTint = dyn(rgba(246, 246, 249, 0.40), rgba(30, 30, 36, 0.85))
    static let glassEdge = dyn(rgba(255, 255, 255, 0.70), rgba(255, 255, 255, 0.14))
    static let glassRim = dyn(rgba(20, 20, 40, 0.14), rgba(0, 0, 0, 0.55))
    static let card = dyn(rgba(255, 255, 255, 0.58), rgba(255, 255, 255, 0.055))
    static let cardEdge = dyn(rgba(255, 255, 255, 0.85), rgba(255, 255, 255, 0.08))
    static let chip = dyn(rgba(28, 28, 40, 0.055), rgba(255, 255, 255, 0.08))
    static let chipEdge = dyn(rgba(28, 28, 40, 0.08), rgba(255, 255, 255, 0.07))
    static let sel = dyn(rgba(28, 28, 40, 0.065), rgba(255, 255, 255, 0.085))
    static let track = dyn(rgba(28, 28, 40, 0.08), rgba(255, 255, 255, 0.10))
    static let fill = dyn(hex(0x2A2A30), hex(0xECECF0))
    static let onFill = dyn(hex(0xFAFAFC), hex(0x1C1C20))
    static let focusRing = dyn(rgba(28, 28, 40, 0.16), rgba(255, 255, 255, 0.20))
    static let danger = dyn(hex(0xC02A1F), hex(0xFF6B5E))
    static let skeleton = dyn(rgba(28, 28, 40, 0.07), rgba(255, 255, 255, 0.08))
    static let kbd = dyn(rgba(255, 255, 255, 0.75), rgba(255, 255, 255, 0.10))
    static let kbdEdge = dyn(rgba(28, 28, 40, 0.13), rgba(255, 255, 255, 0.14))
    static let kbdOnFill = dyn(rgba(255, 255, 255, 0.16), rgba(0, 0, 0, 0.10))

    // tile / favicon colors (prototype .tile.dash, .fav.site, .fav.claude)
    static let dashTop = dyn(hex(0x3A4256), hex(0x5B6788))
    static let dashBottom = dyn(hex(0x1E2230), hex(0x333B55))
    static let siteTop = dyn(hex(0x2E6B57), hex(0x2E6B57))
    static let siteBottom = dyn(hex(0x1C4A3B), hex(0x1C4A3B))
    static let siteInk = dyn(hex(0xF5EFE6), hex(0xF5EFE6))
    static let claudeInk = dyn(hex(0xA4552F), hex(0xF0A07A))
    static let claudeBg = dyn(hex(0xF3E7DC), hex(0x3A2A22))

    // radii (concentric)
    static let rPanel: CGFloat = 26
    static let rCard: CGFloat = 16
    static let rRow: CGFloat = 12
    static let rTile: CGFloat = 10
    static let rChip: CGFloat = 8
    static let rKbd: CGFloat = 5

    static let panelWidth: CGFloat = 660
}

extension Font {
    /// System UI font (SF Pro / PingFang SC fall back automatically).
    static func ui(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font { .system(size: size, weight: weight) }
    /// SF Mono, for addresses and sizes.
    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font { .system(size: size, weight: weight, design: .monospaced) }
}
