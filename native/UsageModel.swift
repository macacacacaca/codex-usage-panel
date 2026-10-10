import AppKit
import Combine
import Foundation

enum PanelError: Error { case unavailable, incompatibleService, missingNode }

@MainActor final class BackendCoordinator {
    var process: Process?
    var log: FileHandle?
    let base = URL(string: "http://127.0.0.1:4317")!
    let session: URLSession
    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 3
        session = URLSession(configuration: config)
    }
    func ensureRunning() async throws {
        do {
            let (data, response) = try await session.data(from: base.appendingPathComponent("health"))
            if (response as? HTTPURLResponse)?.statusCode == 200 {
                let health = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                guard (health?["version"] as? String)?.hasPrefix("0.3.") == true else { throw PanelError.incompatibleService }
                return
            }
        } catch PanelError.incompatibleService { throw PanelError.incompatibleService }
        catch { /* No existing service: start the packaged read-only backend. */ }
        if process?.isRunning != true {
            let home = FileManager.default.homeDirectoryForCurrentUser
            let candidates = ["/usr/local/bin/node", "/opt/homebrew/bin/node", home.appendingPathComponent(".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node").path]
            guard let node = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else { throw PanelError.missingNode }
            let serviceRoot = Bundle.main.resourceURL!.appendingPathComponent("Service")
            let runtime = home.appendingPathComponent("Library/Application Support/CodexUsage/runtime")
            try FileManager.default.createDirectory(at: runtime, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let logURL = runtime.appendingPathComponent("service.log")
            if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
            log = try FileHandle(forWritingTo: logURL); try log?.seekToEnd()
            let child = Process()
            child.executableURL = URL(fileURLWithPath: node)
            child.arguments = ["src/server.ts"]
            child.currentDirectoryURL = serviceRoot
            var environment = ProcessInfo.processInfo.environment
            environment["PORT"] = "4317"
            environment["CODEX_USAGE_RUNTIME_DIR"] = runtime.path
            child.environment = environment
            child.standardInput = FileHandle.nullDevice
            child.standardOutput = log; child.standardError = log
            try child.run(); process = child
        }
        for _ in 0..<30 {
            try Task.checkCancellation()
            if let (_, response) = try? await session.data(from: base.appendingPathComponent("health")), (response as? HTTPURLResponse)?.statusCode == 200 { return }
            guard process?.isRunning == true else { throw PanelError.unavailable }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        throw PanelError.unavailable
    }
    func stopOwnedProcess() {
        if let process, process.isRunning { process.terminate() }
        log?.closeFile(); log = nil
    }
}

@MainActor final class UsageModel: ObservableObject {
    @Published var payload: NativePayload?
    @Published var connected = false
    @Published var message = "正在啟動用量服務…"
    @Published var manualRefreshing = false
    @Published var pricing: String = UserDefaults.standard.string(forKey: "pricing") ?? "standard" {
        didSet { UserDefaults.standard.set(pricing, forKey: "pricing") }
    }
    @Published var selectedBucket = ""
    @Published var now = Date()
    @Published var trackingMessage = ""
    let backend = BackendCoordinator()
    let panelId = UUID().uuidString
    var stream: Task<Void, Never>?
    var timer: AnyCancellable?
    var changes: (() -> Void)?
    var closePanel: (() -> Void)?
    var snapshot: UsageSnapshot? { payload?.snapshot }
    var bucket: UsageBucket? { snapshot?.buckets.first(where: { $0.id == selectedBucket }) ?? snapshot?.buckets.first }
    var usd: Double? { pricing == "fast" ? payload?.fastUsd : payload?.standardUsd }
    var old: Bool {
        guard let fetched = snapshot?.fetchedAtMs else { return false }
        return !connected || snapshot?.status != "ready" || now.timeIntervalSince1970 * 1000 - fetched > 120_000
    }
    var status: String {
        guard let snapshot else { return message }
        if !connected { return "暫時無法更新 · 上次資料" }
        if snapshot.updating || manualRefreshing { return "更新中…" }
        switch snapshot.status {
        case "signed_out": return "請先在 Codex 登入"
        case "checking", "initializing": return "正在確認帳號…"
        case "offline": return "暫時無法更新"
        case "unavailable": return "尚無額度資料"
        default: return old ? "資料待更新" : "資料已更新"
        }
    }
    func window(_ slot: String) -> UsageWindow? { bucket?.windows.first(where: { $0.slot == slot }) }
    var tooltip: String {
        "Codex 用量（剩餘）\n上行：短期 \(percentage(window("primary")?.remainingPercent))\n下行：每週 \(percentage(window("secondary")?.remainingPercent))\n聊天 Token \(compactTokens(snapshot?.tokens.chat?.totalTokens)) · \(dollarText(usd)) API 等值\n\(status)\n點一下展開；右鍵可退出"
    }
    func start() {
        timer = Timer.publish(every: 30, on: .main, in: .common).autoconnect().sink { [weak self] date in
            self?.now = date; self?.changes?()
        }
        stream = Task { [weak self] in await self?.connectLoop() }
    }
    func connectLoop() async {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 40
        config.timeoutIntervalForResource = 86_400
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        var failures = 0
        while !Task.isCancelled {
            do {
                try await backend.ensureRunning()
                let url = backend.base.appendingPathComponent("api/native/events").appending(queryItems: [URLQueryItem(name: "id", value: panelId), URLQueryItem(name: "visible", value: "true"), URLQueryItem(name: "interval", value: "60")])
                let (bytes, response) = try await session.bytes(from: url)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw PanelError.unavailable }
                for try await line in bytes.lines {
                    try Task.checkCancellation()
                    guard line.hasPrefix("data: "), line.utf8.count <= 128_000, let data = line.dropFirst(6).data(using: .utf8) else { continue }
                    let next = try JSONDecoder().decode(NativePayload.self, from: data)
                    payload = next; connected = true; now = Date(); failures = 0; changes?()
                }
                throw PanelError.unavailable
            } catch is CancellationError { break }
            catch {
                if Task.isCancelled { break }
                connected = false; failures += 1
                if case PanelError.missingNode = error { message = "找不到 Node.js；請安裝 22.18 以上版本" }
                else if case PanelError.incompatibleService = error { message = "請先停止舊版用量面板，再重新開啟" }
                else { message = "用量服務暫時無法連線，會自動重試" }
                changes?()
                let delay = [15, 30, 60, 120, 300][min(failures - 1, 4)]
                try? await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000_000)
            }
        }
    }
    func post(_ path: String, input: [String: Any]) async throws {
        var request = URLRequest(url: backend.base.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("http://127.0.0.1:4317", forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: input)
        let (_, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw PanelError.unavailable }
    }
    func refresh() {
        guard !manualRefreshing else { return }
        manualRefreshing = true
        Task {
            defer { manualRefreshing = false }
            do { try await post("api/usage/refresh", input: [:]) }
            catch { connected = false; changes?() }
        }
    }
    func saveTracking(_ value: String) {
        let id = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if !id.isEmpty && UUID(uuidString: id) == nil { trackingMessage = "請輸入完整的聊天 ID"; return }
        Task {
            do { try await post("api/tracking", input: ["threadId": id.isEmpty ? NSNull() : id]); trackingMessage = "已儲存追蹤設定" }
            catch { trackingMessage = "無法儲存，請稍後重試" }
        }
    }
    func stop() { stream?.cancel(); timer?.cancel(); backend.stopOwnedProcess() }
}
