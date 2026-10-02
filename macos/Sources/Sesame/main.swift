import AppKit
import SesameCore

// Sesame: menu-bar agent (LSUIElement, no Dock icon). See macos/README.md.
final class AppDelegate: NSObject, NSApplicationDelegate {
    var controller: AppController?

    func applicationDidFinishLaunching(_ n: Notification) {
        let args = CommandLine.arguments
        if args.contains("--dark") { NSApp.appearance = NSAppearance(named: .darkAqua) }
        if args.contains("--light") { NSApp.appearance = NSAppearance(named: .aqua) }
        if let i = args.firstIndex(of: "--lang"), i + 1 < args.count { L10n.forced = args[i + 1] }
        MainActor.assumeIsolated {
            // demo / screenshot / test-script runs never take the keyboard or activate the app (CLAUDE.md invariant 13)
            if args.contains("--demo") || args.contains("--test-script") { Presentation.passive = true }
            let c = AppController()
            controller = c
            Log.write("[app] launch \(Bundle.main.bundleIdentifier ?? "-") \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] ?? "-")")
            c.start(demo: DemoOptions.parse(args))
        }
    }

    func applicationWillTerminate(_ n: Notification) {
        MainActor.assumeIsolated { controller?.rpc?.stop() }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
