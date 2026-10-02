// va-autoenter：Typeless 在 Alfred 输入框里听写完成后自动按回车。
//
// 判定（全部满足才按）：
//   1. Typeless 刚完成一次听写：typeless.db 的 mtime 变化（只看修改时间，不读内容）
//      且剪贴板 changeCount 变化（Typeless 每次结果都会进剪贴板再 ⌘V 粘贴），两者相隔 ≤ 3 秒
//   2. 此刻 Alfred 的搜索框在屏幕上（Alfred 拥有一个宽 ≥ 400、高 ≥ 40 的在屏窗口），或 Alfred 是前台 App
//   3. Alfred 输入框内容非空并稳定 400ms（有辅助功能权限时用 AX 读；没有就退化为「信号后等 600ms」）
// 只在 Alfred 搜索框在屏时生效，其他 App（微信等）里听写不会被按回车。
//
// 权限：发送回车（CGEvent.post）需要「辅助功能」。不需要输入监控（不监听键盘）。
//
// 用法：va-autoenter            常驻（launchd 跑）
//       va-autoenter --check    打印当前状态（权限、Alfred 是否在屏、db/剪贴板计数）
//       va-autoenter --selftest 跑判定逻辑的离线自测

import AppKit
import ApplicationServices
import Foundation

let alfredBundle = "com.runningwithcrayons.Alfred"
let env = ProcessInfo.processInfo.environment
// 测试用覆盖：VA_AE_DB 指向假的 db 文件；VA_AE_PB_FILE 设了就用该文件的 mtime 代替剪贴板计数（不碰真剪贴板）
let typelessDB = env["VA_AE_DB"] ?? NSString(string: "~/Library/Application Support/Typeless/typeless.db").expandingTildeInPath
let fakePasteboard = env["VA_AE_PB_FILE"]

func pasteboardCount() -> Int {
    if let f = fakePasteboard {
        let t = (try? FileManager.default.attributesOfItem(atPath: f)[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        return Int(t * 1000)
    }
    return NSPasteboard.general.changeCount
}

func log(_ s: String) {
    let f = ISO8601DateFormatter()
    FileHandle.standardError.write("\(f.string(from: Date())) \(s)\n".data(using: .utf8)!)
}

// ───────────── 纯判定逻辑（可离线自测） ─────────────

struct Signals {
    var lastDBChange: TimeInterval?      // typeless.db mtime 变化被观察到的时刻
    var lastPasteChange: TimeInterval?   // 剪贴板 changeCount 变化被观察到的时刻
}

enum Decision: Equatable { case wait, fire, reset }

/// now：当前时刻；alfredUp：Alfred 搜索框在屏；text：Alfred 输入框当前内容（nil = 读不到）；
/// textStableSince：内容最后一次变化的时刻；fired：本轮是否已经按过
func decide(_ s: Signals, now: TimeInterval, alfredUp: Bool, text: String?, textStableSince: TimeInterval, fired: Bool) -> Decision {
    guard let db = s.lastDBChange, let pb = s.lastPasteChange else { return .wait }
    if fired { return .wait }
    if abs(db - pb) > 3 { return .wait }                 // 两个信号不是同一次听写
    let signalAt = max(db, pb)
    if now - signalAt > 5 { return .reset }               // 太久了，放弃这轮
    guard alfredUp else { return .reset }                  // Alfred 不在屏：别处的听写，不管
    if let t = text {
        if t.trimmingCharacters(in: .whitespaces).isEmpty { return .wait }
        return (now - textStableSince >= 0.4 && now - signalAt >= 0.15) ? .fire : .wait
    }
    return now - signalAt >= 0.6 ? .fire : .wait           // 无 AX 权限：信号后等 600ms
}

// ───────────── 系统读数 ─────────────

func dbMTime() -> TimeInterval? {
    (try? FileManager.default.attributesOfItem(atPath: typelessDB)[.modificationDate] as? Date)?.timeIntervalSince1970
}

func alfredPid() -> pid_t? {
    NSRunningApplication.runningApplications(withBundleIdentifier: alfredBundle).first?.processIdentifier
}

/// Alfred 搜索框在屏：Alfred 进程有一个宽≥400、高≥40 的在屏窗口（菜单栏图标那种小窗不算）
func alfredBarOnScreen() -> Bool {
    guard let pid = alfredPid() else { return false }
    if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == alfredBundle { return true }
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return false }
    for w in list {
        guard (w[kCGWindowOwnerPID as String] as? pid_t) == pid,
              let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
        if (b["Width"] ?? 0) >= 400 && (b["Height"] ?? 0) >= 40 { return true }
    }
    return false
}

/// 用 AX 读 Alfred 当前焦点输入框的文字；没权限或读不到返回 nil
func alfredText() -> String? {
    guard AXIsProcessTrusted(), let pid = alfredPid() else { return nil }
    let app = AXUIElementCreateApplication(pid)
    var focused: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &focused) == .success, let el = focused else { return nil }
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el as! AXUIElement, kAXValueAttribute as CFString, &value) == .success else { return nil }
    return value as? String
}

