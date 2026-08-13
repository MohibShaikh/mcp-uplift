import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { LEGACY_VERSIONS, SERVER_INITIATED } from './protocol.js';

/**
 * Talks to a legacy (handshake-based) MCP server over stdio, and hides the
 * fact that it is stateful. The modern protocol is stateless, so exactly one
 * long-lived legacy session is kept warm and shared across modern requests.
 *
 * Emits:
 *   'server-request'  (msg)  - a server-initiated request (sampling/elicitation/roots)
 *   'notification'    (msg)  - a server notification
 */
export class LegacyClient extends EventEmitter {
  #proc = null;
  #buf = '';
  #nextId = 1;
  #pending = new Map();
  #ready = null;

  constructor({ command, args = [], env = process.env, cwd, onStderr } = {}) {
    super();
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.onStderr = onStderr;
    this.initializeResult = null;
    this.negotiatedVersion = null;
  }

  /** Starts the child process and completes the legacy initialize handshake once. */
  start() {
    if (this.#ready) return this.#ready;
    this.#ready = this.#doStart();
    return this.#ready;
  }

  async #doStart() {
    this.#proc = spawn(this.command, this.args, {
      env: this.env,
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.#proc.stdout.setEncoding('utf8');
    this.#proc.stdout.on('data', (chunk) => this.#onData(chunk));
    this.#proc.stderr.setEncoding('utf8');
    this.#proc.stderr.on('data', (d) => this.onStderr?.(d));

    this.#proc.on('exit', (code) => {
      const err = new Error(`legacy MCP server exited (code ${code})`);
      for (const { reject } of this.#pending.values()) reject(err);
      this.#pending.clear();
      this.#proc = null;
      this.#ready = null;
    });

    // The bridge advertises the client capabilities a legacy server may want.
    // Sampling/elicitation/roots are surfaced to the modern client via MRTR.
    const result = await this.request('initialize', {
      protocolVersion: LEGACY_VERSIONS[0],
      capabilities: { sampling: {}, elicitation: {}, roots: { listChanged: false } },
      clientInfo: { name: 'mcp-uplift', version: '0.1.0' },
    });

    this.initializeResult = result;
    this.negotiatedVersion = result?.protocolVersion ?? LEGACY_VERSIONS[0];
    this.notify('notifications/initialized', {});
    return result;
  }

  #onData(chunk) {
    this.#buf += chunk;
    let idx;
    while ((idx = this.#buf.indexOf('\n')) !== -1) {
      const line = this.#buf.slice(0, idx).trim();
      this.#buf = this.#buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // Not JSON-RPC; legacy servers sometimes print banners on stdout.
      }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg) {
    // Response to something we sent.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.#pending.get(msg.id);
      if (!entry) return;
      this.#pending.delete(msg.id);
      if (msg.error) entry.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error }));
      else entry.resolve(msg.result);
      return;
    }
    // Request from the server. In 2026-07-28 these no longer exist, so the
    // bridge parks them and converts to an input_required result (MRTR).
    if (msg.method && msg.id !== undefined) {
      if (SERVER_INITIATED.has(msg.method)) this.emit('server-request', msg);
      else this.#respond(msg.id, { code: -32601, message: `Unsupported: ${msg.method}` });
      return;
    }
    if (msg.method) this.emit('notification', msg);
  }

  #respond(id, error, result) {
    this.#write(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result });
  }

  /** Answers a server-initiated request once the modern client supplies input. */
  respondToServer(id, result) {
    this.#respond(id, null, result);
  }

  /** Rejects a server-initiated request (client declined, or cannot satisfy it). */
  rejectServer(id, message) {
    this.#respond(id, { code: -32603, message });
  }

  #write(msg) {
    if (!this.#proc) throw new Error('legacy MCP server is not running');
    this.#proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  request(method, params, { timeoutMs = 120_000 } = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`legacy request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();

      this.#pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  stop() {
    this.#proc?.kill();
    this.#proc = null;
    this.#ready = null;
  }
}
