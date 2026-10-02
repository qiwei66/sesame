import AppKit
import Carbon.HIToolbox
import Foundation
import SesameCore

/// Global hot key via Carbon `RegisterEventHotKey`: a public API that needs no Accessibility or
/// Input Monitoring permission (it does not observe other keystrokes, it only reserves one combination).
/// Both edges are delivered: press and release (push-to-talk = hold longer than 300 ms).
final class HotKey {
    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private let onPress: () -> Void
    private let onRelease: () -> Void
    private static let signature: OSType = 0x5345534D // 'SESM'

    init(onPress: @escaping () -> Void, onRelease: @escaping () -> Void = {}) {
        self.onPress = onPress
        self.onRelease = onRelease
    }

    deinit { unregister() }

    /// Returns the Carbon status (noErr = 0). eventHotKeyExistsErr (-9878) = taken by another app.
    @discardableResult
    func register(_ spec: HotKeySpec) -> OSStatus {
        unregister()
        if spec.rejection != nil { return OSStatus(paramErr) }
        if handler == nil {
            var types = [EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
                         EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased))]
            let me = Unmanaged.passUnretained(self).toOpaque()
            let st = InstallEventHandler(GetApplicationEventTarget(), { _, ev, ud in
                guard let ud, let ev else { return noErr }
                let hk = Unmanaged<HotKey>.fromOpaque(ud).takeUnretainedValue()
                let released = GetEventKind(ev) == UInt32(kEventHotKeyReleased)
                DispatchQueue.main.async { released ? hk.onRelease() : hk.onPress() }
                return noErr
            }, 2, &types, me, &handler)
            if st != noErr { return st }
        }
        let id = EventHotKeyID(signature: HotKey.signature, id: 1)
        return RegisterEventHotKey(spec.keyCode, spec.modifiers, id, GetApplicationEventTarget(), 0, &ref)
    }

    func unregister() {
        if let r = ref { UnregisterEventHotKey(r); ref = nil }
    }

    /// Is this combination one of the system's own enabled shortcuts (Spotlight, input source switching…)?
    /// `CopySymbolicHotKeys` lists them; other apps' Carbon hot keys show up as a failed `register` instead.
    static func takenBySystem(_ spec: HotKeySpec) -> Bool {
        var arr: Unmanaged<CFArray>?
        guard CopySymbolicHotKeys(&arr) == noErr, let list = arr?.takeRetainedValue() as? [[String: Any]] else { return false }
        for h in list {
            let enabled = (h[kHISymbolicHotKeyEnabled as String] as? Bool) ?? false
            let code = (h[kHISymbolicHotKeyCode as String] as? Int) ?? -1
            let mods = (h[kHISymbolicHotKeyModifiers as String] as? Int) ?? -1
            if enabled && code == Int(spec.keyCode) && UInt32(mods) & (HotKeySpec.cmd | HotKeySpec.shift | HotKeySpec.option | HotKeySpec.control) == spec.modifiers { return true }
        }
        return false
    }

    /// Carbon gives no way to see other apps' hot keys (two apps can register the same one and both succeed: checked
    /// 2026-10-02 against a running Sesame). So: ChatGPT for Mac (`com.openai.chat`) and the Codex app (`com.openai.codex`,
    /// whose pet / mini window takes ⌥Space and cannot be turned off) count for ⌥Space when running; Alfred and Raycast
    /// count only when running AND their saved hot key really is this one.
    static let optionSpaceApps = ["com.openai.chat", "com.openai.codex"]
    static let alfredId = "com.runningwithcrayons.Alfred"
    static let raycastId = "com.raycast.macos"

    static func takenByKnownApp(_ spec: HotKeySpec, alfredPrefs: () -> [HotKeySpec] = alfredHotKeys) -> String? {
        let me = Bundle.main.bundleIdentifier ?? ""
        let mine = ProcessInfo.processInfo.processIdentifier
        for app in NSWorkspace.shared.runningApplications where app.processIdentifier != mine {
            guard let id = app.bundleIdentifier else { continue }
            if id.hasPrefix("io.github.sesame") && id != me { continue }   // a test build next to the real one: not a conflict for users
            if id == me { return id }
            if spec == .optionSpace && optionSpaceApps.contains(id) { return id }
            if id == alfredId && alfredPrefs().contains(spec) { return id }
            if id == raycastId && raycastHotKey() == spec { return id }
        }
        return nil
    }

    // MARK: who holds ⌘Space (read only: Sesame never writes these settings)

    /// Spotlight's ⌘Space shortcut is on (`com.apple.symbolichotkeys`, entry 64). Re-read from cfprefsd every call, so a
    /// change made in System Settings a moment ago is seen.
    static func spotlightHoldsCommandSpace() -> Bool {
        let domain = "com.apple.symbolichotkeys" as CFString
        CFPreferencesAppSynchronize(domain)
        let v = CFPreferencesCopyAppValue("AppleSymbolicHotKeys" as CFString, domain) as? [String: Any]
        return SymbolicHotKeys.commandSpaceEnabled(v)
    }

    /// Raycast's saved hot key (nil = Raycast's setting cannot be parsed).
    static func raycastHotKey() -> HotKeySpec? {
        let domain = RaycastHotKey.defaultsDomain as CFString
        CFPreferencesAppSynchronize(domain)
        return RaycastHotKey.parse(CFPreferencesCopyAppValue(RaycastHotKey.defaultsKey as CFString, domain) as? String)
    }

    static func installed(_ bundleId: String) -> Bool { NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) != nil }

    /// A launcher installed on this Mac whose saved hot key is ⌘Space. Running or not: a launcher that starts at login
    /// after Sesame would get the same key and both would fire.
    static func launcherOnCommandSpace() -> CommandSpaceHolder? {
        if installed(alfredId) && alfredHotKeys().contains(.commandSpace) { return .alfred }
        if installed(raycastId) && raycastHotKey() == .commandSpace { return .raycast }
        return nil
    }

    /// The key to use right now: the one recorded in Settings, else ⌘Space when free, else the backup key.
    static func currentChoice() -> HotKeyChoice {
        let custom = Store.customHotKey
        if custom != nil { return HotKeyPlan.choose(custom: custom, commandSpace: false, spotlightOn: false, launcher: nil) }
        let spotlight = spotlightHoldsCommandSpace()
        let launcher = launcherOnCommandSpace()
        // upgrading from a build that took a free ⌘Space by itself: whoever is on it keeps it (decided once, then stored)
        if Store.commandSpaceChoice == nil {
            let existing = Store.introShown || Store.takeoverAsked
            let keep = HotKeyPlan.wantsCommandSpace(stored: nil, existingUser: existing, commandSpaceFree: !spotlight && launcher == nil)
            if existing { Store.commandSpaceChoice = keep; Log.write("[hotkey] upgrade: keep ⌘Space=\(keep)") }
        }
        return HotKeyPlan.choose(custom: nil, commandSpace: Store.commandSpaceChoice ?? false, spotlightOn: spotlight, launcher: launcher)
    }

    /// Alfred's configured hot key(s): its preferences folder (default, or the sync folder it was moved to).
    static func alfredHotKeys() -> [HotKeySpec] {
        let fm = FileManager.default
        var roots = [fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Alfred/Alfred.alfredpreferences")]
        if let sync = UserDefaults(suiteName: "com.runningwithcrayons.Alfred-Preferences")?.string(forKey: "syncfolder") {
            roots.insert(URL(fileURLWithPath: (sync as NSString).expandingTildeInPath).appendingPathComponent("Alfred.alfredpreferences"), at: 0)
        }
        var out: [HotKeySpec] = []
        for r in roots {
            let local = r.appendingPathComponent("preferences/local")
            for h in (try? fm.contentsOfDirectory(atPath: local.path)) ?? [] {
                let f = local.appendingPathComponent(h).appendingPathComponent("hotkey/prefs.plist")
                if let d = NSDictionary(contentsOf: f) as? [String: Any], let s = AlfredHotKey.parse(d) { out.append(s) }
            }
            if !out.isEmpty { break }
        }
        return out
    }

    /// Taken = the register call failed, it is an enabled system shortcut, or a running app is known to use it.
    static func isTaken(_ spec: HotKeySpec, registerStatus: OSStatus) -> Bool {
        if registerStatus != noErr { return true }
        if takenBySystem(spec) { return true }
        if let id = takenByKnownApp(spec) { Log.write("[hotkey] \(spec.displayString) is likely used by \(id)"); return true }
        return false
    }

    /// NSEvent modifier flags -> Carbon mask (for the Settings recorder).
    static func carbonModifiers(_ flags: UInt) -> UInt32 {
        var m: UInt32 = 0
        if flags & (1 << 20) != 0 { m |= HotKeySpec.cmd }      // NSEvent.ModifierFlags.command
        if flags & (1 << 17) != 0 { m |= HotKeySpec.shift }    // .shift
        if flags & (1 << 19) != 0 { m |= HotKeySpec.option }   // .option
        if flags & (1 << 18) != 0 { m |= HotKeySpec.control }  // .control
        return m
    }
}