func pressReturn() {
    let src = CGEventSource(stateID: .hidSystemState)
    let down = CGEvent(keyboardEventSource: src, virtualKey: 36, keyDown: true)
    let up = CGEvent(keyboardEventSource: src, virtualKey: 36, keyDown: false)
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)
}

// ───────────── 自测 ─────────────

func selftest() -> Int32 {
    var fails = 0
    func check(_ name: String, _ got: Decision, _ want: Decision) {
        let ok = got == want
        if !ok { fails += 1 }
        print("\(ok ? "ok  " : "FAIL") \(name): got \(got) want \(want)")
    }
    let t: TimeInterval = 1000
    check("没信号 → 等", decide(Signals(), now: t, alfredUp: true, text: "x", textStableSince: 0, fired: false), .wait)
    check("只有剪贴板变化（用户自己复制）→ 等", decide(Signals(lastDBChange: nil, lastPasteChange: t - 1), now: t, alfredUp: true, text: "x", textStableSince: 0, fired: false), .wait)
    check("两信号相隔 10 秒 → 等", decide(Signals(lastDBChange: t - 11, lastPasteChange: t - 1), now: t, alfredUp: true, text: "x", textStableSince: 0, fired: false), .wait)
    check("Alfred 不在屏（微信里听写）→ 放弃", decide(Signals(lastDBChange: t - 0.5, lastPasteChange: t - 0.5), now: t, alfredUp: false, text: nil, textStableSince: 0, fired: false), .reset)
    check("Alfred 在屏、文字刚变（未稳定 400ms）→ 等", decide(Signals(lastDBChange: t - 0.5, lastPasteChange: t - 0.5), now: t, alfredUp: true, text: "打开飞书", textStableSince: t - 0.2, fired: false), .wait)
    check("Alfred 在屏、文字稳定 400ms → 按回车", decide(Signals(lastDBChange: t - 0.6, lastPasteChange: t - 0.6), now: t, alfredUp: true, text: "打开飞书", textStableSince: t - 0.45, fired: false), .fire)
    check("输入框为空 → 等", decide(Signals(lastDBChange: t - 0.6, lastPasteChange: t - 0.6), now: t, alfredUp: true, text: "  ", textStableSince: t - 2, fired: false), .wait)
    check("已经按过 → 不重复按", decide(Signals(lastDBChange: t - 0.6, lastPasteChange: t - 0.6), now: t, alfredUp: true, text: "打开飞书", textStableSince: t - 1, fired: true), .wait)
    check("无 AX 权限：信号后 600ms → 按", decide(Signals(lastDBChange: t - 0.7, lastPasteChange: t - 0.7), now: t, alfredUp: true, text: nil, textStableSince: 0, fired: false), .fire)
    check("无 AX 权限：信号后 300ms → 等", decide(Signals(lastDBChange: t - 0.3, lastPasteChange: t - 0.3), now: t, alfredUp: true, text: nil, textStableSince: 0, fired: false), .wait)
    check("信号超过 5 秒没稳定 → 放弃", decide(Signals(lastDBChange: t - 6, lastPasteChange: t - 6), now: t, alfredUp: true, text: "x", textStableSince: t, fired: false), .reset)
    print(fails == 0 ? "selftest: all passed" : "selftest: \(fails) failed")
    return fails == 0 ? 0 : 1
}

