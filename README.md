# Codex 用量：macOS 選單列

原生 macOS 選單列工具。上方選單列常駐 **32 pt 寬的兩行小百分比**：上行是短期剩餘，下行是每週剩餘。點一下展開 336 × 330 pt 的小面板，包含重置倒數、聊天累計 Token 與美元等值。介面使用 SwiftUI／AppKit，沒有 WebView，不需要開瀏覽器。使用繁體中文、台北時間，跟隨 macOS 明暗外觀。

## 使用截圖

<img src="docs/screenshots/usage-panel.png" alt="Codex 用量面板：macOS 選單列顯示短期與每週剩餘百分比；展開後顯示重置倒數、聊天累計 Token 與 API 美元等值。" width="360">

截圖為實際使用畫面，數值與重置時間會隨帳號用量更新。美元等值是 API 單價換算，並非訂閱帳單。

## 從原始碼安裝

需要 macOS **13 以上**、Node.js **22.18 以上**、Apple Command Line Tools（Swift），以及已完成 ChatGPT 登入的 Codex CLI。程式沒有第三方 npm 依賴，無需執行 `npm install`。

```sh
git clone https://github.com/macacacacaca/codex-usage-panel.git
cd codex-usage-panel
npm run build:native
open outputs/CodexUsage.app
```

若尚未安裝 Apple Command Line Tools，可執行 `xcode-select --install`。若 Codex CLI 尚未登入，可執行 `codex login`；也可沿用本機 Codex／ChatGPT App 管理的登入。

建置會依本機架構產生 Apple Silicon 或 Intel App，存放於 `outputs/CodexUsage.app`。App 使用 ad-hoc 簽章。首次啟動後，可在齒輪設定貼上要追蹤的聊天 ID。

## 開啟與停止

1. 建置後雙擊 `outputs/CodexUsage.app`，或 [啟動用量面板.command](./啟動用量面板.command)（首次會自動建置）。啟動會自動展開；以後從 macOS 上方選單列的 **兩行百分比**點開。App 已在執行時，再次開啟 App 也會展開面板。
2. 點選單列數字展開／收起，也可按面板右上角 × 或 Escape 收起；右鍵可展開或退出。App 不佔 Dock，也不需要終端機保持開啟。
3. 在右上角設定點「退出」，或雙擊 [停止用量面板.command](./停止用量面板.command)。App 會停止自己啟動的資料服務；沿用其他實例時，不會終止其他實例。
4. 重開只需再次雙擊 App。未設定登入時自動啟動；目前不會改動系統登入項目。

若選單列被其他 App 的選單或螢幕瀏海擠掉，先切到 Finder（不必退出 GPT），按住 **⌘ 拖曳兩行百分比到時鐘附近**。原生 `NSStatusItem.autosaveName` 會保留拖曳位置；系統選單列沒有公開的 API 可強制指定最右側或保證不被遮住。

「Token 明細」切換到獨立頁面，輸入、快取、輸出、總計與美元數值從頂部開始顯示；用左上角返回。齒輪設定也是獨立頁面。沒有取得 Token 紀錄時會顯示原因與設定入口。

