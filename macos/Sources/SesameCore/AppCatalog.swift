import Foundation

/// The installed-app list for the live list: scanned once at launch on a background queue, kept in memory, and
/// rescanned (debounced) when one of the app folders changes, so a new or removed app shows up without a relaunch.
/// Typing only reads `records` (a copy under a lock); it never touches the disk.
///
/// Names per bundle: the file name, Info.plist CFBundleDisplayName / CFBundleName, the localized names in
/// `<lang>.lproj/InfoPlist.strings` and `InfoPlist.loctable` (newer system apps), and the name Finder shows.
/// Bundles are re-read only when their modification date changed.
public final class AppCatalog: @unchecked Sendable {
    /// Where apps live (WO-20261003-040). `~` = the user's home.
    public static let defaultFolders = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities",
                                        "~/Applications", "/System/Library/CoreServices/Applications"]
    /// Localizations read besides the user's own (Chinese and English names both match)
    static let localizations = ["zh-Hans", "zh_CN", "zh-Hant", "zh_TW", "zh_HK", "en", "Base", "English"]

    private let folders: [String]
    private let queue = DispatchQueue(label: "sesame.apps", qos: .utility)
    private let lock = NSLock()
    private var current: [AppRecord] = []
    private var bundleCache: [String: (mtime: Date, record: AppRecord)] = [:]
    private var sources: [DispatchSourceFileSystemObject] = []
    private var pending: DispatchWorkItem?
    private var scans = 0
    /// called on the catalog's queue after every scan (tests, logging)
    public var onScan: (@Sendable (_ count: Int, _ ms: Int) -> Void)?

    public init(folders: [String] = AppCatalog.defaultFolders, home: String = NSHomeDirectory()) {
        self.folders = folders.map { $0 == "~" ? home : $0.hasPrefix("~/") ? home + $0.dropFirst(1) : $0 }
    }

    deinit { for s in sources { s.cancel() } }

    public var records: [AppRecord] { lock.lock(); defer { lock.unlock() }; return current }
    public var scanCount: Int { lock.lock(); defer { lock.unlock() }; return scans }

    /// Scan now (in the background) and watch the folders from then on.
    public func start() {
        queue.async { [self] in
            scanNow()
            watch()
        }
    }

    /// Synchronous scan on the caller's thread (tests)
    public func scanNow() {
        let t0 = Date()
        var out: [AppRecord] = []
        var seenPaths = Set<String>(), seenNames = Set<String>()
        var cache: [String: (mtime: Date, record: AppRecord)] = [:]
        let fm = FileManager.default
        for dir in folders {
            guard let entries = try? fm.contentsOfDirectory(atPath: dir) else { continue }
            for f in entries.sorted() where f.hasSuffix(".app") && !f.hasPrefix(".") {
                let path = (dir as NSString).appendingPathComponent(f)
                let real = (path as NSString).resolvingSymlinksInPath
                guard seenPaths.insert(real).inserted else { continue }
                let mtime = ((try? fm.attributesOfItem(atPath: path))?[.modificationDate] as? Date) ?? .distantPast
                let rec: AppRecord
                if let c = bundleCache[path], c.mtime == mtime { rec = c.record } else { rec = AppCatalog.read(path) }
                cache[path] = (mtime, rec)
                // the same app in two folders (a copy in ~/Applications): show it once
                guard seenNames.insert(AppSearch.key(rec.displayName)).inserted else { continue }
                out.append(rec)
            }
        }
        bundleCache = cache
        lock.lock(); current = out; scans += 1; lock.unlock()
        onScan?(out.count, Int(Date().timeIntervalSince(t0) * 1000))
    }

    /// One bundle's names, from its files only
    public static func read(_ path: String) -> AppRecord {
        let file = ((path as NSString).lastPathComponent as NSString).deletingPathExtension
        var names: [String] = [file]
        func add(_ v: Any?) { if let s = (v as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty, !names.contains(s) { names.append(s) } }
        let contents = (path as NSString).appendingPathComponent("Contents")
        let info = NSDictionary(contentsOfFile: (contents as NSString).appendingPathComponent("Info.plist"))
        add(info?["CFBundleDisplayName"]); add(info?["CFBundleName"])
        let res = (contents as NSString).appendingPathComponent("Resources")
        for l in localizations {
            if let d = NSDictionary(contentsOfFile: "\(res)/\(l).lproj/InfoPlist.strings") { add(d["CFBundleDisplayName"]); add(d["CFBundleName"]) }
        }
        if let table = NSDictionary(contentsOfFile: "\(res)/InfoPlist.loctable") as? [String: Any] {
            for l in localizations { if let d = table[l] as? [String: Any] { add(d["CFBundleDisplayName"]); add(d["CFBundleName"]) } }
        }
        var display = FileManager.default.displayName(atPath: path)
        if display.hasSuffix(".app") { display = String(display.dropLast(4)) }
        if display.isEmpty { display = file }
        return AppRecord(path: path, displayName: display, names: names)
    }

    // MARK: watching (a folder's entries changed = an app was added, removed or renamed)

    private func watch() {
        for dir in folders {
            let fd = open(dir, O_EVTONLY)
            guard fd >= 0 else { continue }
            let s = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete, .link], queue: queue)
            s.setEventHandler { [weak self] in self?.scheduleRescan() }
            s.setCancelHandler { close(fd) }
            s.resume()
            sources.append(s)
        }
    }

    /// Installers write a bundle in several steps: wait for the folder to settle, then scan once.
    func scheduleRescan(after delay: TimeInterval = 1.0) {
        pending?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.scanNow() }
        pending = w
        queue.asyncAfter(deadline: .now() + delay, execute: w)
    }
}
