import AVFoundation
import Foundation
import Speech
import SesameCore

/// Push-to-talk recognizer: SFSpeechRecognizer fed by AVAudioEngine, on-device when this Mac supports it.
/// The microphone runs only between `start` and `stop` (hold the hot key). No audio is stored.
final class SystemSpeech: SpeechRecognizing, @unchecked Sendable {
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var recognizer: SFSpeechRecognizer?
    private var lastText = ""
    private var finish: ((String) -> Void)?
    private var tapInstalled = false
    /// recognizer language the app will ask for (zh-CN / en-US); used to tell "no recognizer on this Mac"
    var languageCode = "zh-CN"

    var authorization: SpeechAuth {
        if SFSpeechRecognizer(locale: Locale(identifier: languageCode)) == nil { return .unavailable }
        let mic = AVCaptureDevice.authorizationStatus(for: .audio)
        let sp = SFSpeechRecognizer.authorizationStatus()
        if mic == .denied || mic == .restricted || sp == .denied || sp == .restricted { return .denied }
        if mic == .notDetermined || sp == .notDetermined { return .notDetermined }
        return .authorized
    }

    func requestAuthorization(_ done: @escaping @Sendable (SpeechAuth) -> Void) {
        AVCaptureDevice.requestAccess(for: .audio) { micOK in
            guard micOK else { done(.denied); return }
            SFSpeechRecognizer.requestAuthorization { st in
                done(st == .authorized ? .authorized : .denied)
            }
        }
    }

    func start(languageCode: String, partial: @escaping @Sendable (String) -> Void, failed: @escaping @Sendable (String) -> Void) {
        stopAudio()
        guard let rec = SFSpeechRecognizer(locale: Locale(identifier: languageCode)), rec.isAvailable else {
            failed("recognizer unavailable for \(languageCode)")
            return
        }
        recognizer = rec
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        // on this Mac when it can (nothing leaves the machine); otherwise Apple's server recognizer
        if rec.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        req.addsPunctuation = false
        request = req
        lastText = ""
        Log.write("[speech] start lang=\(languageCode) onDevice=\(rec.supportsOnDeviceRecognition)")
        let input = engine.inputNode
        let fmt = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: fmt) { [weak self] buf, _ in self?.request?.append(buf) }
        tapInstalled = true
        engine.prepare()
        do {
            try engine.start()
        } catch {
            stopAudio()
            failed("audio engine: \(error.localizedDescription)")
            return
        }
        task = rec.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            if let r = result {
                self.lastText = r.bestTranscription.formattedString
                if r.isFinal { self.deliver() } else { partial(self.lastText) }
            }
            if let error, result?.isFinal != true {
                // "no speech detected" after stop is normal: deliver what we have
                if self.finish != nil { self.deliver() } else { failed(error.localizedDescription) }
            }
        }
    }

    func stop(_ final: @escaping @Sendable (String) -> Void) {
        finish = final
        stopAudio()
        request?.endAudio()
        // the recognizer usually answers isFinal within a few hundred ms; do not wait forever
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.deliver() }
    }

    func cancel() {
        finish = nil
        stopAudio()
        task?.cancel()
        task = nil
        request = nil
    }

    private func deliver() {
        guard let f = finish else { return }
        finish = nil
        task?.finish()
        task = nil
        request = nil
        Log.write("[speech] final \(lastText.count) chars")
        f(lastText)
    }

    private func stopAudio() {
        if engine.isRunning { engine.stop() }
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
    }
}

#if SESAME_TEST_HOOKS
/// Test builds only: `--fake-speech "<sentence>"` plays the sentence back as partials, two characters every 120 ms,
/// so the listening state can be driven and captured without a microphone. `--fake-speech-auth notDetermined|denied`
/// starts from that permission state.
final class FakeSpeech: SpeechRecognizing, @unchecked Sendable {
    let sentence: String
    var authorization: SpeechAuth
    private var timer: Timer?
    private var shown = 0

    init(sentence: String, auth: SpeechAuth) { self.sentence = sentence; authorization = auth }

    func requestAuthorization(_ done: @escaping @Sendable (SpeechAuth) -> Void) {
        Log.write("[test] fake speech: requestAuthorization (system prompt would appear here)")
        authorization = .authorized
        done(.authorized)
    }

    func start(languageCode: String, partial: @escaping @Sendable (String) -> Void, failed: @escaping @Sendable (String) -> Void) {
        shown = 0
        Log.write("[test] fake speech start lang=\(languageCode)")
        let chars = Array(sentence)
        let t = Timer(timeInterval: 0.12, repeats: true) { [weak self] tm in
            guard let self else { tm.invalidate(); return }
            self.shown = min(chars.count, self.shown + 2)
            partial(String(chars[..<self.shown]))
            if self.shown >= chars.count { tm.invalidate() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func stop(_ final: @escaping @Sendable (String) -> Void) {
        timer?.invalidate()
        final(String(Array(sentence)[..<shown]))
    }

    func cancel() { timer?.invalidate() }
}
#endif
