import { absoluteTime, countdown, emptySnapshot, isOld, normalizeWindow, percentText, quotaState, sameTokenWindow, tokenWindow, type Snapshot, type Bucket } from './domain.ts';
import { estimateUsd, tokenText, usdText, PRICES, PRICE_CHECKED_DATE } from './tokens.ts';

type Settings = { theme: 'system' | 'light' | 'dark'; timeZone: string; interval: number; pricing: 'standard' | 'fast' };
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const defaults: Settings = { theme: 'system', timeZone: 'Asia/Taipei', interval: 60, pricing: 'standard' };
let settings = { ...defaults };
try {
  const saved = JSON.parse(localStorage.getItem('codex-usage-settings') ?? '{}');
  if (['system', 'light', 'dark'].includes(saved.theme)) settings.theme = saved.theme;
  if ([30, 60, 120].includes(saved.interval)) settings.interval = saved.interval;
  if (['standard', 'fast'].includes(saved.pricing)) settings.pricing = saved.pricing;
  if (typeof saved.timeZone === 'string') { new Intl.DateTimeFormat('zh-TW', { timeZone: saved.timeZone }); settings.timeZone = saved.timeZone; }
} catch { /* Browser storage may be unavailable; default settings remain usable. */ }
let snapshot: Snapshot = emptySnapshot();
let selectedBucket = '';
let source: EventSource | null = null;
let connected = false;
let pending: Promise<void> | null = null;
let lastTick = Date.now();
let detailSignature = '';
const panelId = crypto.randomUUID();
const dialog = $<HTMLDialogElement>('settings-dialog');
const refreshButton = $<HTMLButtonElement>('refresh');

