import Foundation

@main struct ModelTests {
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
        precondition(decoded.snapshot.buckets.isEmpty && decoded.standardUsd == nil && decoded.snapshot.tokens.chat == nil)
        let accountFixture = #"{"trackingId":null,"chat":null,"chatErrorCode":null,"lifetimeTokens":1000,"account":{"inputTokens":100,"cachedInputTokens":50,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5,"totalTokens":120,"updatedAtMs":1000,"complete":true,"sessionCount":2},"accountErrorCode":null}"#
        let account = try JSONDecoder().decode(TokenProfile.self, from: Data(accountFixture.utf8))
        precondition(account.account?.sessionCount == 2 && account.account?.totalTokens == 120 && account.lifetimeTokens == 1000)
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
