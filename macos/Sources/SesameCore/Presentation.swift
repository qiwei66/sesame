import Foundation

/// A window Sesame shows: the two ways AppKit can bring one up (NSWindow conforms in the app target).
@MainActor
public protocol Presentable: AnyObject {
    func makeKeyAndOrderFront(_ sender: Any?)
    func orderFrontRegardless()
}

/// How windows come up. `passive` = demo / screenshot / test runs: on screen, but never the key window and never
/// activating the app, so whatever the user is typing keeps going where it was going (a demo panel once swallowed
/// typing while screenshots were taken). A real hot-key press is not passive: the panel takes the keyboard.
@MainActor
public enum Presentation {
    public static var passive = false

    /// Bring a window up under the current policy; `activateApp` runs only when the window may take focus.
    public static func show(_ w: Presentable, activateApp: (() -> Void)? = nil) {
        if passive {
            w.orderFrontRegardless()
        } else {
            activateApp?()
            w.makeKeyAndOrderFront(nil)
        }
    }

    /// The panel may become key (and its field the first responder) only outside passive mode.
    public static var mayTakeFocus: Bool { !passive }
}