function text(id: string, value: string) { const element = $(id); if (element.textContent !== value) element.textContent = value; }
function bucket(): Bucket | undefined { return snapshot.buckets.find(b => b.id === selectedBucket) ?? snapshot.buckets[0]; }
function applySettings() {
  if (settings.theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
  try { localStorage.setItem('codex-usage-settings', JSON.stringify(settings)); } catch {}
  text('frequency', document.hidden ? '背景每 5 分鐘更新' : `每 ${settings.interval} 秒更新`);
  render();
}
function statusText(): string {
  if (snapshot.updating) return snapshot.fetchedAtMs === null ? '正在讀取用量…' : '更新中…';
  if (snapshot.status === 'ready') return isOld(snapshot) ? '資料待更新' : snapshot.demo ? '示範資料' : '資料已更新';
  return { initializing: '正在讀取用量…', checking: '正在確認帳號…', stale: '資料待更新', offline: snapshot.errorCode === 'local_service' || snapshot.errorCode === 'service_stopped' || snapshot.errorCode === 'cli_unavailable' ? '用量服務未啟動' : '暫時無法更新', signed_out: '請連接 Codex 帳號', unavailable: '尚無訂閱額度資料' }[snapshot.status];
}
function renderRecovery() {
  const code = snapshot.errorCode;
  const visible = ['offline', 'signed_out', 'unavailable'].includes(snapshot.status) || code === 'identity_unknown';
  $('recovery').hidden = !visible;
  if (!visible) return;
  let message = '暫時無法更新用量。', help = '服務會自動重試，也可以手動重新整理。';
  if (['local_service', 'service_stopped', 'cli_unavailable'].includes(code ?? '')) {
    message = '用量服務未啟動。'; help = '請雙擊專案中的「啟動用量面板.command」，啟動後此頁會自動重新連線。';
  } else if (snapshot.status === 'signed_out') {
    message = '請連接 Codex 帳號。'; help = '在終端機執行 codex login，完成官方登入後按「重試」。';
  } else if (code === 'unsupported_auth') {
    message = '此登入方式未提供訂閱額度。'; help = '請透過 codex login 使用 ChatGPT 帳號登入，再重新整理。';
  } else if (code === 'identity_unknown') {
    message = '無法確認目前帳號，已清除先前數字。'; help = '請確認 Codex CLI 已登入，再按「重試」。';
  } else if (code === 'no_usage') { message = '此帳號未提供訂閱額度視窗。'; }
  if (snapshot.fetchedAtMs !== null) message += ' 以下為上次資料。';
  text('recovery-text', message); text('recovery-help', help);
}
function render() {
  const current = bucket();
  const old = isOld(snapshot);
  text('account', snapshot.planLabel ? `目前帳號 · ${snapshot.planLabel}` : '目前帳號');
  text('connection', statusText());
  $('connection').dataset.state = old && snapshot.status === 'ready' ? 'stale' : snapshot.status;
  $('demo-note').hidden = !snapshot.demo;
  refreshButton.disabled = snapshot.updating || pending !== null;
  refreshButton.setAttribute('aria-busy', String(snapshot.updating || pending !== null));
  const selector = $<HTMLSelectElement>('bucket');
  const signature = snapshot.buckets.map(b => `${b.id}:${b.label}`).join('|');
  if (selector.dataset.signature !== signature) {
    selector.replaceChildren(...snapshot.buckets.map(b => { const option = document.createElement('option'); option.value = b.id; option.textContent = b.label; return option; }));
    selector.dataset.signature = signature;
  }
  if (current) { selectedBucket = current.id; selector.value = current.id; }
  $('bucket-row').hidden = snapshot.buckets.length <= 1;
  for (const slot of ['primary', 'secondary'] as const) {
    const window = current?.windows.find(w => w.slot === slot) ?? normalizeWindow(null, slot);
    const state = quotaState(window.remainingPercent, current?.serverLimitState);
    const card = $(`${slot}-card`);
    card.dataset.tone = state.tone; card.dataset.old = String(old);
    card.dataset.loading = String(snapshot.fetchedAtMs === null && snapshot.updating);
    text(`${slot}-title`, window.label);
    text(`${slot}-number`, percentText(window.remainingPercent));
    text(`${slot}-badge`, `${old ? '上次資料 · ' : ''}${state.label}`);
    const missing = snapshot.fetchedAtMs !== null && current !== undefined && !window.provided;
    $(`${slot}-missing`).hidden = !missing;
    text(`${slot}-missing`, slot === 'secondary' ? '此帳號未提供第二個額度視窗' : '此帳號未提供第一個額度視窗');
    (card.querySelector('.metric') as HTMLElement).hidden = missing;
    const track = $(`${slot}-progress`);
    track.dataset.unknown = String(window.remainingPercent === null);
    track.setAttribute('aria-label', `${window.label}剩餘`);
    track.setAttribute('aria-valuetext', `${old ? '上次資料，' : ''}${window.remainingPercent === null ? '尚無資料' : `${percentText(window.remainingPercent)} 剩餘`}`);
    if (window.remainingPercent === null) track.removeAttribute('aria-valuenow');
    else track.setAttribute('aria-valuenow', String(window.remainingPercent));
    $(`${slot}-fill`).style.width = `${window.remainingPercent ?? 0}%`;
    text(`${slot}-countdown`, countdown(window.resetsAtMs));
    text(`${slot}-time`, window.resetsAtMs === null ? '—' : absoluteTime(window.resetsAtMs, settings.timeZone));
    const time = $<HTMLTimeElement>(`${slot}-time`);
    if (window.resetsAtMs !== null) time.dateTime = new Date(window.resetsAtMs).toISOString(); else time.removeAttribute('datetime');
  }
  const formatted = snapshot.fetchedAtMs === null ? null : new Intl.DateTimeFormat('zh-TW', { timeZone: settings.timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(snapshot.fetchedAtMs);
  const previousDay = snapshot.fetchedAtMs !== null && new Intl.DateTimeFormat('en-CA', { timeZone: settings.timeZone }).format(snapshot.fetchedAtMs) !== new Intl.DateTimeFormat('en-CA', { timeZone: settings.timeZone }).format(Date.now());
  text('updated', formatted ? `最後成功更新 ${previousDay ? new Intl.DateTimeFormat('zh-TW', { timeZone: settings.timeZone, month: '2-digit', day: '2-digit' }).format(snapshot.fetchedAtMs!) + ' ' : ''}${formatted}` : '尚未取得用量資料');
  text('frequency', document.hidden ? '背景每 5 分鐘更新' : `每 ${settings.interval} 秒更新`);
  renderRecovery();
  const tokens = snapshot.tokens, expectedWindow = tokenWindow(snapshot);
  const period = tokens.period && sameTokenWindow(tokens.period.window, expectedWindow) ? tokens.period : null;
  const usd = estimateUsd(period, settings.pricing), total = period?.totalTokens ?? null;
  const excludedReviewTokens = period?.excludedReviewTokens ?? 0;
  const unknownModels = [...new Set(period?.segments.filter(segment => segment.model !== null && !Object.hasOwn(PRICES, segment.model)).map(segment => segment.model!) ?? [])];
  const usdUnavailableReason = period?.complete && usd === null
    ? unknownModels.length ? '尚無該模型公開 API 單價' : '缺少完整計價資料，暫不估價' : null;
  text('token-total', tokenText(total));
  $('token-total').title = total !== null ? `${total.toLocaleString('en-US')} tokens（本次 5 小時內的本機${period?.complete ? '紀錄' : '可核對小計'}）${excludedReviewTokens > 0 ? `；不含免費安全審核 ${excludedReviewTokens.toLocaleString('en-US')} Token` : ''}` : '尚無可核對的本次 5 小時 Token';
  text('token-usd', usdText(usd));
  $('token-usd').title = usd === null ? usdUnavailableReason ?? '缺少完整模型或 Token 拆分，暫不估價' : `US$${usd.toFixed(6)}（API 單價等值${excludedReviewTokens > 0 ? '；不含免費安全審核' : ''}）`;
  const tokenError = tokens.period && !period
    ? tokens.period.window.endAtMs <= Date.now() ? '正在確認新的 5 小時區間…' : '尚無有效的 5 小時額度區間'
    : { window_unavailable: '尚無有效的 5 小時額度區間', window_expired: '正在確認新的 5 小時區間…', no_token_events: '目前帳號尚無可核對的本機紀錄', log_unavailable: '暫時無法讀取本機紀錄', period_logs_incomplete: '部分本次紀錄無法完整核對', counter_overflow: '無法核對本次 Token 總量', log_identity_mismatch: '無法確認本次紀錄的帳號' }[tokens.periodErrorCode ?? ''];
  text('token-note', period ? !period.complete ? '本次可核對 Token 小計 · 資料不完整 · 暫不估價' : usdUnavailableReason ?? `本次本機 API ${settings.pricing === 'fast' ? 'Fast' : 'Standard'} 等值 · 非帳單${snapshot.status === 'offline' ? ' · 上次資料' : ''}` : tokenError ?? '正在取得本次 5 小時 Token');
  const newDetailSignature = JSON.stringify([current, snapshot.resetCreditsAvailable, snapshot.status, tokens, period?.window ?? null, settings.pricing, settings.timeZone]);
  if (detailSignature !== newDetailSignature) {
    detailSignature = newDetailSignature;
    const fields: Array<[string, string]> = [];
    for (const window of current?.windows ?? []) {
      fields.push([`${window.label} · 已用`, window.usedPercent === null ? '未提供' : `${Number(window.usedPercent.toFixed(2))}%`]);
      fields.push([`${window.label} · 視窗長度`, window.durationMins === null ? '未提供' : `${window.durationMins.toLocaleString('zh-TW')} 分鐘`]);
    }
    if (current) fields.push(['額度分類', current.label]);
    if (snapshot.resetCreditsAvailable !== null) fields.push(['可用重置次數', `${snapshot.resetCreditsAvailable} 次（只讀）`]);
    const count = (n: number) => n.toLocaleString('en-US');
    if (period) {
      fields.push(['本次區間開始', absoluteTime(period.window.startAtMs, 'Asia/Taipei')], ['本次區間結束', absoluteTime(period.window.endAtMs, 'Asia/Taipei')]);
      fields.push(['本次 · 本機聊天數', count(period.sessionCount)], ['本次 · 一般輸入', count(period.inputTokens - period.cachedInputTokens - period.cacheWriteInputTokens)], ['本次 · 快取輸入', count(period.cachedInputTokens)], ['本次 · 快取寫入', count(period.cacheWriteInputTokens)], ['本次 · 輸出', count(period.outputTokens)], ['其中推理輸出', count(period.reasoningOutputTokens)], [period.complete ? '本次 · Token 總計' : '本次 · 可核對 Token 小計', count(period.totalTokens)]);
      fields.push(['免費安全審核（未計入）', count(excludedReviewTokens)]);
      if (excludedReviewTokens > 0) fields.push(['安全審核用量說明', '自動安全審核免費且不消耗 Codex 額度，未計入本次 Token 與美元']);
      fields.push(['本次 Token 紀錄時間', period.updatedAtMs === null ? '未提供' : absoluteTime(period.updatedAtMs, 'Asia/Taipei')]);
      const models = [...new Set(period.segments.map(segment => segment.model ?? '未提供'))];
      fields.push(['紀錄中的模型', models.join('、')], ['估價方式', `API ${settings.pricing === 'fast' ? 'Fast（Standard × 2）' : 'Standard'}`]);
      for (const model of models) {
        const p = Object.hasOwn(PRICES, model) ? PRICES[model] : null;
        if (p) fields.push([`${model} · 每百萬 Token`, `Standard 輸入 $${p.input}／快取 $${p.cached}／寫入 $${p.write}／輸出 $${p.output}`]);
      }
      fields.push(['單價核對日期', PRICE_CHECKED_DATE], ['長上下文計價', '單次輸入 > 272K：輸入與快取 × 2、輸出 × 1.5']);
      if (!period.complete) fields.push(['Token 完整性', '資料不完整，僅顯示可核對小計；美元暫不估算']);
      if (usd === null) fields.push(['美元估算', usdUnavailableReason ?? '模型、單次請求或拆分不完整，暫不估價']);
      if (period.complete && unknownModels.length) fields.push(['尚無公開 API 單價的模型', unknownModels.join('、')]);
    } else fields.push(['本次 5 小時 Token', tokenError ?? '尚未取得可核對的本次紀錄']);
    fields.push(['Token 與美元範圍', '官方 Codex 5 小時重置區間內、目前帳號在這台 Mac 的紀錄；不含其他裝置']);
    if (!fields.length) fields.push(['用量資料', '未提供']);
    $('detail-fields').replaceChildren(...fields.map(([name, value]) => {
      const row = document.createElement('div'); row.className = 'detail-row';
      const key = document.createElement('span'), val = document.createElement('span'); key.textContent = name; val.textContent = value;
      row.append(key, val); return row;
    }));
  }
}
async function request(path: string, input?: object): Promise<any> {
  const response = await fetch(path, { ...(input ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error('service_unavailable');
  return response.json();
}
function disconnected() {
  connected = false;
  snapshot = { ...snapshot, status: 'offline', updating: false, errorCode: 'local_service' }; render();
}
async function refresh() {
  if (pending) return pending;
  pending = (async () => {
    try { snapshot = { ...snapshot, updating: true }; render(); snapshot = await request('/api/usage/refresh', {}); connected = true; }
    catch { disconnected(); }
    finally { pending = null; render(); }
  })();
  return pending;
}
async function presence() {
  if (!connected) return;
  try { await request('/api/presence', { id: panelId, visible: !document.hidden, interval: settings.interval }); } catch { /* SSE controls reconnection. */ }
}
function connect() {
  source?.close();
  source = new EventSource(`/api/events?id=${encodeURIComponent(panelId)}&visible=${!document.hidden}&interval=${settings.interval}`);
  source.addEventListener('usage', event => {
    try { snapshot = JSON.parse((event as MessageEvent).data); connected = true; render(); } catch {}
  });
  source.addEventListener('open', () => { connected = true; void presence(); });
  source.addEventListener('error', disconnected);
}

$('refresh').addEventListener('click', () => void refresh());
$('retry').addEventListener('click', () => void refresh());
$('settings').addEventListener('click', () => dialog.showModal());
$('done').addEventListener('click', () => dialog.close());
$('close-settings').addEventListener('click', () => dialog.close());
$('bucket').addEventListener('change', event => { selectedBucket = (event.target as HTMLSelectElement).value; render(); });
const zones = [...new Set(['Asia/Taipei', 'UTC', Intl.DateTimeFormat().resolvedOptions().timeZone, ...Intl.supportedValuesOf('timeZone')])];
$('timezone').replaceChildren(...zones.map(zone => { const option = document.createElement('option'); option.value = zone; option.textContent = zone === 'Asia/Taipei' ? '台北（Asia/Taipei）' : zone; return option; }));
$<HTMLSelectElement>('theme').value = settings.theme;
$<HTMLSelectElement>('timezone').value = settings.timeZone;
$<HTMLSelectElement>('interval').value = String(settings.interval);
$<HTMLSelectElement>('pricing').value = settings.pricing;
for (const id of ['theme', 'timezone', 'interval', 'pricing']) $(id).addEventListener('change', () => {
  settings = { theme: $<HTMLSelectElement>('theme').value as Settings['theme'], timeZone: $<HTMLSelectElement>('timezone').value, interval: Number($<HTMLSelectElement>('interval').value), pricing: $<HTMLSelectElement>('pricing').value as Settings['pricing'] };
  applySettings(); void presence();
});
document.addEventListener('keydown', event => { if (event.altKey && event.key.toLowerCase() === 'r' && !dialog.open) { event.preventDefault(); void refresh(); } });
document.addEventListener('visibilitychange', () => { void presence(); if (!document.hidden) { lastTick = Date.now(); void refresh(); } render(); });
window.addEventListener('pageshow', event => { if (event.persisted) { connect(); void refresh(); } });
window.addEventListener('online', () => { void refresh(); });
window.addEventListener('pagehide', () => source?.close());
setInterval(() => { const now = Date.now(); if (!document.hidden && now - lastTick > 60_000) void refresh(); lastTick = now; render(); }, 10_000);
applySettings();
try { snapshot = await request('/api/usage'); } catch { disconnected(); }
render(); connect();
