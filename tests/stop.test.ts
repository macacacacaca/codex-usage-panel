import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopRecordedService } from '../scripts/stop.mjs';

test('stop entry only signals a matching process instance and rejects stale or invalid records', async () => {
  const record = { pid: 1234, port: 4317, instanceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
  let signaled: number | null = null;
  const signalProcess = (pid: number) => { signaled = pid; };
  await stopRecordedService(record, { fetchHealth: async () => ({ ...record, status: 'ok' }), signalProcess });
  assert.equal(signaled, 1234); signaled = null;
  for (const health of [{ ...record, status: 'ok', instanceId: 'other' }, { ...record, status: 'ok', pid: 4321 }]) {
    await assert.rejects(stopRecordedService(record, { fetchHealth: async () => health, signalProcess }));
    assert.equal(signaled, null);
  }
  await assert.rejects(stopRecordedService({ ...record, pid: -1 }, { signalProcess }));
  assert.equal(signaled, null);
});
