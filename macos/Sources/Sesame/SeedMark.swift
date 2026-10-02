import AppKit
import SwiftUI

/// The Sesame mark: the v3 seed silhouette with its ridge cut out.
/// Same path as design/logo/final/menubar.svg (18x18 viewBox, rotate(-18 9 9), even-odd).
enum SeedPath {
    static let svg = "M9.00,0.70 C9.53,1.53 13.45,5.68 13.45,10.99 C13.45,14.31 11.49,17.30 9.00,17.30 C6.51,17.30 4.55,14.31 4.55,10.99 C4.55,5.68 8.47,1.53 9.00,0.70 Z M9.00,4.02 C9.60,7.09 9.60,10.16 9.54,10.16 C9.54,13.05 9.18,14.98 9.00,14.98 C8.82,14.98 8.46,13.05 8.46,10.16 C8.40,10.16 8.40,7.09 9.00,4.02 Z"

    /// Minimal parser for absolute M / C / Z (all the mark uses). Calls the sinks in SVG coordinates (y down).
    static func walk(_ moveTo: (CGPoint) -> Void, _ curveTo: (CGPoint, CGPoint, CGPoint) -> Void, _ close: () -> Void) {
        var cmd: Character = "M"
        var nums: [CGFloat] = []
        func flush() {
            switch cmd {
            case "M" where nums.count >= 2: moveTo(CGPoint(x: nums[0], y: nums[1]))
            case "C" where nums.count >= 6:
                curveTo(CGPoint(x: nums[0], y: nums[1]), CGPoint(x: nums[2], y: nums[3]), CGPoint(x: nums[4], y: nums[5]))
            default: break
            }
            nums = []
        }
        var cur = ""
        func endNumber() { if let v = Double(cur) { nums.append(CGFloat(v)) }; cur = "" }
        for ch in svg {
            if ch == "M" || ch == "C" || ch == "Z" {
                endNumber(); flush(); cmd = ch
                if ch == "Z" { close() }
            } else if ch == " " || ch == "," {
                endNumber()
            } else {
                cur.append(ch)
            }
        }
        endNumber(); flush()
    }

    static func cgPath(in rect: CGRect, flipY: Bool) -> CGPath {
        let p = CGMutablePath()
        let s = min(rect.width, rect.height) / 18
        var t = CGAffineTransform.identity
        t = t.translatedBy(x: rect.minX + (rect.width - 18 * s) / 2, y: rect.minY + (rect.height - 18 * s) / 2)
        if flipY { t = t.translatedBy(x: 0, y: 18 * s).scaledBy(x: 1, y: -1) }
        t = t.scaledBy(x: s, y: s)
        // rotate(-18 9 9)
        t = t.translatedBy(x: 9, y: 9).rotated(by: -18 * .pi / 180).translatedBy(x: -9, y: -9)
        walk({ p.move(to: $0, transform: t) }, { p.addCurve(to: $2, control1: $0, control2: $1, transform: t) }, { p.closeSubpath() })
        return p
    }

    /// Template image for the status item (black + alpha, macOS tints it).
    static func templateImage(size: CGFloat = 18) -> NSImage {
        let img = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            ctx.addPath(cgPath(in: rect, flipY: true))
            ctx.setFillColor(NSColor.black.cgColor)
            ctx.fillPath(using: .evenOdd)
            return true
        }
        img.isTemplate = true
        img.accessibilityDescription = "Sesame"
        return img
    }
}

struct SeedShape: Shape {
    func path(in rect: CGRect) -> Path { Path(SeedPath.cgPath(in: rect, flipY: false)) }
}

/// Animatable sheen position/opacity: translateX -12 -> 14 (18pt units), opacity keyframes 0 -> .9 (25%) -> 0.
private struct SheenModifier: AnimatableModifier {
    var progress: CGFloat
    var animatableData: CGFloat { get { progress } set { progress = newValue } }
    func body(content: Content) -> some View {
        let op: Double = progress >= 1 || progress <= 0 ? 0 : (progress < 0.25 ? Double(progress / 0.25) * 0.9 : Double((1 - progress) / 0.75) * 0.9)
        return content.offset(x: (-12 + 26 * progress) * 22 / 18).opacity(op)
    }
}

/// 22pt mark with the one-time sheen (900ms, cubic-bezier(.65,0,.35,1), 120ms delay) each time `shineToken` changes.
struct SeedMarkView: View {
    var shineToken: Int
    var animate: Bool
    var size: CGFloat = 22
    @State private var progress: CGFloat = 1

    var body: some View {
        ZStack {
            Rectangle().fill(Tok.accent)
            Rectangle()
                .fill(Tok.accentSheen)
                .frame(width: 5 * size / 18, height: 26 * size / 18)
                .transformEffect(CGAffineTransform(a: 1, b: 0, c: tan(-18 * .pi / 180), d: 1, tx: 0, ty: 0))
                .modifier(SheenModifier(progress: progress))
        }
        .frame(width: size, height: size)
        .mask(SeedShape().fill(style: FillStyle(eoFill: true)))
        .onChange(of: shineToken) { _ in run() }
        .onAppear { run() }
        .accessibilityHidden(true)
    }

    private func run() {
        guard animate else { progress = 1; return }
        var t = Transaction(); t.disablesAnimations = true
        withTransaction(t) { progress = 0 }
        DispatchQueue.main.async {
            withAnimation(.timingCurve(0.65, 0, 0.35, 1, duration: 0.9).delay(0.12)) { progress = 1 }
        }
    }
}
