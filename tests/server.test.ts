import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUsageServer } from '../src/server.ts';
import { UsageService } from '../src/service.ts';
import { request as httpRequest } from 'node:http';

test('loopback API enforces Host/Origin, exposes no account identifiers, supports SSE and shared refresh', async () => {
  const app = createUsageServer({ service: new UsageService({ demo: true }), port: 0 });
  const origin = await app.listen();
  try {
    assert.equal((await fetch(`${origin}/health`)).status, 200);
    assert.equal((await fetch(`${origin}/api/usage`, { headers: { Origin: 'https://example.com' } })).status, 403);
    const wrongHostStatus = await new Promise(resolve => {
      const req = httpRequest(`${origin}/api/usage`, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.end();
    });
    assert.equal(wrongHostStatus, 403);
    const requestTargetStatus = (path: string) => new Promise((resolve, reject) => {
      const req = httpRequest(origin, { path }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(await requestTargetStatus('http://['), 400);
    assert.equal(await requestTargetStatus('http://evil.example/api/usage'), 403);
    assert.equal((await fetch(`${origin}/health`)).status, 200);
    assert.equal((await fetch(`${origin}/api/usage`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(`${origin}/api/usage/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(`${origin}/api/usage/refresh`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ value: '😀'.repeat(1500) }) })).status, 413);
    assert.equal((await fetch(`${origin}/tokens.js`)).status, 200);
    const tracking = (threadId: string | null, requestOrigin = origin) => fetch(`${origin}/api/tracking`, { method: 'POST', headers: { Origin: requestOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId }) });
    assert.equal((await tracking('../outside')).status, 400);
    assert.equal((await tracking(null, 'https://example.com')).status, 403);
    assert.equal((await tracking('11111111-2222-3333-4444-555555555555')).status, 200);
    assert.equal(app.service.snapshot.tokens.trackingId, '11111111-2222-3333-4444-555555555555');
    const post = () => fetch(`${origin}/api/usage/refresh`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
    const [first, second] = await Promise.all([post(), post()]);
    assert.deepEqual(await first.json(), await second.json());
    const controller = new AbortController();
    const event = await fetch(`${origin}/api/events?id=test&interval=30&visible=true`, { signal: controller.signal });
    assert.equal(event.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = event.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    assert.match(chunk, /event: usage/); assert.match(chunk, /"demo":true/);
    controller.abort();
  } finally { await app.close(); }
});

test('shutdown closes active SSE clients while a usage read is still pending', async () => {
  const app = createUsageServer({ service: new UsageService({ demo: true }), port: 0 });
  const origin = await app.listen();
  const controller = new AbortController();
  try {
    const response = await fetch(`${origin}/api/events?id=pending`, { signal: controller.signal });
    await response.body!.getReader().read();
    await app.close();
    assert.equal(app.service.closed, true); assert.equal(app.service.panels.size, 0); assert.equal(app.service.inFlight, null);
  } finally { controller.abort(); await app.close(); }
});

test('native API and stream share token pricing and keep the menu-bar panel in the common polling pool', async () => {
  const app = createUsageServer({ service: new UsageService({ demo: true }), port: 0 });
  const origin = await app.listen(); const controller = new AbortController();
  try {
    await app.service.refresh();
    const payload = await (await fetch(`${origin}/api/native`)).json();
    assert.equal(payload.snapshot.tokens.chat.totalTokens, 920000);
    assert.equal(payload.fastUsd, payload.standardUsd * 2);
    assert.equal(payload.priceDate, '2026-10-08');
    const stream = await fetch(`${origin}/api/native/events?id=native&visible=true&interval=60`, { signal: controller.signal });
    const first = await stream.body!.getReader().read();
    const text = new TextDecoder().decode(first.value);
    assert.ok(text.includes('"standardUsd"')); assert.ok(text.includes('"snapshot"'));
    assert.equal(app.service.panels.get('native')?.visible, true); assert.equal(app.service.pollInterval(), 60000);
  } finally { controller.abort(); await app.close(); }
});
