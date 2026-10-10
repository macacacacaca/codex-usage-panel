import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function stopRecordedService(record, { fetchHealth = async port => {
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error('unconfirmed_service');
  return response.json();
}, signalProcess = (pid) => process.kill(pid, 'SIGTERM') } = {}) {
  if (!Number.isInteger(record.pid) || record.pid <= 0 || !Number.isInteger(record.port) || record.port < 1024 || record.port > 65535 || typeof record.instanceId !== 'string' || !/^[\da-f-]{36}$/.test(record.instanceId)) throw new Error('invalid_record');
  const health = await fetchHealth(record.port);
  if (health.status !== 'ok' || health.instanceId !== record.instanceId || health.pid !== record.pid) throw new Error('unconfirmed_service');
  signalProcess(record.pid);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4317);
  try {
    const record = JSON.parse(await readFile(new URL(`../.runtime/${port}.json`, import.meta.url), 'utf8'));
    if (record.port !== port) throw new Error('invalid_record');
    await stopRecordedService(record);
    console.log('已送出停止指令；用量服務正在清理並關閉。');
  } catch (error) {
    if (error.code === 'ENOENT') console.log('沒有這個專案啟動的用量服務。');
    else { console.error('無法安全確認服務身份，未結束任何程序。請在原啟動視窗按 Control+C，或確認服務是否已停止。'); process.exitCode = 1; }
  }
}
