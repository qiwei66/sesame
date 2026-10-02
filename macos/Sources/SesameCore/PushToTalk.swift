import Foundation

/// Speech permission as the panel needs it (microphone + speech recognition together).
public enum SpeechAuth: Equatable, Sendable {
    case notDetermined
    case authorized
    /// the user said no (or a profile forbids it): the panel says how to turn it on in System Settings
    case denied
    /// no recognizer for the language on this Mac
    case unavailable
}

/// The recognizer behind push-to-talk. The app uses SFSpeechRecognizer + AVAudioEngine; tests inject a fake.
public protocol SpeechRecognizing: AnyObject {
    var authorization: SpeechAuth { get }
    /// Ask the system (microphone, then speech recognition). Called only after the user pressed "Allow microphone".
    func requestAuthorization(_ done: @escaping @Sendable (SpeechAuth) -> Void)
    /// Start listening. `partial` gets the whole best transcript so far; `failed` a reason (logged, never shown raw).
    func start(languageCode: String, partial: @escaping @Sendable (String) -> Void, failed: @escaping @Sendable (String) -> Void)
    /// Stop the microphone and deliver the final transcript (may be empty).
    func stop(_ final: @escaping @Sendable (String) -> Void)
    /// Stop without a result.
    func cancel()
}

/// What the panel should do next.
public enum PushToTalkOutput: Equatable, Sendable {
    /// short press (< hold threshold): open / close the panel as before
    case tap
    /// listening; already-settled text and the still-changing tail
    case listening(final: String, interim: String)
    /// first use: show the microphone notice before any system prompt
    case askPermission
    case denied
    case unavailable
    /// released: send this sentence like a typed one
    case submit(String)
    /// released with nothing heard, or cancelled (Esc)
    case cancelled
    /// permission granted from the notice: back to the plain input, next hold listens
    case ready
}

/// Partial transcripts → settled part + changing tail: the prefix shared with the previous partial is settled.
public enum TranscriptSplit {
    public static func split(previous: String, current: String) -> (final: String, interim: String) {
        let a = Array(previous), b = Array(current)
        var n = 0
        while n < a.count, n < b.count, a[n] == b[n] { n += 1 }
        return (String(b[..<n]), String(b[n...]))
    }
}

/// Hold the hot key > 300 ms = listen, release = send; a shorter press keeps toggling the panel. The first hold shows the
/// microphone notice; the system prompt only comes after "Allow microphone". Main-thread only.
public final class PushToTalkController {
    public static let holdThreshold: TimeInterval = 0.3

    public enum State: Equatable, Sendable { case idle, pressed, listening, finishing, asking }
    public private(set) var state: State = .idle

    private let recognizer: SpeechRecognizing
    /// schedule(seconds, block) → cancel. Real app: a run-loop timer; tests: a manual clock.
    private let schedule: (TimeInterval, @escaping () -> Void) -> () -> Void
    private let languageCode: () -> String
    private let output: (PushToTalkOutput) -> Void
    /// hop back to the main thread for recognizer callbacks (tests: run inline)
    private let onMain: (@escaping () -> Void) -> Void
    private var cancelHold: (() -> Void)?
    private var lastPartial = ""
    private var session = 0

    public init(recognizer: SpeechRecognizing,
                schedule: @escaping (TimeInterval, @escaping () -> Void) -> () -> Void,
                languageCode: @escaping () -> String,
                onMain: @escaping (@escaping () -> Void) -> Void = { b in DispatchQueue.main.async(execute: b) },
                output: @escaping (PushToTalkOutput) -> Void) {
        self.recognizer = recognizer; self.schedule = schedule; self.languageCode = languageCode; self.onMain = onMain; self.output = output
    }

    public func keyDown() {
        // key auto-repeat or a second press while we are still busy: ignore
        guard state == .idle || state == .asking else { return }
        state = .pressed
        cancelHold = schedule(Self.holdThreshold) { [weak self] in self?.holdElapsed() }
    }

    public func keyUp() {
        switch state {
        case .pressed:
            cancelHold?(); cancelHold = nil
            state = .idle
            output(.tap)
        case .listening:
            state = .finishing
            let s = session
            recognizer.stop { [weak self] text in
                self?.onMain {
                    guard let self, self.session == s, self.state == .finishing else { return }
                    self.state = .idle
                    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    self.output(t.isEmpty ? .cancelled : .submit(t))
                }
            }
        default:
            break
        }
    }

    private func holdElapsed() {
        cancelHold = nil
        guard state == .pressed else { return }
        switch recognizer.authorization {
        case .authorized: begin()
        case .notDetermined: state = .asking; output(.askPermission)
        case .denied: state = .idle; output(.denied)
        case .unavailable: state = .idle; output(.unavailable)
        }
    }

    private func begin() {
        state = .listening
        session += 1
        let s = session
        lastPartial = ""
        output(.listening(final: "", interim: ""))
        recognizer.start(languageCode: languageCode(), partial: { [weak self] text in
            self?.onMain {
                guard let self, self.session == s, self.state == .listening else { return }
                let sp = TranscriptSplit.split(previous: self.lastPartial, current: text)
                self.lastPartial = text
                self.output(.listening(final: sp.final, interim: sp.interim))
            }
        }, failed: { [weak self] _ in
            self?.onMain {
                guard let self, self.session == s, self.state == .listening || self.state == .finishing else { return }
                self.state = .idle
                self.output(.cancelled)
            }
        })
    }

    /// "Allow microphone" on the notice: only now the system prompts.
    public func allow() {
        recognizer.requestAuthorization { [weak self] auth in
            self?.onMain {
                guard let self else { return }
                self.state = .idle
                switch auth {
                case .authorized: self.output(.ready)
                case .unavailable: self.output(.unavailable)
                case .denied, .notDetermined: self.output(.denied)
                }
            }
        }
    }

    /// "Not now": no penalty, typing works as before; the next hold shows the notice again.
    public func decline() { state = .idle }

    /// Esc / panel closed while listening.
    public func cancel() {
        cancelHold?(); cancelHold = nil
        if state == .listening || state == .finishing { recognizer.cancel(); session += 1 }
        state = .idle
    }
}
