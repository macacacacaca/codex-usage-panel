import Foundation

@main struct ModelTests {
    @MainActor
    static func main() throws {
        precondition(percentage(nil) == "—")
        precondition(percentage(0) == "0%")
        precondition(percentage(0.5) == "<1%")
        precondition(percentage(94.9) == "94%")
        precondition(dollarText(nil) == "—")
        precondition(dollarText(0.001) == "< US$0.01")
        precondition(dollarText(2.311115) == "US$2.31")
        precondition(resetCountdown(nil) == "重置時間未提供")
        precondition(resetCountdown(1000, now: Date(timeIntervalSince1970: 1)) == "正在確認重置…")
        let fixture = #"{"snapshot":{"status":"signed_out","planLabel":null,"fetchedAtMs":null,"buckets":[],"updating":false,"tokens":{"trackingId":null,"chat":null,"chatErrorCode":null,"lifetimeTokens":null},"errorCode":"auth_required"},"standardUsd":null,"fastUsd":null,"priceDate":"2026-10-08"}"#
        let decoded = try JSONDecoder().decode(NativePayload.self, from: Data(fixture.utf8))
        precondition(decoded.snapshot.buckets.isEmpty && decoded.standardUsd == nil && decoded.snapshot.tokens.period == nil)
        let periodFixture = #"{"snapshot":{"status":"ready","planLabel":"Plus","fetchedAtMs":1000,"buckets":[{"id":"codex","label":"Codex","serverLimitState":null,"windows":[{"slot":"primary","label":"5 小時額度","provided":true,"usedPercent":10,"remainingPercent":90,"durationMins":300,"resetsAtMs":18001000}]}],"updating":false,"tokens":{"lifetimeTokens":999999,"account":{"totalTokens":888888},"period":{"inputTokens":100,"cachedInputTokens":50,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5,"totalTokens":120,"updatedAtMs":1000,"complete":true,"sessionCount":2,"window":{"startAtMs":1000,"endAtMs":18001000,"windowMinutes":300}},"periodErrorCode":null},"errorCode":null},"standardUsd":2,"fastUsd":4,"priceDate":"2026-10-08"}"#
        let periodPayload = try JSONDecoder().decode(NativePayload.self, from: Data(periodFixture.utf8))
        let model = UsageModel()
        model.payload = periodPayload; model.now = Date(timeIntervalSince1970: 1); model.pricing = "standard"
        precondition(model.period?.sessionCount == 2 && model.period?.totalTokens == 120 && model.usd == 2)
        precondition(model.tooltip.contains("本次 5 小時 Token 120") && !model.tooltip.contains("999999"))
        model.now = Date(timeIntervalSince1970: 18_001)
        precondition(model.period == nil && model.usd == nil)
        model.now = Date(timeIntervalSince1970: 0)
        precondition(model.period == nil && model.usd == nil)
        model.now = Date(timeIntervalSince1970: 1)
        model.payload = try JSONDecoder().decode(NativePayload.self, from: Data(periodFixture.replacingOccurrences(of: "\"complete\":true", with: "\"complete\":false").utf8))
        precondition(model.period?.totalTokens == 120 && model.usd == nil)
        model.payload = try JSONDecoder().decode(NativePayload.self, from: Data(periodFixture.replacingOccurrences(of: "\"resetsAtMs\":18001000", with: "\"resetsAtMs\":null").utf8))
        precondition(model.period == nil && model.usd == nil)
        model.payload = try JSONDecoder().decode(NativePayload.self, from: Data(periodFixture.replacingOccurrences(of: "\"resetsAtMs\":18001000", with: "\"resetsAtMs\":18002000").utf8))
        precondition(model.period == nil && model.usd == nil)
        model.payload = try JSONDecoder().decode(NativePayload.self, from: Data(periodFixture.replacingOccurrences(of: "\"windowMinutes\":300", with: "\"windowMinutes\":10080").utf8))
        precondition(model.period == nil && model.usd == nil)
        let emptyPeriod = #"{"inputTokens":0,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":0,"reasoningOutputTokens":0,"totalTokens":0,"updatedAtMs":null,"complete":true,"sessionCount":0,"window":{"startAtMs":1000,"endAtMs":18001000,"windowMinutes":300}}"#
        var emptyObject = try JSONSerialization.jsonObject(with: Data(periodFixture.utf8)) as! [String: Any]
        var emptySnapshot = emptyObject["snapshot"] as! [String: Any]
        var emptyTokens = emptySnapshot["tokens"] as! [String: Any]
        emptyTokens["period"] = try JSONSerialization.jsonObject(with: Data(emptyPeriod.utf8))
        emptySnapshot["tokens"] = emptyTokens; emptyObject["snapshot"] = emptySnapshot
        emptyObject["standardUsd"] = 0; emptyObject["fastUsd"] = 0
        model.payload = try JSONDecoder().decode(NativePayload.self, from: JSONSerialization.data(withJSONObject: emptyObject))
        precondition(model.period?.totalTokens == 0 && model.period?.sessionCount == 0 && model.usd == 0)
        precondition(compactTokens(model.period?.totalTokens) == "0" && dollarText(model.usd) == "US$0.00")
        model.payload = decoded
        precondition(model.period == nil && model.usd == nil)
        let resources = URL(fileURLWithPath: "/Applications/Example.app/Contents/Resources")
        let home = URL(fileURLWithPath: "/Users/example")
        let bundledNode = resources.appendingPathComponent("Runtime/node")
        precondition(findNodeExecutable(resourceRoot: resources, home: home, isExecutable: { _ in true }) == bundledNode)
        precondition(findNodeExecutable(resourceRoot: resources, home: home, isExecutable: { $0 == "/opt/homebrew/bin/node" })?.path == "/opt/homebrew/bin/node")
        let sourceNode = home.appendingPathComponent(".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node")
        precondition(findNodeExecutable(resourceRoot: resources, home: home, isExecutable: { $0 == sourceNode.path }) == sourceNode)
        precondition(findNodeExecutable(resourceRoot: resources, home: home, isExecutable: { _ in false }) == nil)
        let path = backendExecutablePath(resourceRoot: resources, inheritedPath: "/usr/bin:/bin:/usr/local/bin:/custom/bin")
        precondition(path == resources.appendingPathComponent("Runtime").path + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/custom/bin")
        precondition(backendExecutablePath(resourceRoot: resources, inheritedPath: nil).hasSuffix(":/usr/bin:/bin:/usr/sbin:/sbin"))
        precondition(!backendExecutablePath(resourceRoot: resources, inheritedPath: ":/usr/bin::").contains("::"))
        print("Native data/format and runtime discovery checks passed.")
    }
}