// ───────────── 主循环 ─────────────

let args = CommandLine.arguments
if args.contains("--selftest") { exit(selftest()) }
if args.contains("--check") {
    print("accessibility_trusted=\(AXIsProcessTrusted())")
    print("alfred_running=\(alfredPid() != nil) alfred_bar_on_screen=\(alfredBarOnScreen())")
    print("frontmost=\(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "nil")")
    print("alfred_text_chars=\(alfredText()?.count ?? -1)")
    print("typeless_db_exists=\(dbMTime() != nil) pasteboard_changeCount=\(NSPasteboard.general.changeCount)")
    exit(0)
}
if args.contains("--prompt-accessibility") {
    // 弹出系统的「允许辅助功能」提示（用户点「打开系统设置」后勾选本程序）
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    print("accessibility_trusted=\(AXIsProcessTrustedWithOptions(opts))")
    exit(0)
}

log("va-autoenter started v2; accessibility_trusted=\(AXIsProcessTrusted())")

/// 未授权自愈提示：系统通知 + 日志，每天最多通知一次（不静默失效）
func nagIfUntrusted() {
    guard !AXIsProcessTrusted() else { return }
    let stamp = NSString(string: "~/.voice-agent/logs/.autoenter-nag-date").expandingTildeInPath
    let df = DateFormatter(); df.dateFormat = "yyyy-MM-dd"
    let today = df.string(from: Date())
    let last = (try? String(contentsOfFile: stamp, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
    log("accessibility NOT granted: auto-Return disabled until granted; run va-autoenter-setup")
    if last == today { return }
    try? FileManager.default.createDirectory(atPath: (stamp as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try? today.write(toFile: stamp, atomically: true, encoding: .utf8)
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    p.arguments = ["-e", "display notification \"语音回车助手需要授权，运行 va-autoenter-setup\" with title \"语音助手\""]
    try? p.run()
    log("posted untrusted notification (once per day)")
}
nagIfUntrusted()
var sig = Signals()
var lastDB = dbMTime()
var lastCount = pasteboardCount()
var lastText: String? = nil
var textSince: TimeInterval = 0
var fired = false
var trusted = AXIsProcessTrusted()
var tick = 0

let timer = Timer(timeInterval: 0.1, repeats: true) { _ in
    let now = Date().timeIntervalSince1970
    tick += 1
    if tick % 50 == 0 {
        let t = AXIsProcessTrusted()
        if t != trusted { trusted = t; log("accessibility_trusted=\(t)") }
    }
    let db = dbMTime()
    if db != lastDB { lastDB = db; sig.lastDBChange = now; fired = false }
    let c = pasteboardCount()
    if c != lastCount { lastCount = c; sig.lastPasteChange = now; fired = false }
    // 单个信号超过 5 秒还没等到另一个，作废（避免旧的复制和后来的听写拼在一起）
    if let d = sig.lastDBChange, now - d > 5 { sig.lastDBChange = nil }
    if let p = sig.lastPasteChange, now - p > 5 { sig.lastPasteChange = nil }
    guard sig.lastDBChange != nil || sig.lastPasteChange != nil else { return }
    let up = alfredBarOnScreen()
    let text = up ? alfredText() : nil
    if text != lastText { lastText = text; textSince = now }
    switch decide(sig, now: now, alfredUp: up, text: text, textStableSince: textSince, fired: fired) {
    case .fire:
        if !trusted { log("would fire but accessibility not granted"); sig = Signals(); return }
        pressReturn()
        fired = true
        log("fired Return (ax=\(text != nil), chars=\(text?.count ?? -1))")
        sig = Signals()
    case .reset:
        sig = Signals()
    case .wait:
        break
    }
}
RunLoop.main.add(timer, forMode: .common)
RunLoop.main.run()
