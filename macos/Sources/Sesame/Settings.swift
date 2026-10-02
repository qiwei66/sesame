import AppKit
import SwiftUI
import SesameCore

@MainActor
final class SettingsWindowController: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    private weak var app: AppController?

    init(app: AppController) { self.app = app }

    func show() {
        if window == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 460), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            w.title = L10n.t("settings.title")
            w.isReleasedWhenClosed = false
            w.contentView = NSHostingView(rootView: SettingsView(app: app))
            w.center()
            w.delegate = self
            window = w
        }
        guard let window else { return }
        Presentation.show(window, activateApp: { NSApp.activate(ignoringOtherApps: true) })
    }

    var windowNumber: Int { window?.windowNumber ?? 0 }
    func close() { window?.close() }
}

struct SettingsView: View {
    weak var app: AppController?
    var body: some View {
        TabView {
            GeneralTab(app: app).tabItem { Text(L10n.t("settings.general")) }
            ModelTab().tabItem { Text(L10n.t("settings.model")) }
            UsageTab().tabItem { Text(L10n.t("settings.usage")) }
        }
        .padding(20)
        .frame(width: 560, height: 460)
    }
}

struct GeneralTab: View {
    weak var app: AppController?
    @State private var hotKey = Store.hotKey
    @State private var recording = false
    @State private var message = ""
    @State private var monitor: Any?
    @AppStorage(L10n.languageKey) private var language = "auto"
    @AppStorage(Store.previewKey) private var preview = false
    @AppStorage(CoreLocator.defaultsKey) private var corePath = ""

    @State private var login = LoginItem.isEnabled
    @State private var loginApproval = LoginItem.needsApproval

    var body: some View {
        Form {
            Section {
                Toggle(isOn: Binding(get: { login }, set: { on in
                    LoginItem.set(on)
                    login = LoginItem.isEnabled
                    loginApproval = LoginItem.needsApproval
                })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(L10n.t("settings.login")).font(.system(size: 13.5, weight: .medium))
                        Text(loginApproval ? L10n.t("settings.loginApproval") : L10n.f("settings.loginHint", Store.hotKey.displayString))
                            .font(.system(size: 12)).foregroundColor(.secondary)
                    }
                }
                .toggleStyle(.switch)
                .tint(Tok.accent)   // design: the switch is on in the brand graphite / ivory, not system blue
                .accessibilityIdentifier("sesame.login")
            }
            Section {
            LabeledContent(L10n.t("settings.hotkey")) {
                HStack {
                    Text(recording ? L10n.t("settings.recording") : hotKey.displayString)
                        .font(.system(size: 13, weight: .medium)).frame(minWidth: 120, alignment: .leading)
                    Button(L10n.t("settings.record")) { startRecording() }.disabled(recording)
                    Button(L10n.t("settings.reset")) { apply(nil) }.disabled(!(app?.hotKeyChoice.isCustom ?? false))
                }
            }
            HStack(alignment: .firstTextBaseline) {
                Text(message.isEmpty ? hotKeyNote : message).font(.system(size: 12)).foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if message.isEmpty, let c = app?.hotKeyChoice, c.canTakeOver {
                    Spacer()
                    Button(L10n.f("settings.takeover", HotKeySpec.commandSpace.displayString)) { app?.beginTakeoverFromSettings() }
                }
            }
            Picker(L10n.t("settings.language"), selection: $language) {
                Text(L10n.t("settings.language.auto")).tag("auto")
                Text("简体中文").tag("zh-Hans")
                Text("English").tag("en")
            }
            Toggle(L10n.t("settings.preview"), isOn: $preview)
            LabeledContent(L10n.t("settings.core")) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        TextField("", text: $corePath, prompt: Text("~/.local/share/sesame/core/bin/va")).textFieldStyle(.roundedBorder)
                        Button(L10n.t("settings.restartCore")) { app?.startCore() }
                    }
                    Text(L10n.t("settings.coreHint")).font(.system(size: 11)).foregroundColor(.secondary)
                }
            }
            }
        }
        .formStyle(.grouped)
        .onAppear {
            login = LoginItem.isEnabled; loginApproval = LoginItem.needsApproval
            app?.refreshHotKeyIfChanged()
            hotKey = Store.hotKey
        }
        .onDisappear { stopRecording() }
    }

    private func startRecording() {
        recording = true
        message = ""
        // local monitor: only sees keys sent to this Settings window, needs no permission
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
            let spec = HotKeySpec(keyCode: UInt32(e.keyCode), modifiers: HotKey.carbonModifiers(e.modifierFlags.rawValue))
            if e.keyCode == 53 && spec.modifiers == 0 { stopRecording(); return nil }  // esc cancels
            switch spec.rejection {
            case .needsModifier: message = L10n.t("settings.hotkeyNeedsModifier")
            case nil: apply(spec); stopRecording()
            }
            return nil
        }
    }

    private func stopRecording() {
        recording = false
        if let m = monitor { NSEvent.removeMonitor(m); monitor = nil }
    }

    /// nil = automatic (⌘Space when free, else the backup key). A recorded key that another app or the system
    /// already uses is not kept.
    private func apply(_ spec: HotKeySpec?) {
        let old = Store.customHotKey
        Store.customHotKey = spec
        let st = app?.reregisterHotKey() ?? noErr
        if spec != nil, st != noErr || (app?.hotKeyTaken ?? false) {
            Store.customHotKey = old
            _ = app?.reregisterHotKey()
            message = L10n.t("settings.hotkeyInUse")
        } else {
            message = ""
        }
        hotKey = Store.hotKey
    }

    /// One line under the key: automatic or not, and who holds ⌘Space when the backup key is in use.
    private var hotKeyNote: String {
        let c = app?.hotKeyChoice ?? HotKeyChoice(active: Store.hotKey, isCustom: false, blockedBy: nil)
        let cmd = HotKeySpec.commandSpace.displayString
        if c.isCustom { return L10n.f("settings.hotkeyCustom", cmd) }
        // ⌘Space is opt-in: until the user takes it over, Sesame stays on the backup key
        if Store.commandSpaceChoice != true { return L10n.f("settings.hotkeyDefault", c.active.displayString, cmd) }
        if let h = c.blockedBy { return L10n.f("settings.hotkeyBlocked", cmd, h.appName == "Spotlight" ? L10n.t("settings.spotlightName") : h.appName, c.active.displayString) }
        return L10n.f("settings.hotkeyAuto", cmd, HotKeySpec.fallback.displayString)
    }
}

