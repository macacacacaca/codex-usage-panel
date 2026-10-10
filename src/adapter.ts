import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export class AdapterError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}

function isExecutableFile(path: string): boolean {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); }
  catch { return false; }
}

export function findCodex({ home = homedir(), environment = process.env, isExecutable = isExecutableFile }:
  { home?: string; environment?: NodeJS.ProcessEnv; isExecutable?: (path: string) => boolean } = {}): string {
  if (environment.CODEX_BINARY) return environment.CODEX_BINARY;
  for (const path of [
    '/Applications/Codex.app/Contents/Resources/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    join(home, 'Applications/Codex.app/Contents/Resources/codex'),
    join(home, 'Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    join(home, '.npm-global/bin/codex'),
    join(home, '.local/bin/codex'),
  ]) if (isExecutable(path)) return path;
  return 'codex';
}

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** Only these read operations are allowed. Never create turns or manage credentials. */
const READ_METHODS = new Set(['initialize', 'account/read', 'account/rateLimits/read', 'account/usage/read']);

export class CodexAdapter extends EventEmitter {
  binary: string;
  timeoutMs: number;
  child: ChildProcessWithoutNullStreams | null = null;
  pending = new Map<number, Pending>();
  sequence = 0;
  starting: Promise<void> | null = null;
  initialized = false;
  closing = false;

  constructor({ binary = findCodex(), timeoutMs = 15_000 } = {}) {
    super(); this.binary = binary; this.timeoutMs = timeoutMs;
  }

  async start(): Promise<void> {
    if (this.initialized) return;
    if (this.starting) return this.starting;
    if (this.closing) throw new AdapterError('service_stopped');
    this.starting = this.connect();
    try { await this.starting; } finally { this.starting = null; }
  }

  async connect(): Promise<void> {
    const child = spawn(this.binary, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    // Consume stderr without logging raw upstream responses, tokens, or account data.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      if (line.length > 4_000_000) return;
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && (message.result !== undefined || message.error)) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) {
          // Classify but never expose the upstream error text to the browser or logs.
          const text = String(message.error.message ?? '').toLowerCase();
          const code = /sign.?in|login|unauth|not authenticated|401/.test(text) ? 'auth_required'
            : /api.?key|not supported|not available|requires chatgpt/.test(text) ? 'unsupported_auth'
            : 'upstream_error';
          pending.reject(new AdapterError(code));
        } else pending.resolve(message.result);
      } else if (message.id !== undefined && message.method) {
        // This viewer cannot fulfill credential/approval requests.
        child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Read-only usage viewer' } }) + '\n');
      } else if (['account/updated', 'account/rateLimits/updated'].includes(message.method)) {
        this.emit(message.method, message.params);
      }
    });
    const ended = (code: string) => {
      lines.close();
      if (this.child !== child) return;
      this.initialized = false; this.child = null;
      this.rejectPending(code);
      if (!this.closing) this.emit('disconnected', code);
    };
    child.once('error', () => ended('cli_unavailable'));
    child.once('exit', () => ended('service_stopped'));
    try {
      await this.request('initialize', { clientInfo: { name: 'codex_usage_panel', title: 'Codex 用量面板', version: '0.1.0' } });
      if (this.child !== child) throw new AdapterError('service_stopped');
      child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
      this.initialized = true;
    } catch (error) {
      if (this.child === child) this.child = null;
      child.kill('SIGTERM'); this.rejectPending('service_stopped');
      throw error;
    }
  }

  request(method: string, params?: object, timeoutMs = this.timeoutMs): Promise<any> {
    if (!READ_METHODS.has(method)) return Promise.reject(new AdapterError('method_forbidden'));
    const child = this.child;
    if (!child || child.stdin.destroyed) return Promise.reject(new AdapterError('service_stopped'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new AdapterError('timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + '\n', error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (pending) { clearTimeout(pending.timer); this.pending.delete(id); reject(new AdapterError('service_stopped')); }
      });
    });
  }

  rejectPending(code: string): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new AdapterError(code)); }
    this.pending.clear();
  }

  async close(): Promise<void> {
    this.closing = true; this.initialized = false;
    this.rejectPending('service_stopped');
    const child = this.child; this.child = null;
    if (!child) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 1_000);
      timer.unref();
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.stdin.end(); child.kill('SIGTERM');
    });
  }
}
