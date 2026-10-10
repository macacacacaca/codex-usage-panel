import { absoluteTime, countdown, emptySnapshot, isOld, normalizeWindow, percentText, quotaState, type Snapshot, type Bucket } from './domain.ts';
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
  const tokens = snapshot.tokens, chat = tokens.chat, usd = estimateUsd(chat, settings.pricing);
  text('token-total', tokenText(chat?.totalTokens ?? null));
  $('token-total').title = chat ? `${chat.totalTokens.toLocaleString('en-US')} tokens` : '尚無聊天 Token 紀錄';
  text('token-usd', usdText(usd));
  $('token-usd').title = usd === null ? '缺少完整模型或 Token 拆分，暫不估價' : `US$${usd.toFixed(6)}（API 單價等值）`;
  const tokenError = { no_tracked_thread: '可在設定選擇追蹤聊天', log_unavailable: '找不到追蹤聊天紀錄', log_identity_mismatch: '無法確認紀錄屬於目前帳號', no_token_events: '追蹤聊天尚無 Token 紀錄' }[tokens.chatErrorCode ?? ''];
  text('token-note', chat ? `API ${settings.pricing === 'fast' ? 'Fast' : 'Standard'} 等值 · 非帳單${usd === null ? ' · 單價資料不足' : ''}${snapshot.status === 'offline' ? ' · 上次資料' : ''}` : tokenError ?? (snapshot.updating ? '正在讀取聊天 Token…' : '尚未取得聊天 Token'));
  const newDetailSignature = JSON.stringify([current, snapshot.resetCreditsAvailable, snapshot.status, tokens, settings.pricing, settings.timeZone]);
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
    if (chat) {
      fields.push(['聊天 · 一般輸入', count(chat.inputTokens - chat.cachedInputTokens - chat.cacheWriteInputTokens)], ['聊天 · 快取輸入', count(chat.cachedInputTokens)], ['聊天 · 快取寫入', count(chat.cacheWriteInputTokens)], ['聊天 · 輸出', count(chat.outputTokens)], ['其中推理輸出', count(chat.reasoningOutputTokens)], ['聊天 · Token 總計', count(chat.totalTokens)]);
      fields.push(['Token 紀錄時間', chat.updatedAtMs === null ? '未提供' : absoluteTime(chat.updatedAtMs, settings.timeZone)]);
      const models = [...new Set(chat.segments.map(segment => segment.model ?? '未提供'))];
      fields.push(['紀錄中的模型', models.join('、')], ['估價方式', `API ${settings.pricing === 'fast' ? 'Fast（Standard × 2）' : 'Standard'}`]);
      for (const model of models) {
        const p = PRICES[model];
        if (p) fields.push([`${model} · 每百萬 Token`, `Standard 輸入 $${p.input}／快取 $${p.cached}／寫入 $${p.write}／輸出 $${p.output}`]);
      }
      fields.push(['單價核對日期', PRICE_CHECKED_DATE], ['長上下文計價', '單次輸入 > 272K：輸入與快取 × 2、輸出 × 1.5']);
      if (usd === null) fields.push(['美元估算', '模型、單次請求或拆分不完整，暫不估價']);
    } else fields.push(['聊天 Token', tokenError ?? '尚未取得紀錄']);
    if (tokens.lifetimeTokens !== null) fields.push(['帳號 · 歷史累計 Token', count(tokens.lifetimeTokens)]);
    const latest = tokens.dailyBuckets.at(-1);
    if (latest) fields.push([`帳號 · ${latest.date}（來源日期）`, count(latest.tokens)]);
    if (tokens.fetchedAtMs !== null) fields.push(['帳號 Token 更新時間', absoluteTime(tokens.fetchedAtMs, settings.timeZone)]);
    if (tokens.errorCode) fields.push(['帳號 Token 狀態', tokens.fetchedAtMs === null ? '暫時無法取得' : '上次資料，等待重試']);
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
$('settings').addEventListener('click', () => {
  $<HTMLInputElement>('tracking').value = snapshot.tokens.trackingId ?? '';
  text('tracking-status', ''); dialog.showModal();
});
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
$('save-tracking').addEventListener('click', async () => {
  const id = $<HTMLInputElement>('tracking').value.trim();
  if (id && !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) { text('tracking-status', '請輸入完整的聊天 ID（36 個字元）。'); return; }
  const button = $<HTMLButtonElement>('save-tracking'); button.disabled = true;
  try { snapshot = await request('/api/tracking', { threadId: id || null }); render(); text('tracking-status', '已儲存追蹤設定。'); }
  catch { text('tracking-status', '無法儲存，請確認本機服務已啟動後重試。'); }
  finally { button.disabled = false; }
});
document.addEventListener('keydown', event => { if (event.altKey && event.key.toLowerCase() === 'r' && !dialog.open) { event.preventDefault(); void refresh(); } });
document.addEventListener('visibilitychange', () => { void presence(); if (!document.hidden) { lastTick = Date.now(); void refresh(); } render(); });
window.addEventListener('pageshow', event => { if (event.persisted) { connect(); void refresh(); } });
window.addEventListener('online', () => { void refresh(); });
window.addEventListener('pagehide', () => source?.close());
setInterval(() => { const now = Date.now(); if (!document.hidden && now - lastTick > 60_000) void refresh(); lastTick = now; render(); }, 30_000);
applySettings();
try { snapshot = await request('/api/usage'); } catch { disconnected(); }
render(); connect();
