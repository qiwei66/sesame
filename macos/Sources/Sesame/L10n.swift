import Foundation
import SesameCore

/// Localized UI chrome. Strings live in Resources/{en,zh-Hans}.lproj/Localizable.strings (copied into the
/// .app by scripts/build-app.sh). The language follows the system unless Settings > Language overrides it.
enum L10n {
    static let languageKey = "uiLanguage"   // "auto" | "zh-Hans" | "en"

    /// Set by `--lang` in demo mode; wins over the setting.
    nonisolated(unsafe) static var forced: String?

    static var language: String {
        if let f = forced { return f }
        let s = UserDefaults.standard.string(forKey: languageKey) ?? "auto"
        if s != "auto" { return s }
        let pref = Bundle.main.preferredLocalizations.first ?? Locale.preferredLanguages.first ?? "en"
        return pref.hasPrefix("zh") ? "zh-Hans" : "en"
    }

    private static var bundle: Bundle {
        if let p = Bundle.main.path(forResource: language, ofType: "lproj"), let b = Bundle(path: p) { return b }
        return Bundle.main
    }

    static func t(_ key: String) -> String {
        let v = bundle.localizedString(forKey: key, value: nil, table: nil)
        if v != key { return v }
        // running outside the .app (swift run): fall back to the English text kept in code
        return fallback[key] ?? key
    }

    static func f(_ key: String, _ args: CVarArg...) -> String {
        String(format: t(key), locale: Locale(identifier: language), arguments: args)
    }

    static func verb(_ v: Verb) -> String {
        switch v {
        case .open: return t("verb.open")
        case .query: return t("verb.query")
        case .trash: return t("verb.trash")
        case .search: return t("verb.search")
        case .run: return t("verb.run")
        }
    }

    static func chip(_ c: ChipKind) -> String {
        switch c {
        case .local: return t("kind.local")
        case .web: return t("kind.web")
        case .artifact: return t("kind.artifact")
        case .file: return t("kind.file")
        case .system: return t("kind.system")
        case .app: return t("kind.app")
        case .candidates(let n): return f("kind.candidates", n)
        case .results(let n): return f("kind.results", n)
        case .files(let n): return f("kind.files", n)
        }
    }

    static let fallback: [String: String] = [
        "verb.open": "Open", "verb.query": "Check", "verb.trash": "Move to Trash", "verb.search": "Search", "verb.run": "Run",
        "kind.local": "Local service", "kind.web": "Web page", "kind.artifact": "Claude page", "kind.file": "File",
        "kind.system": "System info", "kind.app": "App", "kind.candidates": "%d candidates", "kind.results": "%d results", "kind.files": "%d files",
        "done.opened": "Opened", "listening": "Listening", "placeholder": "Type a sentence, or hold %@ to talk",
        "miss.done": "Already did", "miss.need": "Need from you",
        "confirm.cancel": "Cancel", "confirm.trash": "Move to Trash", "confirm.more": "%d more",
        "info.remaining": "left",
        "menu.recent": "Recent", "menu.index": "Index", "menu.settings": "Settings…", "menu.quit": "Quit Sesame",
        "menu.empty": "Nothing yet", "menu.indexUnknown": "Index status unavailable",
        "menu.reconnect": "Reconnect", "menu.indexUnavailable": "Unavailable",
        "err.timeout": "No answer this time", "err.restarting": "Sesame's core just restarted", "err.generic": "That did not work",
        "err.again": "Say it again",
    ]
}
