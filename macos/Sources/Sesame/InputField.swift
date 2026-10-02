import AppKit
import SwiftUI
import SesameCore

/// Field editor that tags where each change came from, so the paste auto-commit rule needs no guessing.
/// Keyboard input (including an input method committing a whole word) is `.typed`; the `paste:` action is
/// `.paste`; anything else (accessibility value set by a dictation tool, services) is `.external`.
final class SesameFieldEditor: NSTextView {
    private(set) var currentSource: InsertSource = .external

    private func tagged(_ s: InsertSource, _ body: () -> Void) {
        let prev = currentSource
        currentSource = s
        body()
        currentSource = prev
    }

    override func insertText(_ string: Any, replacementRange: NSRange) {
        tagged(.typed) { super.insertText(string, replacementRange: replacementRange) }
    }

    override func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        tagged(.typed) { super.setMarkedText(string, selectedRange: selectedRange, replacementRange: replacementRange) }
    }

    override func deleteBackward(_ sender: Any?) { tagged(.typed) { super.deleteBackward(sender) } }
    override func deleteForward(_ sender: Any?) { tagged(.typed) { super.deleteForward(sender) } }
    override func cut(_ sender: Any?) { tagged(.typed) { super.cut(sender) } }

    override func paste(_ sender: Any?) { tagged(.paste) { super.paste(sender) } }
    override func pasteAsPlainText(_ sender: Any?) { tagged(.paste) { super.pasteAsPlainText(sender) } }

    /// The app is an LSUIElement agent with no Edit menu, so ⌘V/⌘C/⌘X/⌘A/⌘Z are handled here.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard event.type == .keyDown, event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
              let ch = event.charactersIgnoringModifiers?.lowercased() else { return super.performKeyEquivalent(with: event) }
        switch ch {
        case "v": paste(nil); return true
        case "c": copy(nil); return true
        case "x": cut(nil); return true
        case "a": selectAll(nil); return true
        case "z": undoManager?.undo(); return true
        default: return super.performKeyEquivalent(with: event)
        }
    }
}

final class QueryTextField: NSTextField {
    /// demo / screenshot / test runs: the field only shows text, it never takes the keyboard
    override var acceptsFirstResponder: Bool { MainActor.assumeIsolated { Presentation.mayTakeFocus } }
}

struct InputField: NSViewRepresentable {
    @ObservedObject var model: PanelModel

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeNSView(context: Context) -> QueryTextField {
        let f = QueryTextField()
        f.isBordered = false
        f.drawsBackground = false
        f.focusRingType = .none
        f.isBezeled = false
        f.font = NSFont.systemFont(ofSize: 17)
        f.textColor = Tok.nsText2
        f.lineBreakMode = .byTruncatingTail
        f.cell?.usesSingleLineMode = true
        f.cell?.wraps = false
        f.cell?.isScrollable = true
        if !Presentation.mayTakeFocus { f.isEditable = false; f.isSelectable = false }
        InputField.setPlaceholder(f)
        f.delegate = context.coordinator
        f.stringValue = model.query
        f.setAccessibilityIdentifier("sesame.query")
        return f
    }

    /// "Type a sentence, or hold <the key that works now> to talk": re-set on every update, so a takeover that
    /// switched the key to ⌘Space shows up the next time the panel draws.
    static func setPlaceholder(_ f: NSTextField) {
        let text = L10n.f("placeholder", Store.hotKey.displayString)
        if f.placeholderAttributedString?.string == text { return }
        f.placeholderAttributedString = NSAttributedString(string: text, attributes: [
            .foregroundColor: Tok.nsText4, .font: NSFont.systemFont(ofSize: 17),
        ])
    }

    func updateNSView(_ f: QueryTextField, context: Context) {
        InputField.setPlaceholder(f)
        if f.stringValue != model.query && (f.currentEditor() as? NSTextView)?.hasMarkedText() != true {
            f.stringValue = model.query
        }
    }

    final class Coordinator: NSObject, NSTextFieldDelegate {
        let model: PanelModel
        init(model: PanelModel) { self.model = model }

        func controlTextDidChange(_ obj: Notification) {
            guard let f = obj.object as? NSTextField else { return }
            let editor = f.currentEditor() as? SesameFieldEditor
            let source = editor?.currentSource ?? .external
            // pinyin etc. still composing (marked text): the field shows it, but it is not what the user means yet
            let composing = editor?.hasMarkedText() ?? false
            let text = f.stringValue
            MainActor.assumeIsolated {
                model.query = text
                model.onTextChange(text, source, composing)
            }
        }

        func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
            MainActor.assumeIsolated {
                switch sel {
                case #selector(NSResponder.insertNewline(_:)): model.returnPressed(); return true
                case #selector(NSResponder.moveUp(_:)): model.moveSelection(-1); return true
                case #selector(NSResponder.moveDown(_:)): model.moveSelection(1); return true
                case #selector(NSResponder.cancelOperation(_:)): model.onDismiss(); return true
                default: return false
                }
            }
        }
    }
}
