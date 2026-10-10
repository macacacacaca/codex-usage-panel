import Foundation

struct UsageWindow: Decodable {
    let slot: String
    let label: String
    let provided: Bool
    let usedPercent: Double?
    let remainingPercent: Double?
    let resetsAtMs: Double?
}
struct UsageBucket: Decodable {
    let id: String
    let label: String
    let serverLimitState: String?
    let windows: [UsageWindow]
}
struct ChatTokens: Decodable {
    let inputTokens: Int64
    let cachedInputTokens: Int64
    let cacheWriteInputTokens: Int64
    let outputTokens: Int64
    let reasoningOutputTokens: Int64
    let totalTokens: Int64
    let updatedAtMs: Double?
    let complete: Bool
}
struct TokenProfile: Decodable {
    let trackingId: String?
    let chat: ChatTokens?
    let chatErrorCode: String?
    let lifetimeTokens: Int64?
}
struct UsageSnapshot: Decodable {
    let status: String
    let planLabel: String?
    let fetchedAtMs: Double?
    let buckets: [UsageBucket]
    let updating: Bool
    let tokens: TokenProfile
    let errorCode: String?
}
struct NativePayload: Decodable {
    let snapshot: UsageSnapshot
    let standardUsd: Double?
    let fastUsd: Double?
    let priceDate: String
}

func percentage(_ value: Double?) -> String {
    guard let value, value.isFinite else { return "—" }
    if value > 0 && value < 1 { return "<1%" }
    return "\(Int(value.rounded(.down)))%"
}
func compactTokens(_ value: Int64?) -> String {
    guard let value else { return "—" }
    if value >= 1_000_000_000 { return String(format: "%.2fB", Double(value) / 1_000_000_000) }
    if value >= 1_000_000 { return String(format: "%.2fM", Double(value) / 1_000_000) }
    if value >= 1_000 { return String(format: "%.2fK", Double(value) / 1_000) }
    return String(value)
}
func dollarText(_ value: Double?) -> String {
    guard let value else { return "—" }
    if value > 0 && value < 0.01 { return "< US$0.01" }
    return String(format: "US$%.2f", value)
}
func resetCountdown(_ time: Double?, now: Date = Date()) -> String {
    guard let time else { return "重置時間未提供" }
    let difference = time / 1000 - now.timeIntervalSince1970
    if difference <= 0 { return "正在確認重置…" }
    if difference < 60 { return "即將重置" }
    let minutes = Int(ceil(difference / 60)), days = minutes / 1440, hours = minutes % 1440 / 60, mins = minutes % 60
    if days > 0 { return "\(days) 天\(hours > 0 ? " \(hours) 小時" : "")後重置" }
    if hours > 0 { return "\(hours) 小時\(mins > 0 ? " \(mins) 分" : "")後重置" }
    return "\(mins) 分後重置"
}
func localTime(_ milliseconds: Double?, includeDay: Bool = true) -> String {
    guard let milliseconds else { return "—" }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "zh_TW")
    formatter.timeZone = TimeZone(identifier: "Asia/Taipei")
    formatter.dateFormat = includeDay ? "MM/dd HH:mm" : "HH:mm:ss"
    return formatter.string(from: Date(timeIntervalSince1970: milliseconds / 1000))
}
