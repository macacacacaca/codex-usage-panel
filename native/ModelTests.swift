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
        print("Native data/format boundary checks passed.")
    }
}