/// v0.1: a draft form. The core owns model settings (config.yaml, docs/config.md); this tab produces the
/// block to paste there. Keys are never stored by the app, only where to find them.
struct ModelTab: View {
    @AppStorage("draft.provider") private var provider = "deepseek"
    @AppStorage("draft.baseURL") private var baseURL = "https://api.deepseek.com"
    @AppStorage("draft.model") private var model = "deepseek-chat"
    @AppStorage("draft.keyKind") private var keyKind = "env"
    @AppStorage("draft.keyRef") private var keyRef = "DEEPSEEK_API_KEY"

    var body: some View {
        Form {
            TextField(L10n.t("settings.provider"), text: $provider)
            TextField(L10n.t("settings.baseURL"), text: $baseURL)
            TextField(L10n.t("settings.modelName"), text: $model)
            Picker(L10n.t("settings.keySource"), selection: $keyKind) {
                Text(L10n.t("settings.keySource.env")).tag("env")
                Text(L10n.t("settings.keySource.keychain")).tag("keychain")
                Text(L10n.t("settings.keySource.file")).tag("file")
            }
            TextField(L10n.t("settings.keyRef"), text: $keyRef)
            Text(L10n.t("settings.modelHint")).font(.system(size: 12)).foregroundColor(.secondary)
            HStack(alignment: .top) {
                Text(yaml).font(.system(size: 11.5, design: .monospaced)).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button(L10n.t("settings.copy")) {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(yaml, forType: .string)
                }
            }
        }
    }

    private var yaml: String {
        let key: String
        switch keyKind {
        case "keychain": key = "      - keychain: { service: \(keyRef) }"
        case "file": key = "      - file: \(keyRef)"
        default: key = "      - env: \(keyRef)"
        }
        return "provider: \(provider)\nproviders:\n  \(provider):\n    base_url: \(baseURL)\n    model: \(model)\n    key:\n\(key)"
    }
}

/// The only place that shows usage or cost.
struct UsageTab: View {
    @State private var usage = Store.usage
    var body: some View {
        Form {
            LabeledContent(L10n.t("settings.usage.month"), value: usage.month)
            LabeledContent(L10n.t("settings.usage.requests"), value: "\(usage.requests)")
            LabeledContent(L10n.t("settings.usage.cached"), value: "\(usage.cacheHits)")
            LabeledContent(L10n.t("settings.usage.tokens"), value: "\(usage.tokens)")
            LabeledContent(L10n.t("settings.usage.cost"), value: usage.currency.isEmpty ? "-" : String(format: "%@%.4f", usage.currency, usage.amount))
            Text(L10n.t("settings.usage.note")).font(.system(size: 11)).foregroundColor(.secondary)
            Button(L10n.t("settings.usage.reset")) { Store.usage = Store.Usage(month: Store.monthKey()); usage = Store.usage }
        }
        .onAppear { usage = Store.usage }
    }
}