0.3.2 視覺版參考 [Reflect 的 Awwwards 設計紀錄](https://www.awwwards.com/sites/reflect)，採深色／淺色自適應底色、淡紫／霧藍細進度條、細邊框與分離的數字／百分比字級。點主畫面的整張 Token 卡片查看明細；API Standard／Fast 情境與退出入口移至右上角的設定頁。尺寸仍是 336 × 330 pt，選單列仍為 32 pt。

App 自動管理本機資料服務，HTTP/SSE 只作內部資料傳輸；使用者不用開網址。原生版本的程序記錄、追蹤 ID 與非敏感啟動日誌在 `~/Library/Application Support/CodexUsage/runtime/`。原生單價偏好由 UserDefaults 保存；Token 不另存。遇到舊版服務佔用 4317 時，先用停止檔退出舊版，再開 App。

本機驗證使用 Node.js **24.21.0** 與 Apple Silicon。CLI 優先使用本機 Codex/ChatGPT App 附帶的執行檔。

原生 App 使用 4317；可沿用同版本且提供原生端點的現有服務。建議只開一個用量工具。原生 App 並非 Codex App 原生頂欄擴充，而是獨立的 macOS 選單列 App。

## 資料功能與保留的網頁測試版

原生版固定每 60 秒更新帳號額度，選單列常駐視為可見；本機 Token 每 10 秒讀取。網頁版仍可用 `npm start` 或「啟動網頁測試版.command」做開發驗證，以下更新週期／瀏覽器設定與 Alt+R 條目是網頁版功能。

- 依資料來源顯示短期、長期視窗與其他額度分類，百分比及進度條均為**剩餘**。
- 可見時依設定每 30／60／120 秒更新；隱藏超過 1 分鐘後每 5 分鐘更新。多面板採可見面板中最短的週期。
- 背景更新不清空卡片；失敗保留已確認身份的上次快照。120 秒未成功讀取即標示上次資料。
- 倒數每 30 秒從絕對重置時間計算；到零時服務再次讀取，讀取成功前不補滿額度。
- 手動重新整理、SSE 即時狀態、一次完整讀取的 15 秒期限、15／30／60／120／300 秒退避與 jitter。
- 系統／淺色／深色主題、時區、更新週期保存在瀏覽器；額度與帳號資料只存在程序記憶體。
- 設定使用原生對話框、Escape 關閉；Tab 操作全部控制項，**Alt+R** 重新整理。倒數不使用讀屏即時播報。
- 可用重置次數只有來源提供時才顯示，不能在面板使用或購買額度。
- 聊天 Token 每 10 秒讀取本機新增紀錄，不增加帳號 API 的輪詢頻率；可切換 API Standard／Fast 美元換算。

## Token 與美元等值

主畫面的「聊天累計 Token」追蹤固定的一個聊天。建置 App 不會讀取或打包本機追蹤 ID；初次使用請在右上角設定貼上聊天 ID，之後沿用自己的 runtime 設定。留空可停止追蹤；ID 可從 `codex://threads/<ID>` 連結取得。網頁開發版使用 `.runtime/tracking.json` 與 `CODEX_THREAD_ID`，可用 `CODEX_USAGE_THREAD_ID=<UUID> npm start` 明確指定。切換 Codex 聊天不會自動更換追蹤目標。

服務在 Codex 的 `sessions/` JSONL 紀錄中，只保留工作階段身份、模型與 `token_count` 計數器。先核對紀錄 ID，以及 `creator_account_id` 與目前已確認帳號的用量 `accountId`，不符合時隱藏 Token。採增量讀取，重複事件不重複累加；截斷、缺失、模型切換與未完成記錄會重新核對。一般聊天訊息會跳過，不送到前端、日誌或其他服務。Token 不另存檔。

「美元等值估算」依 [官方 API 單價](https://developers.openai.com/api/docs/pricing)換算，**並非 ChatGPT／Codex 訂閱帳單或實際費用**。預設是 API Standard 情境，設定可選 Fast（2 倍）；這是使用者選擇的計價情境，不代表紀錄中的執行速度。目前核對日期為 **2026-10-08**，支援 `gpt-6.1-sol`、`gpt-6-astra`、`gpt-6-luna`。單次請求輸入超過 272,000 Token 時，輸入／快取／寫入乘 2、輸出乘 1.5，再依選擇的情境計算。

計算公式：`(一般輸入 × 輸入單價 + 快取輸入 × 快取單價 + 快取寫入 × 寫入單價 + 輸出 × 輸出單價) ÷ 1,000,000`。一般輸入已扣除快取與寫入；推理 Token 包含在輸出中，不再加一次。缺少完整模型、拆分、事件或單次請求長度時顯示「—」，不顯示不完整的價格。估算未含工具、儲存、地區附加費等項目；單價變動後需更新 `src/tokens.ts`。

明細中的帳號歷史總量與來源日期分桶，來自 `account/usage/read`。來源可能尚未包含當天用量；日期照原始資料顯示，不能視為台北「今日」統計。因缺少模型與輸入／輸出拆分，帳號總量不換算美元。

## 登入與資料來源

資料來自官方 [Codex App Server](https://learn.chatgpt.com/docs/app-server)，啟動 `codex app-server --listen stdio://`，完成 `initialize`／`initialized` 握手。adapter 只允許 `initialize`、`account/read`、`account/rateLimits/read`、`account/usage/read`；不建立模型對話。Token 歷史端點失敗不會使額度功能失效。

面板沿用 Codex CLI 管理的 ChatGPT 登入，不讀取或複製憑證檔。若未登入，在終端機執行 `codex login`，完成官方流程後重新整理。API key 或 Bedrock 登入不提供本面板所需訂閱額度，會顯示說明。

每次讀取前後確認 `account/read` 的登入身份，並要求額度回應提供 `accountId`。原始 email 只在記憶體內計算身份摘要，`accountId` 只用於內部隔離，兩者均不傳到前端或日誌。身份無法確認、登入通知與 App Server 中斷時清除舊資料。暫時的額度讀取失敗可保留同一個已確認登入工作階段的快照。

服務只綁定 `127.0.0.1`；檢查 Host、Origin 與跨站請求，不開放 CORS，POST 要求同源 JSON。頁面僅接受自己的程式與樣式，API 僅輸出正規化後的額度與 Token 資訊。`.runtime/` 只存放程序、實例與選擇的聊天 ID，沒有帳號快照、Token 快照或憑證。不要將此服務透過反向代理公開到網路。

## 開發與驗證

```sh
npm run probe  # 唯讀連線診斷，僅輸出方案、視窗與是否有身份欄位
npm run probe -- --tokens  # 加入正規化後的 Token 端點診斷
npm run build  # Node 原生 TypeScript 型別移除，產生瀏覽器 JavaScript
npm run build:native  # SwiftUI/AppKit 原生 App，打包資料服務並 ad-hoc 簽章
npm test       # 資料正規化、時間邊界、隔離、恢復、程序清理、HTTP 邊界
npm run security:check  # Git index／完整歷史敏感資訊掃描，初次需下載校驗過的掃描器
npm run demo  # 明確標示「示範模式」，不啟動 Codex App Server
```

`native/` 提供選單列 App、原生視圖、SSE 客戶端與服務程序管理。`src/native.ts` 產生原生資料封包，與網頁介面共用美元公式。`src/adapter.ts` 管理 JSONL RPC；`src/service.ts` 管理身份、共享輪詢、快照與恢復；`src/domain.ts` 是額度轉換；`src/tokens.ts` 提供 Token 正規化與價格公式；`src/local-tokens.ts` 核對與增量讀取聊天紀錄；`src/client.ts` 為網頁介面。`outputs/CodexUsage.app` 是可直接使用的 App，`web/`／`dist/` 是保留的網頁測試版。

2026-10-10 重新執行 `npm test`：**25 項通過、0 項失敗**，涵蓋資料正規化、帳號隔離、Token 計算、程序清理、HTTP 邊界、私人檔案權限與原生資料端點。

`outputs/`、`.runtime/`、`dist/` 與環境變數檔由 `.gitignore` 排除。公開的使用截圖放在 `docs/screenshots/`；App 與其他本機驗收資料由使用者自行建置或保留。

資安防護、資料範圍與回報注意事項請見 [SECURITY.md](./SECURITY.md)。

## 已知限制

- Codex CLI / App Server 協定仍會變動；本版核對 CLI **0.162.0-alpha.2** 產生的 TypeScript schema，更新 CLI 後應重跑連線與驗收。
- `account/read` 本版 schema 未提供獨立的帳號 ID；本面板使用登入 email 摘要加上用量回應 `accountId`，並核對讀取前後身份。任一身份欄位缺失即不展示額度。
- 獨立 App Server 不保證收到其他客戶端產生的用量通知，因此保留輪詢；稀疏通知一律觸發完整重讀。
- 原生選單列與 Codex 分開執行；沒有自動跟隨正在開啟的聊天，追蹤目標可由設定更換。
- 沒有桌面通知、歷史趨勢或購買／消耗重置次數功能。
- 背景瀏覽器計時器可能被節流；共享服務仍負責輪詢，重新可見與電腦喚醒會主動更新。
