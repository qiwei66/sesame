import Foundation

public enum RPCError: Error, LocalizedError, Equatable {
    case notRunning
    case server(code: Int, message: String)
    case badResponse(String)
    case timeout
    case processExited

    public var errorDescription: String? {
        switch self {
        case .notRunning: return "core is not running"
        case .server(let code, let message): return "core error \(code): \(message)"
        case .badResponse(let s): return "bad response: \(s)"
        case .timeout: return "core did not answer in time"
        case .processExited: return "core exited"
        }
    }
}

/// Splits a byte stream into `\n`-terminated lines (NDJSON framing). Keeps the partial tail between chunks.
public struct LineSplitter: Sendable {
    private var buffer = Data()
    public init() {}
    public mutating func feed(_ chunk: Data) -> [Data] {
        buffer.append(chunk)
        var lines: [Data] = []
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            if !line.isEmpty { lines.append(line) }
        }
        return lines
    }
}

/// Long-lived `va serve --stdio` child process with JSON-RPC 2.0 request/response matching by id.
/// Restarts the process (with backoff) whenever it exits, until `stop()` is called.
public final class RPCClient: @unchecked Sendable {
    public typealias Logger = @Sendable (String) -> Void

    private let command: [String]
    private let environment: [String: String]?
    private let log: Logger
    private let lock = NSLock()
    private var process: Process?
    private var stdin: FileHandle?
    private var splitter = LineSplitter()
    private var nextId = 1
    private var pending: [Int: (Result<Data, RPCError>) -> Void] = [:]
    private var pendingMethod: [Int: String] = [:]
    private var stopped = false
    private var restarts = 0
    private var policy = RestartPolicy()
    private var answeredSinceLaunch = false
    private var stateValue: CoreState = .starting
    public private(set) var launchCount = 0
    /// Called (on any thread) when the core starts answering, or when restarting was given up.
    public var onStateChange: (@Sendable (CoreState) -> Void)?

    public var state: CoreState { lock.lock(); defer { lock.unlock() }; return stateValue }

    private func setState(_ s: CoreState) {
        lock.lock()
        let changed = stateValue != s
        stateValue = s
        let cb = onStateChange
        lock.unlock()
        if changed { cb?(s) }
    }

    /// - Parameter command: argv, e.g. ["<repo>/bin/va", "serve", "--stdio"]
    public init(command: [String], environment: [String: String]? = nil, log: @escaping Logger) {
        self.command = command
        self.environment = environment
        self.log = log
    }

    public var isRunning: Bool { lock.lock(); defer { lock.unlock() }; return process?.isRunning ?? false }

    public func start() {
        lock.lock(); stopped = false; policy.reset(); restarts = 0; lock.unlock()
        setState(.starting)
        launch()
    }

    public func stop() {
        lock.lock()
        stopped = true
        let p = process
        process = nil
        let waiters = pending
        pending = [:]
        pendingMethod = [:]
        lock.unlock()
        p?.terminationHandler = nil
        if p?.isRunning == true { p?.terminate() }
        waiters.values.forEach { $0(.failure(.processExited)) }
    }

