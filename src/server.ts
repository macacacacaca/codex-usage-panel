import { createServer } from 'node:http';
import { readFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { UsageService } from './service.ts';
import { validThreadId } from './local-tokens.ts';
import { nativePayload } from './native.ts';
import { writePrivateJson } from './private-files.ts';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createUsageServer({ service = new UsageService(), port = 4317,
  saveTracking = async (_id: string | null) => {} } = {}) {
  const streams = new Set<any>();
  const instanceId = randomUUID();
  const root = new URL('../', import.meta.url);
  let actualPort = port;
  let trackingWrite = Promise.resolve();
  const server = createServer(async (req, res) => {
    const host = `127.0.0.1:${actualPort}`;
    const origin = `http://${host}`;
    const json = (status: number, data: object) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') { json(403, { error: 'forbidden_origin' }); return; }
    let url: URL;
    try { url = new URL(req.url ?? '/', origin); }
    catch { json(400, { error: 'invalid_request' }); return; }
    if (url.origin !== origin) { json(403, { error: 'forbidden_origin' }); return; }
    if (req.method === 'GET' && url.pathname === '/health') { json(200, { status: 'ok', version: '0.3.3', apiVersion: 2, instanceId, pid: process.pid }); return; }
    if (req.method === 'GET' && url.pathname === '/api/usage') { json(200, service.getSnapshot()); return; }
    if (req.method === 'GET' && url.pathname === '/api/native') { json(200, nativePayload(service.getSnapshot())); return; }
    if (req.method === 'POST') {
      if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') { json(403, { error: 'forbidden_origin' }); return; }
      let body = '';
      let bodyBytes = 0;
      try {
        for await (const chunk of req) {
          bodyBytes += chunk.length;
          if (bodyBytes > 4096) { json(413, { error: 'body_too_large' }); return; }
          body += chunk;
        }
        const input = JSON.parse(body || '{}');
        if (url.pathname === '/api/usage/refresh') { json(200, await service.refresh()); return; }
        if (url.pathname === '/api/tracking') {
          if (input.threadId !== null && !validThreadId(input.threadId)) { json(400, { error: 'invalid_thread_id' }); return; }
          const id = input.threadId === null ? null : input.threadId.toLowerCase();
          const update = trackingWrite.catch(() => {}).then(async () => { await saveTracking(id); await service.setTrackingId(id); });
          trackingWrite = update;
          await update; json(200, service.getSnapshot()); return;
        }
        if (url.pathname === '/api/presence') {
          if (typeof input.id !== 'string' || input.id.length > 80 || !streams.size || !service.panels.has(input.id)) { json(400, { error: 'unknown_panel' }); return; }
          service.setPanel(input.id, input.visible === true, input.interval);
          json(200, { ok: true }); return;
        }
      } catch { json(400, { error: 'invalid_request' }); return; }
    }
    if (req.method === 'GET' && ['/api/events', '/api/native/events'].includes(url.pathname)) {
      const id = url.searchParams.get('id');
      if (!id || id.length > 80 || service.panels.has(id) || streams.size >= 32) { json(400, { error: 'invalid_panel' }); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders(); streams.add(res);
      const send = (snapshot: ReturnType<UsageService['getSnapshot']>) => {
        if (res.destroyed || res.writableEnded) return;
        if (res.writableLength > 128_000) { res.destroy(); return; }
        const payload = url.pathname === '/api/native/events' ? nativePayload(snapshot) : snapshot;
        res.write(`event: usage\ndata: ${JSON.stringify(payload)}\n\n`);
      };
      service.on('snapshot', send);
      service.setPanel(id, url.searchParams.get('visible') !== 'false', Number(url.searchParams.get('interval')));
      send(service.getSnapshot());
      const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n'); }, 20_000);
      res.on('close', () => { clearInterval(heartbeat); service.off('snapshot', send); streams.delete(res); service.removePanel(id); });
      return;
    }
    const paths: Record<string, [string, string]> = {
      '/': ['web/index.html', 'text/html'], '/index.html': ['web/index.html', 'text/html'],
      '/styles.css': ['web/styles.css', 'text/css'], '/app.js': ['dist/app.js', 'text/javascript'], '/domain.js': ['dist/domain.js', 'text/javascript'],
      '/tokens.js': ['dist/tokens.js', 'text/javascript'],
    };
    if (req.method === 'GET' && paths[url.pathname]) {
      const [path, mime] = paths[url.pathname];
      try { const content = await readFile(new URL(path, root)); res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` }); res.end(content); }
      catch { json(503, { error: 'build_required' }); }
      return;
    }
    json(404, { error: 'not_found' });
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  return {
    server, service, instanceId,
    async listen() {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      const address = server.address(); if (address && typeof address === 'object') actualPort = address.port;
      service.start(); return `http://127.0.0.1:${actualPort}`;
    },
    async close() {
      for (const stream of streams) stream.end();
      const closing = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections(); await service.close(); await closing;
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) { console.error('Invalid PORT (1024–65535).'); process.exit(1); }
  const runtime = pathToFileURL(resolve(process.env.CODEX_USAGE_RUNTIME_DIR ?? fileURLToPath(new URL('../.runtime/', import.meta.url))) + '/');
  const trackingFile = new URL('tracking.json', runtime);
  let savedTracking: { threadId?: string | null } = {};
  try { savedTracking = JSON.parse(await readFile(trackingFile, 'utf8')); } catch {}
  const candidate = process.env.CODEX_USAGE_THREAD_ID ?? (Object.hasOwn(savedTracking ?? {}, 'threadId') ? savedTracking.threadId : process.env.CODEX_THREAD_ID);
  const trackingId = validThreadId(candidate) ? candidate.toLowerCase() : null;
  const saveTracking = async (id: string | null) => {
    await writePrivateJson(trackingFile, { threadId: id });
  };
  const app = createUsageServer({ service: new UsageService({ demo: process.argv.includes('--demo'), trackingId }), port, saveTracking });
  const record = new URL(`${port}.json`, runtime);
  try {
    const url = await app.listen();
    if (!app.service.demo) await saveTracking(trackingId);
    await writePrivateJson(record, { pid: process.pid, port, instanceId: app.instanceId });
    console.log(`Codex 用量面板 ${url}${app.service.demo ? ' · 示範資料' : ''}`);
  } catch (error: any) {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Open the existing panel or choose PORT=4318.` : 'Unable to start usage service.');
    await app.close(); process.exit(1);
  }
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true; await app.close();
    try {
      const saved = JSON.parse(await readFile(record, 'utf8'));
      if (saved.instanceId === app.instanceId) await unlink(record);
    } catch {}
    process.exit(0);
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
