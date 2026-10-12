import SwiftUI

private enum PanelStyle {
    static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let hex = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: CGFloat((hex >> 16) & 255) / 255,
                           green: CGFloat((hex >> 8) & 255) / 255,
                           blue: CGFloat(hex & 255) / 255, alpha: 1)
        })
    }
    static let canvas = adaptive(0xF7F7FB, 0x15141B)
    static let surface = adaptive(0xFFFFFF, 0x1E1D27)
    static let ink = adaptive(0x24212E, 0xF1EFF7)
    static let muted = adaptive(0x6E697B, 0xA39DB2)
    static let line = adaptive(0xE5E1ED, 0x37323F)
    static let accent = adaptive(0x7052C8, 0xB5A1F3)
    static let secondaryAccent = adaptive(0x7383AE, 0x9AABD4)
    static let good = adaptive(0x467B65, 0x8EC5A8)
    static let warning = adaptive(0x986119, 0xE6B979)
    static let danger = adaptive(0xB84650, 0xEF9CA6)
}

struct UsageView: View {
    enum Page { case overview, details, settings }
    @ObservedObject var model: UsageModel
    @State private var page = Page.overview

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            switch page {
            case .overview: overview
            case .details: tokenDetails
            case .settings: settings
            }
        }
        .padding(14)
        .frame(width: 336, height: 330, alignment: .topLeading)
        .foregroundStyle(PanelStyle.ink)
        .background {
            PanelStyle.canvas
            LinearGradient(colors: [PanelStyle.accent.opacity(0.035), .clear], startPoint: .topLeading, endPoint: .bottomTrailing)
        }
        .onExitCommand { model.closePanel?() }
    }

    var header: some View {
        HStack(spacing: 8) {
            if page == .overview {
                ZStack {
                    RoundedRectangle(cornerRadius: 7).fill(PanelStyle.accent.opacity(0.12))
                    RoundedRectangle(cornerRadius: 7).strokeBorder(PanelStyle.accent.opacity(0.2), lineWidth: 0.5)
                    Text("C").font(.system(size: 12, weight: .semibold, design: .monospaced)).foregroundStyle(PanelStyle.accent)
                }.frame(width: 24, height: 24).accessibilityHidden(true)
            } else {
                PanelIconButton(symbol: "chevron.left", label: "返回用量") { page = .overview }
            }
            Text(page == .overview ? "Codex" : page == .details ? "本次 5 小時明細" : "設定")
                .font(.system(size: 13, weight: .semibold))
            if page == .overview, let plan = model.snapshot?.planLabel {
                Text(plan).font(.system(size: 9, weight: .medium)).foregroundStyle(PanelStyle.muted)
                    .padding(.horizontal, 6).padding(.vertical, 3)
                    .background(PanelStyle.surface, in: Capsule())
                    .overlay(Capsule().strokeBorder(PanelStyle.line, lineWidth: 0.5))
            }
            Spacer(minLength: 0)
            HStack(spacing: 2) {
                PanelIconButton(symbol: "arrow.clockwise", label: "重新整理用量", action: model.refresh)
                    .disabled(model.manualRefreshing || model.snapshot?.updating == true)
                if page != .settings {
                    PanelIconButton(symbol: "slider.horizontal.3", label: "設定單價與更新", action: openSettings)
                }
                PanelIconButton(symbol: "xmark", label: "收起面板") { model.closePanel?() }
            }
        }.frame(height: 24)
    }

    var overview: some View {
        VStack(alignment: .leading, spacing: 10) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let buckets = model.snapshot?.buckets, buckets.count > 1 {
                        Picker("額度分類", selection: $model.selectedBucket) {
                            ForEach(buckets, id: \.id) { Text($0.label).tag($0.id) }
                        }.font(.system(size: 11))
                    }
                    HStack(alignment: .top, spacing: 10) {
                        QuotaView(window: model.window("primary"), fallback: "短期額度", limited: model.bucket?.serverLimitState != nil, old: model.old, now: model.now, accent: PanelStyle.accent)
                        QuotaView(window: model.window("secondary"), fallback: "每週額度", limited: model.bucket?.serverLimitState != nil, old: model.old, now: model.now, accent: PanelStyle.secondaryAccent)
                    }
                    Button { page = .details } label: { tokenSummary }
                        .buttonStyle(TokenCardStyle())
                        .help("查看本次 5 小時的輸入、快取、輸出與價格明細")
                        .accessibilityLabel("查看本次 5 小時明細，\(compactTokens(model.period?.totalTokens)) Token，美元等值 \(dollarText(model.usd))")
                }.padding(1)
            }.scrollIndicators(.hidden)
            HStack(spacing: 5) {
                Circle().fill(model.connected && !model.old ? PanelStyle.good : PanelStyle.warning).frame(width: 4, height: 4)
                Text(model.status).lineLimit(1)
                Spacer(minLength: 2)
                Text(localTime(model.snapshot?.fetchedAtMs, includeDay: false)).monospacedDigit()
                    .help("額度每 60 秒更新；Token 每 10 秒讀取。台北時間。")
            }.font(.system(size: 9.5)).foregroundStyle(PanelStyle.muted)
        }
    }

    var tokenSummary: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .top, spacing: 12) {
                metric("本次 5 小時 Token", compactTokens(model.period?.totalTokens))
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 4) {
                        Text("本次美元等值").font(.system(size: 10)).foregroundStyle(PanelStyle.muted)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.system(size: 8, weight: .semibold)).foregroundStyle(PanelStyle.muted)
                    }
                    Text(dollarText(model.usd)).font(.system(size: 22, weight: .medium)).tracking(-0.4).monospacedDigit()
                        .lineLimit(1).minimumScaleFactor(0.75)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            Text(tokenNote).font(.system(size: 9.5)).foregroundStyle(PanelStyle.muted)
                .fixedSize(horizontal: false, vertical: true)
        }.padding(12)
        .background(PanelStyle.surface, in: RoundedRectangle(cornerRadius: 11))
        .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(PanelStyle.line, lineWidth: 0.5))
    }

    func metric(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label).font(.system(size: 10)).foregroundStyle(PanelStyle.muted)
            Text(value).font(.system(size: 22, weight: .medium)).tracking(-0.4).monospacedDigit()
                .lineLimit(1).minimumScaleFactor(0.75)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    var tokenDetails: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 12) {
                    metric(model.period?.complete == false ? "可核對 Token 小計" : "本次 5 小時 Token", model.period?.totalTokens.formatted(.number) ?? "—")
                    metric("本次美元等值", dollarText(model.usd))
                }.padding(.bottom, 2)
                if let chat = model.period {
                    detail("區間開始（台北）", localTime(chat.window.startAtMs))
                    detail("區間結束（台北）", localTime(chat.window.endAtMs))
                    Text("目前帳號 · 本區間 \(chat.sessionCount) 個本機聊天")
                        .font(.system(size: 10, weight: .medium)).foregroundStyle(PanelStyle.muted)
                    VStack(spacing: 6) {
                        detail(chat.complete ? "本次 Token 總計" : "可核對 Token 小計", chat.totalTokens)
                        detail("一般輸入", chat.inputTokens - chat.cachedInputTokens - chat.cacheWriteInputTokens)
                        detail("快取輸入", chat.cachedInputTokens)
                        detail("快取寫入", chat.cacheWriteInputTokens)
                        Rectangle().fill(PanelStyle.line).frame(height: 0.5)
                        detail("輸出（含推理）", chat.outputTokens)
                        detail("其中推理", chat.reasoningOutputTokens)
                    }.padding(10)
                    .background(PanelStyle.surface, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(PanelStyle.line, lineWidth: 0.5))
                    HStack {
                        Text("每 10 秒讀取本機新紀錄")
                        Spacer()
                        Text(localTime(chat.updatedAtMs))
                    }.font(.system(size: 9.5)).foregroundStyle(PanelStyle.muted)
                } else {
                    Text(tokenNote).font(.system(size: 12, weight: .medium))
                    Text("取得有效的 5 小時額度區間後，會自動加總目前帳號在區間內的本機紀錄。")
                        .font(.system(size: 11)).foregroundStyle(PanelStyle.muted)
                }
                Text("Token 與美元均只計本次 5 小時區間內的本機紀錄，不含其他裝置；API 等值非訂閱帳單。推理已計入輸出。")
                    .font(.system(size: 10)).foregroundStyle(PanelStyle.muted).fixedSize(horizontal: false, vertical: true)
                if model.period?.complete == false || model.snapshot?.tokens.periodErrorCode == "period_logs_incomplete" {
                    Text("資料不完整，僅顯示可核對的 Token 小計，美元等值暫不估算。")
                        .font(.system(size: 10)).foregroundStyle(PanelStyle.muted)
                }
                detail("單價核對", model.payload?.priceDate ?? "—")
            }.padding(1)
        }.scrollIndicators(.hidden)
    }

    var settings: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 7) {
                    Text("跟隨目前帳號").font(.system(size: 11, weight: .semibold))
                    Text("依官方重置時間加總本次 5 小時內的本機紀錄，切換聊天不需設定 ID。帳號切換或登出時會清除舊資料。")
                        .font(.system(size: 10)).foregroundStyle(PanelStyle.muted)
                    Text("本次 Token 與美元使用相同區間；其他裝置的紀錄不在統計內。區間重置後會重新確認。")
                        .font(.system(size: 10)).foregroundStyle(PanelStyle.muted)
                }
                VStack(alignment: .leading, spacing: 7) {
                    Text("美元估算情境").font(.system(size: 11, weight: .semibold))
                    HStack(spacing: 2) {
                        priceOption("Standard", value: "standard")
                        priceOption("Fast × 2", value: "fast")
                    }.padding(3).background(PanelStyle.surface, in: RoundedRectangle(cornerRadius: 8))
                    Text("依 API 單價換算，非 ChatGPT 訂閱帳單。")
                        .font(.system(size: 10)).foregroundStyle(PanelStyle.muted)
                }
                Rectangle().fill(PanelStyle.line).frame(height: 0.5)
                Text("選單列上行是短期、下行是每週剩餘。若被擠掉，可按住 ⌘ 拖到時鐘附近，位置會保留。")
                    .font(.system(size: 10)).foregroundStyle(PanelStyle.muted).fixedSize(horizontal: false, vertical: true)
                HStack {
                    Text("帳號 60 秒 · 本機 Token 10 秒").foregroundStyle(PanelStyle.muted)
                    Spacer()
                    Button("退出") { NSApplication.shared.terminate(nil) }.buttonStyle(.plain).foregroundStyle(PanelStyle.muted)
                }.font(.system(size: 10))
            }.padding(1)
        }.scrollIndicators(.hidden)
    }

    func priceOption(_ title: String, value: String) -> some View {
        Button { model.pricing = value } label: {
            Text(title).font(.system(size: 11, weight: model.pricing == value ? .medium : .regular))
                .foregroundStyle(model.pricing == value ? PanelStyle.accent : PanelStyle.muted)
                .frame(maxWidth: .infinity).padding(.vertical, 5)
                .background(model.pricing == value ? PanelStyle.accent.opacity(0.13) : .clear, in: RoundedRectangle(cornerRadius: 6))
        }.buttonStyle(.plain).accessibilityLabel("API \(title) 美元估算")
            .accessibilityValue(model.pricing == value ? "已選取" : "未選取")
    }
    func openSettings() {
        page = .settings
    }
    var tokenNote: String {
        guard model.period != nil else {
            if model.snapshot == nil { return "正在讀取本次 5 小時 Token…" }
            if let period = model.snapshot?.tokens.period {
                return period.window.endAtMs <= model.now.timeIntervalSince1970 * 1000
                    ? "正在確認新的 5 小時區間…" : "尚無有效的 5 小時額度區間"
            }
            switch model.snapshot?.tokens.periodErrorCode {
            case "window_unavailable": return "尚無有效的 5 小時額度區間"
            case "window_expired": return "正在確認新的 5 小時區間…"
            case "no_token_events": return "目前帳號尚無可核對的本機紀錄"
            case "period_logs_incomplete": return "本次紀錄不完整 · 暫不估價"
            case "log_unavailable": return "暫時無法讀取本機 Token 紀錄"
            case "counter_overflow", "log_identity_mismatch": return "無法核對本次 Token 紀錄"
            default: return "正在取得本次 5 小時 Token"
            }
        }
        if model.period?.complete == false { return "本次可核對 Token 小計 · 資料不完整 · 暫不估價" }
        return "本次本機 \(model.pricing == "fast" ? "Fast × 2" : "Standard") 等值 · 非帳單\(model.usd == nil ? " · 資料不足" : "")"
    }
    func detail(_ name: String, _ value: Int64) -> some View { detail(name, value.formatted(.number)) }
    func detail(_ name: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(name).foregroundStyle(PanelStyle.muted)
            Spacer()
            Text(value).monospacedDigit().multilineTextAlignment(.trailing).textSelection(.enabled)
        }.font(.system(size: 10.5))
    }
}

