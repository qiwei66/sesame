import AppKit
import SwiftUI
import SesameCore

/// The "share my number" image (DESIGN.md「分享我的数字」): 1200 × 675, the app icon, one first-person sentence with
/// the number, the non-empty group counts, and the project addresses. Nothing else: no titles, paths or names.
/// Colors are fixed per theme (the image is rendered off screen, there is no window appearance to follow).
struct ShareCardView: View {
    var total: Int
    var groups: [IntroGroupKind: Int]
    var dark: Bool

    private var bg: Color { dark ? Color(red: 0x1E / 255, green: 0x1E / 255, blue: 0x24 / 255) : Color(red: 0xF6 / 255, green: 0xF5 / 255, blue: 0xF2 / 255) }
    private var ink: Color { dark ? Color(red: 0xF4 / 255, green: 0xF4 / 255, blue: 0xF6 / 255) : Color(red: 0x1C / 255, green: 0x1C / 255, blue: 0x20 / 255) }
    private var ink2: Color { dark ? Color(red: 0xC9 / 255, green: 0xC9 / 255, blue: 0xD1 / 255) : Color(red: 0x45 / 255, green: 0x45 / 255, blue: 0x4D / 255) }
    private var ink3: Color { dark ? Color(red: 0xA0 / 255, green: 0xA0 / 255, blue: 0xAA / 255) : Color(red: 0x66 / 255, green: 0x66 / 255, blue: 0x6F / 255) }
    /// --accent: graphite in light, ivory in dark (the icon's two colors)
    private var accent: Color { dark ? Color(red: 0xEF / 255, green: 0xE6 / 255, blue: 0xD8 / 255) : Color(red: 0x34 / 255, green: 0x32 / 255, blue: 0x3A / 255) }
    private var tile: Color { dark ? Color.white.opacity(0.06) : Color.white.opacity(0.75) }
    private var tileEdge: Color { dark ? Color.white.opacity(0.09) : Color(red: 28 / 255, green: 28 / 255, blue: 40 / 255).opacity(0.08) }

    var body: some View {
        let (a, b) = ShareCard.split(L10n.t("share.headline"))
        VStack(alignment: .leading, spacing: 0) {
            Image(nsImage: NSApp.applicationIconImage ?? NSImage())
                .resizable().interpolation(.high).frame(width: 112, height: 112)
                .padding(.leading, -10)   // the icon art has a transparent margin; line it up with the text
            Spacer(minLength: 0)
            (Text(a).foregroundColor(ink) + Text(IndexLine.count(total)).foregroundColor(accent) + Text(b).foregroundColor(ink))
                .font(.system(size: 64, weight: .semibold)).kerning(-1.6).monospacedDigit()
                .lineSpacing(6).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 1000, alignment: .leading)
            HStack(spacing: 10) {
                ForEach(ShareCard.groups(groups), id: \.self) { k in
                    HStack(spacing: 8) {
                        Image(systemName: IntroView.icon(k)).font(.system(size: 17)).foregroundColor(ink2)
                        Text(L10n.t("intro.group.\(k.rawValue)")).font(.system(size: 18)).foregroundColor(ink2)
                        Text(IndexLine.count(groups[k] ?? 0)).font(.system(size: 22, weight: .semibold)).monospacedDigit().foregroundColor(ink)
                    }
                    .lineLimit(1).fixedSize()
                    .padding(.horizontal, 13).frame(height: 52)
                    .background(RoundedRectangle(cornerRadius: 14).fill(tile))
                    .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(tileEdge, lineWidth: 1))
                }
            }
            .padding(.top, 40)
            Spacer(minLength: 0)
            HStack(spacing: 14) {
                Text("Sesame").font(.system(size: 22, weight: .semibold)).foregroundColor(ink)
                Text(ShareCard.footer).font(.system(size: 20, design: .monospaced)).foregroundColor(ink3)
            }
        }
        .padding(EdgeInsets(top: 72, leading: 88, bottom: 64, trailing: 88))
        .frame(width: CGFloat(ShareCard.width), height: CGFloat(ShareCard.height), alignment: .topLeading)
        .background(bg)
    }

    /// PNG bytes at exactly 1200 × 675 pixels
    @MainActor
    static func png(total: Int, groups: [IntroGroupKind: Int], dark: Bool) -> Data? {
        let r = ImageRenderer(content: ShareCardView(total: total, groups: groups, dark: dark))
        r.scale = 1
        guard let cg = r.cgImage else { return nil }
        let rep = NSBitmapImageRep(cgImage: cg)
        rep.size = NSSize(width: ShareCard.width, height: ShareCard.height)
        return rep.representation(using: .png, properties: [:])
    }
}

@MainActor
enum ShareExport {
    /// Where the image goes, and whether Finder / clipboard are skipped (test builds only)
    static func target() -> (URL, Bool) {
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads")
        #if SESAME_TEST_HOOKS
        let env = ProcessInfo.processInfo.environment
        let dir = env["SESAME_SHARE_DIR"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0, isDirectory: true) } ?? downloads
        return (dir, env["SESAME_SHARE_DRY"] == "1")
        #else
        return (downloads, false)
        #endif
    }

    /// Save to Downloads, select it in Finder, copy it. Test builds can send it elsewhere and skip Finder / clipboard
    /// (SESAME_SHARE_DIR, SESAME_SHARE_DRY=1) so a test never takes over the user's Finder window or clipboard.
    static func run(total: Int, groups: [IntroGroupKind: Int], dark: Bool) -> URL? {
        guard let data = ShareCardView.png(total: total, groups: groups, dark: dark) else { Log.write("[share] render failed"); return nil }
        let (dir, dry) = target()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(ShareCard.fileName())
        do { try data.write(to: url) } catch { Log.write("[share] write failed: \(error.localizedDescription)"); return nil }
        if dry {
            Log.write("[share] saved \(url.lastPathComponent) bytes=\(data.count) (test: Finder reveal + clipboard skipped)")
            return url
        }
        NSWorkspace.shared.activateFileViewerSelecting([url])
        let pb = NSPasteboard.general
        pb.clearContents()
        if let img = NSImage(data: data) { pb.writeObjects([img]) }
        pb.setData(data, forType: .png)
        Log.write("[share] saved \(url.lastPathComponent) bytes=\(data.count), revealed in Finder, copied")
        return url
    }
}
