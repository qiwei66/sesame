import Foundation

/// Finds the `va` executable that `va serve --stdio` is run from. Nothing is hard-coded to a user's home:
///  1. env `SESAME_CORE` (path to `va`)
///  2. the user setting (UserDefaults key `corePath`, editable in Settings)
///  3. `<home>/.local/share/sesame/core/bin/va` (where `make install` puts the core), home from the OS
///  4. `<home>/.voice-agent/bin/va` (a plain git checkout of the core)
///  5. `va` on PATH, then Homebrew's bin directories
public enum CoreLocator {
    public static let envKey = "SESAME_CORE"
    public static let defaultsKey = "corePath"
    /// Relative to home; keep in sync with CORE_DIR in the top-level Makefile.
    public static let installedCoreRelative = ".local/share/sesame/core"

    public static func resolve(env: [String: String], setting: String?, home: URL, isExecutable: (String) -> Bool) -> String? {
        var candidates: [String] = []
        if let e = env[envKey], !e.isEmpty { candidates.append(expand(e, home: home)) }
        if let s = setting, !s.isEmpty { candidates.append(expand(s, home: home)) }
        candidates.append(home.appendingPathComponent(installedCoreRelative + "/bin/va").path)
        candidates.append(home.appendingPathComponent(".voice-agent/bin/va").path)
        for dir in (env["PATH"] ?? "").split(separator: ":") { candidates.append(String(dir) + "/va") }
        // apps started from Finder get a short PATH: also look where Homebrew links binaries
        candidates.append(contentsOf: ["/opt/homebrew/bin/va", "/usr/local/bin/va"])
        return candidates.first(where: isExecutable)
    }

    public static func expand(_ p: String, home: URL) -> String {
        if p == "~" { return home.path }
        if p.hasPrefix("~/") { return home.appendingPathComponent(String(p.dropFirst(2))).path }
        return p
    }

    public static func command(for va: String) -> [String] { [va, "serve", "--stdio"] }
}
