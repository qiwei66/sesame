import Foundation
import ServiceManagement

/// "Open Sesame at login" via SMAppService.mainApp (macOS 13+): no helper app, no launchd plist written by us.
/// On by default: the first real launch registers once; afterwards only the Settings switch changes it.
enum LoginItem {
    #if SESAME_TEST_HOOKS
    /// test builds (`--fake-login on|off`): never touch the real login items of this Mac
    nonisolated(unsafe) static var fake: Bool?
    #endif

    static var isEnabled: Bool {
        #if SESAME_TEST_HOOKS
        if let f = fake { return f }
        #endif
        return SMAppService.mainApp.status == .enabled
    }

    static var needsApproval: Bool {
        #if SESAME_TEST_HOOKS
        if fake != nil { return false }
        #endif
        return SMAppService.mainApp.status == .requiresApproval
    }

    /// `.requiresApproval` = registered, but the user switched it off in System Settings > General > Login Items
    static var statusText: String {
        switch SMAppService.mainApp.status {
        case .enabled: return "enabled"
        case .requiresApproval: return "requiresApproval"
        case .notRegistered: return "notRegistered"
        case .notFound: return "notFound"
        @unknown default: return "unknown"
        }
    }

    @discardableResult
    static func set(_ on: Bool) -> Bool {
        #if SESAME_TEST_HOOKS
        if fake != nil { fake = on; Log.write("[login] (fake) \(on ? "register" : "unregister")"); return true }
        #endif
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            Log.write("[login] \(on ? "register" : "unregister") ok status=\(statusText)")
            return true
        } catch {
            Log.write("[login] \(on ? "register" : "unregister") failed: \(error.localizedDescription) status=\(statusText)")
            return false
        }
    }

    /// First launch: default on, once.
    static func registerOnFirstLaunch() {
        guard !UserDefaults.standard.bool(forKey: Store.loginInitKey) else { return }
        UserDefaults.standard.set(true, forKey: Store.loginInitKey)
        set(true)
    }
}
