import AppKit
import SwiftUI
import SesameCore

/// Borderless, non-activating, floating panel: it can take keyboard focus without pulling the frontmost
/// app to the background (same behavior as Spotlight-style launchers).
extension NSWindow: Presentable {}

final class SesamePanel: NSPanel {
    let fieldEditor = SesameFieldEditor()

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: Tok.panelWidth, height: 60),
                   styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
                   backing: .buffered, defer: false)
        isFloatingPanel = true
        level = .floating
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = false
        isMovableByWindowBackground = true
        backgroundColor = .clear
        isOpaque = false
        hasShadow = true
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        isReleasedWhenClosed = false
        fieldEditor.isFieldEditor = true
        animationBehavior = .none
    }

    /// demo / screenshot / test runs never take the keyboard (Presentation.passive)
    override var canBecomeKey: Bool { MainActor.assumeIsolated { Presentation.mayTakeFocus } }
    override var canBecomeMain: Bool { false }

    /// Esc while no text field has focus (listening, notices): same as Esc in the field
    var onCancel: () -> Void = {}
    override func cancelOperation(_ sender: Any?) { onCancel() }

    override func fieldEditor(_ createFlag: Bool, for object: Any?) -> NSText? {
        if object is QueryTextField { return fieldEditor }
        return super.fieldEditor(createFlag, for: object)
    }
}

/// Glass container: NSVisualEffectView (native vibrancy) + the --glass tint + 0.5pt rim/edge lines, radius 26.
struct GlassBackground: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        // .popover; in dark it alone renders a flat mid grey (and .hudWindow is lighter still over a light desktop:
        // measured #4D4C4E), so the depth comes from Tok.panelTint on top
        v.material = .popover
        v.blendingMode = .behindWindow
        v.state = .active
        v.wantsLayer = true
        v.layer?.cornerRadius = Tok.rPanel
        v.layer?.cornerCurve = .continuous
        v.layer?.masksToBounds = true
        return v
    }
    func updateNSView(_ v: NSVisualEffectView, context: Context) {}
}

struct PanelRoot: View {
    @ObservedObject var model: PanelModel
    var body: some View {
        VStack(spacing: 0) {
            glass
            Spacer(minLength: 0)
        }
    }

    /// Height changes animate inside the window (the window is resized to the larger of old / new around it)
    private var glass: some View {
        PanelView(model: model)
            .background(
                ZStack {
                    GlassBackground()
                    RoundedRectangle(cornerRadius: Tok.rPanel, style: .continuous).fill(Tok.panelTint)
                }
            )
            .overlay(RoundedRectangle(cornerRadius: Tok.rPanel, style: .continuous).strokeBorder(Tok.glassEdge, lineWidth: 0.5).padding(0.5))
            .overlay(RoundedRectangle(cornerRadius: Tok.rPanel, style: .continuous).strokeBorder(Tok.glassRim, lineWidth: 0.5))
            .clipShape(RoundedRectangle(cornerRadius: Tok.rPanel, style: .continuous))
            .animation(model.animate ? .timingCurve(0.2, 0.8, 0.2, 1, duration: 0.26) : nil, value: model.heightKey)
    }
}

@MainActor
final class PanelController {
    let panel = SesamePanel()
    let model = PanelModel()
    private let host: NSHostingView<PanelRoot>
    private var sizeObserver: NSObjectProtocol?

    init() {
        host = NSHostingView(rootView: PanelRoot(model: model))
        host.translatesAutoresizingMaskIntoConstraints = true
        panel.contentView = host
        host.frame = NSRect(origin: .zero, size: host.fittingSize)
        // keep the window height equal to the content; top edge stays put
        host.postsFrameChangedNotifications = true
        sizeObserver = NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification, object: nil, queue: .main) { _ in }
    }

    deinit { if let o = sizeObserver { NotificationCenter.default.removeObserver(o) } }

    var isVisible: Bool { panel.isVisible }

    private var shrink: DispatchWorkItem?

    /// Resize to the SwiftUI content's fitting height without moving the top edge. Growing: the window grows at once
    /// and the glass animates down inside it; shrinking: the window follows after the 260 ms animation.
    func fit() {
        host.layoutSubtreeIfNeeded()
        let h = ceil(host.fittingSize.height)
        let cur = panel.frame.height
        shrink?.cancel(); shrink = nil
        if h >= cur || !model.animate || !panel.isVisible {
            setHeight(h)
        } else {
            let w = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.setHeight(h) } }
            shrink = w
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.28, execute: w)
        }
    }

    private func setHeight(_ h: CGFloat) {
        var f = panel.frame
        let top = f.maxY
        f.size = NSSize(width: Tok.panelWidth, height: h)
        f.origin.y = top - f.size.height
        panel.setFrame(f, display: true)
        host.frame = NSRect(origin: .zero, size: f.size)
        panel.invalidateShadow()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.panel.invalidateShadow() }
    }

    /// Position: horizontally centered, top edge at 21% of the screen height (prototype `.panel { top: 21vh }`).
    private func place() {
        let screen = NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.main
        guard let vf = screen?.visibleFrame, let full = screen?.frame else { return }
        let w = Tok.panelWidth
        let top = full.maxY - full.height * 0.21
        var f = panel.frame
        f.origin.x = vf.midX - w / 2
        f.origin.y = top - f.height
        panel.setFrame(f, display: false)
    }

    /// 180ms fade-in + 1% scale (prototype `@keyframes summon`), plus the one-time sheen on the mark.
    func show(animated: Bool = true) {
        fit()
        place()
        fit()
        model.animate = animated
        if animated {
            panel.alphaValue = 0
            Presentation.show(panel)
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.18
                ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
                panel.animator().alphaValue = 1
            }
        } else {
            panel.alphaValue = 1
            Presentation.show(panel)
        }
        model.shineToken += 1
        if Presentation.mayTakeFocus { focusField() }
    }

    func hide(fade: Bool = false) {
        guard fade, panel.isVisible else { panel.orderOut(nil); return }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.18
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                // shown again during the fade: keep it
                if self.panel.alphaValue == 0 { self.panel.orderOut(nil) }
                self.panel.alphaValue = 1
            }
        })
    }

    func focusField() {
        guard Presentation.mayTakeFocus else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard let tf = Self.findField(in: self.host) else { return }
            self.panel.makeFirstResponder(tf)
            // caret at the end, nothing selected; caret in the accent color like the prototype
            if let ed = tf.currentEditor() as? NSTextView {
                ed.setSelectedRange(NSRange(location: (tf.stringValue as NSString).length, length: 0))
                ed.insertionPointColor = Tok.nsAccent
            }
        }
    }

    private static func findField(in v: NSView) -> NSTextField? {
        if let t = v as? QueryTextField { return t }
        for s in v.subviews { if let t = findField(in: s) { return t } }
        return nil
    }
}