    private func launch() {
        guard let exe = command.first else { log("[rpc] empty core command"); return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = Array(command.dropFirst())
        if let env = environment { p.environment = env }
        let inPipe = Pipe(), outPipe = Pipe(), errPipe = Pipe()
        p.standardInput = inPipe
        p.standardOutput = outPipe
        p.standardError = errPipe
        outPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            if d.isEmpty { h.readabilityHandler = nil; return }
            self?.consume(d)
        }
        errPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            if d.isEmpty { h.readabilityHandler = nil; return }
            if let s = String(data: d, encoding: .utf8) {
                for l in s.split(separator: "\n") { self?.log("[core stderr] \(l)") }
            }
        }
        p.terminationHandler = { [weak self] proc in self?.didExit(proc) }
        do {
            try p.run()
        } catch {
            log("[rpc] failed to launch \(exe): \(error.localizedDescription)")
            lock.lock(); stopped = true; lock.unlock()
            setState(.failed(.coreNotFound))
            return
        }
        lock.lock()
        process = p
        stdin = inPipe.fileHandleForWriting
        splitter = LineSplitter()
        answeredSinceLaunch = false
        launchCount += 1
        let n = launchCount
        lock.unlock()
        log("[rpc] core started pid=\(p.processIdentifier) launch#\(n): \(command.joined(separator: " "))")
    }

    private func didExit(_ proc: Process) {
        lock.lock()
        let wasCurrent = proc === process
        if wasCurrent { process = nil; stdin = nil }
        let waiters = wasCurrent ? pending : [:]
        if wasCurrent { pending = [:]; pendingMethod = [:] }
        let isStopped = stopped
        let failure = wasCurrent && !isStopped ? policy.didExit(status: proc.terminationStatus, answeredSinceLaunch: answeredSinceLaunch) : nil
        if failure != nil { stopped = true }
        lock.unlock()
        guard wasCurrent else { return }
        log("[rpc] core exited status=\(proc.terminationStatus) reason=\(proc.terminationReason.rawValue)")
        waiters.values.forEach { $0(.failure(.processExited)) }
        if let failure {
            // node missing / too old / keeps crashing: restarting will not help, tell the user instead
            log("[rpc] giving up restarting: \(failure)")
            setState(.failed(failure))
            return
        }
        if !isStopped { scheduleRestart() }
    }

    private func scheduleRestart() {
        lock.lock()
        restarts += 1
        let delay = min(30.0, pow(2.0, Double(min(restarts, 5) - 1)))
        lock.unlock()
        log("[rpc] restarting core in \(delay)s")
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self else { return }
            self.lock.lock(); let s = self.stopped; self.lock.unlock()
            if !s { self.launch() }
        }
    }

    private func consume(_ chunk: Data) {
        lock.lock()
        let lines = splitter.feed(chunk)
        lock.unlock()
        for line in lines { route(line) }
    }

    private func route(_ line: Data) {
        guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
            log("[rpc] unparsable line from core (\(line.count) bytes)")
            return
        }
        guard let id = obj["id"] as? Int else { return }
        lock.lock()
        let cb = pending.removeValue(forKey: id)
        pendingMethod.removeValue(forKey: id)
        // a successful answer means the core is healthy again
        restarts = 0
        answeredSinceLaunch = true
        policy.reset()
        lock.unlock()
        setState(.running)
        guard let cb else { return }
        if let e = obj["error"] as? [String: Any] {
            cb(.failure(.server(code: e["code"] as? Int ?? -32000, message: e["message"] as? String ?? "")))
        } else if let r = obj["result"], let data = try? JSONSerialization.data(withJSONObject: r, options: [.fragmentsAllowed]) {
            cb(.success(data))
        } else {
            cb(.failure(.badResponse("missing result")))
        }
    }

    /// Low-level call. `params` must be JSON-serialisable.
    public func callRaw(_ method: String, params: [String: Any]? = nil, timeout: TimeInterval = 120, completion: @escaping (Result<Data, RPCError>) -> Void) {
        lock.lock()
        guard let h = stdin, process?.isRunning == true else { lock.unlock(); completion(.failure(.notRunning)); return }
        let id = nextId
        nextId += 1
        pending[id] = completion
        pendingMethod[id] = method
        lock.unlock()
        var msg: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": method]
        if let params { msg["params"] = params }
        do {
            var data = try JSONSerialization.data(withJSONObject: msg)
            data.append(0x0A)
            try h.write(contentsOf: data)
        } catch {
            lock.lock(); let cb = pending.removeValue(forKey: id); pendingMethod.removeValue(forKey: id); lock.unlock()
            cb?(.failure(.badResponse("write failed: \(error.localizedDescription)")))
            return
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
            guard let self else { return }
            self.lock.lock(); let cb = self.pending.removeValue(forKey: id); self.pendingMethod.removeValue(forKey: id); self.lock.unlock()
            cb?(.failure(.timeout))
        }
    }

    public func call<T: Decodable>(_ method: String, params: [String: Any]? = nil, timeout: TimeInterval = 120, as: T.Type) async throws -> T {
        let data: Data = try await withCheckedThrowingContinuation { cont in
            callRaw(method, params: params, timeout: timeout) { cont.resume(with: $0) }
        }
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw RPCError.badResponse(String(describing: error).prefix(200).description) }
    }

    // MARK: typed methods (docs/rpc.md)

    public func ping() async throws -> PingResult { try await call("ping", timeout: 10, as: PingResult.self) }

    /// - Parameter confirmed: the user already said yes on the panel's confirm card (the core asks nothing itself)
    public func handle(text: String, dryRun: Bool = false, confirmed: Bool = false) async throws -> HandleResult {
        try await call("handle", params: ["text": text, "dryRun": dryRun, "nativeFeedback": false, "confirmed": confirmed], as: HandleResult.self)
    }

    /// Fire-and-forget notification (no id, no answer).
    public func notify(_ method: String, params: [String: Any]) {
        lock.lock(); let h = process?.isRunning == true ? stdin : nil; lock.unlock()
        guard let h, var data = try? JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "method": method, "params": params]) else { return }
        data.append(0x0A)
        try? h.write(contentsOf: data)
    }

    /// Ids of requests still waiting for an answer, for one method.
    public func inFlight(_ method: String) -> [Int] {
        lock.lock(); defer { lock.unlock() }
        return pendingMethod.filter { $0.value == method }.map(\.key).sorted()
    }

    /// Cancel every running `handle` (the panel was closed): the core stops before running any tool.
    @discardableResult
    public func cancelHandles() -> [Int] {
        let ids = inFlight("handle")
        for id in ids { notify("cancel", params: ["id": id]) }
        return ids
    }

    /// Start a background index run (returns at once).
    public func index(full: Bool = false) async throws -> IndexStatus {
        try await call("index", params: ["full": full], timeout: 15, as: IndexStatus.self)
    }

    public func indexStatus() async throws -> IndexStatus { try await call("indexStatus", timeout: 15, as: IndexStatus.self) }

    /// - Parameter live: results while typing (only items whose name carries the typed text; docs/rpc.md `mode: "live"`)
    public func search(query: String, limit: Int = 5, live: Bool = false) async throws -> SearchResult {
        var p: [String: Any] = ["query": query, "limit": limit]
        if live { p["mode"] = "live" }
        return try await call("search", params: p, timeout: 30, as: SearchResult.self)
    }

    /// First-run example (docs/rpc.md `sample`).
    public func sample() async throws -> SampleResult { try await call("sample", timeout: 15, as: SampleResult.self) }

    public func doctor() async throws -> DoctorResult { try await call("doctor", params: ["profile": "sesame"], timeout: 60, as: DoctorResult.self) }
}