private struct PanelIconButton: View {
    let symbol: String
    let label: String
    let action: () -> Void
    @State private var hovered = false
    @Environment(\.isEnabled) private var enabled
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 10.5, weight: .medium))
                .frame(width: 22, height: 22)
                .foregroundStyle(hovered ? PanelStyle.ink : PanelStyle.muted)
                .background(hovered ? PanelStyle.line.opacity(0.5) : .clear, in: RoundedRectangle(cornerRadius: 6))
                .contentShape(Rectangle())
        }.buttonStyle(.plain).opacity(enabled ? 1 : 0.4)
            .onHover { hovered = $0 }.help(label).accessibilityLabel(label)
    }
}

private struct TokenCardStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.8 : 1)
            .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(PanelStyle.accent.opacity(configuration.isPressed ? 0.5 : 0), lineWidth: 0.5))
            .contentShape(RoundedRectangle(cornerRadius: 11))
    }
}

struct QuotaView: View {
    let window: UsageWindow?
    let fallback: String
    let limited: Bool
    let old: Bool
    let now: Date
    let accent: Color
    var tone: Color {
        guard let remaining = window?.remainingPercent else { return PanelStyle.muted }
        return limited || remaining <= 10 ? PanelStyle.danger : remaining <= 30 ? PanelStyle.warning : accent
    }
    var warning: String? {
        guard let remaining = window?.remainingPercent else { return nil }
        return limited ? "使用受限" : remaining == 0 ? "已用完" : remaining <= 10 ? "接近上限" : remaining <= 30 ? "偏低" : nil
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 3) {
                Text((window?.label ?? fallback).replacingOccurrences(of: "額度", with: "").trimmingCharacters(in: .whitespaces) + "剩餘")
                    .font(.system(size: 10.5, weight: .medium)).foregroundStyle(PanelStyle.muted)
                Spacer(minLength: 0)
                if let warning { Text(warning).font(.system(size: 9)).foregroundStyle(tone) }
            }
            HStack(alignment: .firstTextBaseline, spacing: 2) {
                let text = percentage(window?.remainingPercent)
                Text(text.hasSuffix("%") ? String(text.dropLast()) : text)
                    .font(.system(size: 33, weight: .medium)).tracking(-0.8).monospacedDigit()
                if text.hasSuffix("%") { Text("%").font(.system(size: 15)).foregroundStyle(PanelStyle.muted) }
            }.opacity(old ? 0.65 : 1).accessibilityElement(children: .ignore)
                .accessibilityLabel("\(window?.label ?? fallback)剩餘 \(percentage(window?.remainingPercent))")
            GeometryReader { geometry in
                Capsule().fill(PanelStyle.line)
                Capsule().fill(tone).frame(width: geometry.size.width * max(0, min(100, window?.remainingPercent ?? 0)) / 100)
            }.frame(height: 3).padding(.vertical, 2)
                .opacity(window?.remainingPercent == nil ? 0.35 : old ? 0.65 : 1)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(resetCountdown(window?.resetsAtMs, now: now)).font(.system(size: 9.5)).lineLimit(1).minimumScaleFactor(0.85)
                Text(localTime(window?.resetsAtMs)).font(.system(size: 9.5)).monospacedDigit().foregroundStyle(PanelStyle.muted)
            }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
            .background {
                RoundedRectangle(cornerRadius: 11).fill(PanelStyle.surface)
                RoundedRectangle(cornerRadius: 11).fill(LinearGradient(colors: [accent.opacity(0.06), .clear], startPoint: .topLeading, endPoint: .bottomTrailing))
            }
            .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(PanelStyle.line, lineWidth: 0.5))
    }
}
