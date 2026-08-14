import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { LEGACY_VERSIONS, SERVER_INITIATED, LIMITS } from './protocol.js';

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
  #stopping = null;

  constructor({ command, args = [], env = process.env, cwd, onStderr,
    maxLineBytes = LIMITS.maxLineBytes, maxBufferBytes = LIMITS.maxBufferBytes,
    initializeTimeoutMs = LIMITS.initializeTimeoutMs,
    requestTimeoutMs = LIMITS.requestTimeoutMs, shutdownGraceMs = LIMITS.shutdownGraceMs } = {}) {
    super();
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.onStderr = onStderr;
    this.maxLineBytes = maxLineBytes;
    this.maxBufferBytes = maxBufferBytes;
    this.initializeTimeoutMs = initializeTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.shutdownGraceMs = shutdownGraceMs;
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
    const launch = resolveLaunch(this.command, this.args);
    this.#proc = spawn(launch.command, launch.args, {
      env: this.env,
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsVerbatimArguments: launch.verbatim,
    });

    this.#proc.stdout.setEncoding('utf8');
    this.#proc.stdout.on('data', (chunk) => this.#onData(chunk));
    this.#proc.stderr.setEncoding('utf8');
    this.#proc.stderr.on('data', (d) => this.onStderr?.(d));
    this.#proc.on('error', (err) => this.#fail(err));
    this.#proc.stdin.on('error', (err) => this.#fail(err));

    const proc = this.#proc;
    this.#proc.on('exit', (code) => {
      const err = new Error(`legacy MCP server exited (code ${code})`);
      for (const { reject } of this.#pending.values()) reject(err);
      this.#pending.clear();
      if (this.#proc === proc) {
        this.#proc = null;
        this.#ready = null;
      }
      if (groupAlive(proc)) {
        killTree(proc, 'SIGTERM');
        const timer = setTimeout(() => killTree(proc, 'SIGKILL'), this.shutdownGraceMs);
        timer.unref?.();
      }
    });

    // The bridge advertises the client capabilities a legacy server may want.
    // Sampling/elicitation/roots are surfaced to the modern client via MRTR.
    let result;
    try {
      result = await this.request('initialize', {
        protocolVersion: LEGACY_VERSIONS[0],
        capabilities: { sampling: {}, elicitation: {}, roots: { listChanged: false } },
        clientInfo: { name: 'mcp-uplift', version: '0.1.0' },
      }, { timeoutMs: this.initializeTimeoutMs });
    } catch (err) {
      await this.stop();
      throw err;
    }

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
      if (Buffer.byteLength(line) > this.maxLineBytes) {
        this.#fail(new Error('legacy MCP output line limit exceeded'));
        this.stop();
        return;
      }
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // Not JSON-RPC; legacy servers sometimes print banners on stdout.
      }
      this.#dispatch(msg);
    }
    if (Buffer.byteLength(this.#buf) > this.maxBufferBytes) {
      this.#fail(new Error('legacy MCP output buffer limit exceeded'));
      void this.stop();
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
    if (!this.#proc) return;
    this.#respond(id, { code: -32603, message });
  }

  #write(msg) {
    if (!this.#proc) throw new Error('legacy MCP server is not running');
    this.#proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  #fail(err) {
    for (const { reject } of this.#pending.values()) reject(err);
    this.#pending.clear();
  }

  request(method, params, { timeoutMs = this.requestTimeoutMs } = {}) {
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
      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  stop() {
    if (this.#stopping) return this.#stopping;
    const proc = this.#proc;
    if (!proc) return Promise.resolve();
    this.#proc = null;
    this.#ready = null;
    this.#fail(new Error('legacy MCP server stopped'));
    this.#stopping = new Promise((resolve) => {
      let done = false;
      let timer;
      const finish = () => {
        if (done) return;
        if (groupAlive(proc)) return;
        done = true;
        clearTimeout(timer);
        this.#stopping = null;
        resolve();
      };
      proc.once('exit', finish);
      timer = setTimeout(() => {
        killTree(proc, 'SIGKILL');
        done = true;
        this.#stopping = null;
        resolve();
      }, this.shutdownGraceMs);
      killTree(proc, 'SIGTERM');
    });
    return this.#stopping;
  }
}

const BATCH_EXTENSIONS = new Set(['.cmd', '.bat']);

/**
 * Works out how to actually start the wrapped server.
 *
 * On Windows neither obvious spelling of an npm-installed server works: a bare
 * `npx` is ENOENT because Node's spawn does not apply PATHEXT, and `npx.cmd` is
 * EINVAL because Node refuses to spawn a batch file without a shell (the
 * CVE-2024-27980 mitigation). Nearly every published MCP server is launched
 * through such a shim, so both spellings have to be handled.
 *
 * `shell: true` would fix it in one line and is the wrong fix: Node pastes the
 * arguments into a command line unescaped, so an argument containing `&` could
 * run a second command. This resolves the real file instead, and only when it
 * turns out to be a batch script routes it through cmd.exe with every argument
 * escaped first.
 */
export function resolveLaunch(command, args) {
  if (process.platform !== 'win32') return { command, args, verbatim: false };

  const resolved = resolveWindowsCommand(command);
  if (!BATCH_EXTENSIONS.has(extname(resolved).toLowerCase())) {
    return { command: resolved, args, verbatim: false };
  }

  // cmd.exe takes one already-quoted command line, which Node must not requote.
  const line = [resolved, ...args].map(escapeForCmd).join(' ');
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    verbatim: true,
  };
}

/** Applies the PATHEXT and PATH lookup that Node's spawn does not do. */
function resolveWindowsCommand(command) {
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';').filter(Boolean).map((ext) => ext.toLowerCase());
  // Only a PATHEXT extension is executable on Windows. Node ships an
  // extensionless `npx` shell script beside `npx.cmd`, and preferring the bare
  // name would find that one and fail to spawn it.
  const names = extname(command) ? [command] : extensions.map((ext) => command + ext);
  // A command with a path separator is used as given; a bare name is looked up.
  const directories = isAbsolute(command) || /[\\/]/.test(command)
    ? ['']
    : (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean);

  for (const directory of directories) {
    for (const name of names) {
      const candidate = directory ? join(directory, name) : name;
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

/**
 * Quotes one argument for a cmd.exe command line: first for the Windows C
 * runtime, then escaping the characters cmd.exe interprets itself, so an
 * argument cannot end the command and start another.
 * @see https://qntm.org/cmd
 */
function escapeForCmd(arg) {
  const quoted = `"${String(arg)
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, '$1$1')}"`;
  return quoted.replace(/[><!^&|]/g, '^$&');
}

function killTree(proc, signal) {
  if (!Number.isInteger(proc.pid)) return;
  try {
    if (process.platform === 'win32') {
      const args = ['/pid', String(proc.pid), '/t'];
      if (signal === 'SIGKILL') args.push('/f');
      spawn('taskkill', args, { stdio: 'ignore', windowsHide: true }).unref();
    } else process.kill(-proc.pid, signal);
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }
}

function groupAlive(proc) {
  if (!Number.isInteger(proc.pid)) return false;
  if (process.platform === 'win32') return proc.exitCode === null;
  try {
    process.kill(-proc.pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    throw err;
  }
}
