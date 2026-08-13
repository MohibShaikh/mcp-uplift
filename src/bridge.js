import { LegacyClient } from './legacy-client.js';
import { MrtrStore, toInputRequest, inputRequiredResult } from './mrtr.js';
import {
  MODERN_VERSION, META, ERROR, REMOVED_METHODS, CACHEABLE_METHODS,
  DEFAULT_TTL_MS,
} from './protocol.js';

const BRIDGE_INFO = { name: 'mcp-uplift', version: '0.1.0' };

/**
 * Presents a legacy MCP server as a modern (2026-07-28) stateless server.
 *
 * Responsibilities:
 *  - synthesize server/discover from the legacy initialize result
 *  - enforce per-request protocol version negotiation
 *  - answer methods that were removed in 2026-07-28 instead of forwarding them
 *  - stamp resultType, serverInfo, and cache metadata onto every result
 *  - translate server-initiated requests into MRTR input_required results
 */
export class UpliftBridge {
  #lock = Promise.resolve();

  constructor({ command, args, env, cwd, onStderr, ttlMs = DEFAULT_TTL_MS } = {}) {
    this.legacy = new LegacyClient({ command, args, env, cwd, onStderr });
    this.mrtr = new MrtrStore();
    this.ttlMs = ttlMs;
    /** legacy server-initiated requests seen while a call is in flight */
    this.pendingServerRequests = [];
    this.legacy.on('server-request', (msg) => this.pendingServerRequests.push(msg));
  }

  async start() {
    await this.legacy.start();
  }

  get serverInfo() {
    return this.legacy.initializeResult?.serverInfo ?? { name: 'unknown', version: '0.0.0' };
  }

  /** Handles one modern JSON-RPC request, returns a modern JSON-RPC response. */
  async handle(req) {
    const id = req.id;
    try {
      const version = req.params?._meta?.[META.protocolVersion];

      // Version negotiation is per-request now; there is no handshake to reject.
      if (version && version !== MODERN_VERSION) {
        return this.#error(id, ERROR.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
          supported: [MODERN_VERSION],
          requested: version,
        });
      }

      if (req.method === 'server/discover') return this.#ok(id, await this.#discover());

      if (REMOVED_METHODS.has(req.method)) {
        return this.#error(id, ERROR.METHOD_NOT_FOUND,
          `${req.method} was removed in ${MODERN_VERSION}`,
          { supported: [MODERN_VERSION] });
      }

      // A retry carrying answers to a previous input_required result.
      const state = req.params?.requestState;
      if (state) return await this.#resume(id, req);

      return await this.#forward(id, req);
    } catch (err) {
      if (err.rpc) return this.#error(id, err.rpc.code, err.rpc.message, err.rpc.data);
      return this.#error(id, ERROR.INTERNAL, err.message);
    }
  }

  /**
   * server/discover is mandatory in 2026-07-28 but does not exist in legacy
   * servers, so it is synthesized from the cached initialize result.
   */
  async #discover() {
    await this.legacy.start();
    const init = this.legacy.initializeResult ?? {};
    const capabilities = { ...(init.capabilities ?? {}) };

    // Sampling/elicitation/roots are no longer server-initiated; the bridge
    // serves them through MRTR, so they stay invisible as capabilities.
    delete capabilities.logging;

    return {
      resultType: 'complete',
      protocolVersions: [MODERN_VERSION],
      capabilities,
      serverInfo: {
        ...this.serverInfo,
        _upliftedFrom: this.legacy.negotiatedVersion,
      },
      instructions: init.instructions,
    };
  }

  async #forward(id, req) {
    await this.legacy.start();

    // A server-initiated request carries no link back to the call that caused
    // it, so the legs that can produce one are serialized: only one leg is ever
    // in flight, which makes attribution unambiguous. A parked call is blocked
    // awaiting our answer and cannot ask anything meanwhile, so the lock is
    // released while parked rather than held across the round trip.
    const release = await this.#acquire();
    this.pendingServerRequests = [];

    const params = stripModernMeta(req.params);
    const call = this.legacy.request(req.method, params);
    return await this.#settle(id, req.method, call, release);
  }

  /** Second leg of MRTR: feed the client's answers back into the legacy call. */
  async #resume(id, req) {
    const entry = this.mrtr.take(req.params.requestState);
    if (!entry) {
      return this.#error(id, ERROR.INVALID_PARAMS, 'Unknown or expired requestState');
    }

    // Answering revives the parked call, so this leg takes its own turn.
    const release = await this.#acquire();
    this.pendingServerRequests = [];
    for (const response of req.params.inputResponses ?? []) {
      const legacyId = entry.legacyIds.get(response.id);
      if (legacyId === undefined) continue;
      if (response.error) this.legacy.rejectServer(legacyId, response.error.message ?? 'declined');
      else this.legacy.respondToServer(legacyId, response.result);
    }

    return await this.#settle(id, req.method, entry.settle, release);
  }

  /**
   * Races an in-flight legacy call against the questions it may ask, parking it
   * when the server wants input and releasing the lock only once it is done.
   */
  async #settle(id, method, call, release) {
    const waiter = this.#waitForServerRequest();
    let outcome;
    try {
      outcome = await Promise.race([
        call.then((result) => ({ kind: 'result', result })),
        waiter.promise.then((msgs) => ({ kind: 'input', msgs })),
      ]);
    } catch (err) {
      release();
      throw err;
    } finally {
      waiter.cancel();
    }

    if (outcome.kind === 'input') {
      const inputRequests = outcome.msgs.map(toInputRequest);
      const legacyIds = new Map(outcome.msgs.map((m) => [`ir_${m.id}`, m.id]));
      const token = this.mrtr.park({ inputRequests, legacyIds, settle: call });
      release();
      return this.#ok(id, inputRequiredResult({ inputRequests, requestState: token }));
    }

    release();
    return this.#ok(id, this.#decorate(method, outcome.result));
  }

  /** Serializes the legs that can trigger a server-initiated request. */
  #acquire() {
    const prior = this.#lock;
    let release;
    this.#lock = new Promise((resolve) => {
      release = () => resolve();
    });
    return prior.then(() => once(release));
  }

  /**
   * Resolves once the legacy server pushes requests at us, and can be cancelled
   * so the losing side of a race does not leak its listener.
   */
  #waitForServerRequest() {
    let onReq;
    let settled = false;
    const promise = new Promise((resolve) => {
      const check = () => {
        if (settled || !this.pendingServerRequests.length) return false;
        settled = true;
        const msgs = this.pendingServerRequests;
        this.pendingServerRequests = [];
        this.legacy.off('server-request', onReq);
        resolve(msgs);
        return true;
      };
      // Requests arriving in one tick are collected before the race resolves.
      onReq = () => setImmediate(check);
      this.legacy.on('server-request', onReq);
      if (this.pendingServerRequests.length) setImmediate(check);
    });
    return {
      promise,
      cancel: () => {
        settled = true;
        this.legacy.off('server-request', onReq);
      },
    };
  }

  /** Adds fields that 2026-07-28 requires on every result. */
  #decorate(method, result) {
    const out = { resultType: 'complete', ...result };
    if (CACHEABLE_METHODS.has(method)) {
      out.ttlMs ??= this.ttlMs;
      out.cacheScope ??= 'private';
    }
    if (method === 'tools/list' && Array.isArray(out.tools)) {
      // Deterministic order improves prompt cache hits (SEP-2549 guidance).
      out.tools = [...out.tools].sort((a, b) => a.name.localeCompare(b.name));
    }
    out._meta = { ...(out._meta ?? {}), [META.serverInfo]: { ...BRIDGE_INFO, upstream: this.serverInfo } };
    return out;
  }

  #ok(id, result) {
    return { jsonrpc: '2.0', id, result };
  }

  #error(id, code, message, data) {
    return { jsonrpc: '2.0', id, error: data ? { code, message, data } : { code, message } };
  }

  stop() {
    this.legacy.stop();
  }
}

/** Releasing a lock twice would let two calls run at once, so guard it. */
function once(fn) {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}

/** Legacy servers reject unknown _meta keys in some SDKs, so strip ours. */
function stripModernMeta(params) {
  if (!params?._meta) return params;
  const meta = { ...params._meta };
  for (const key of Object.values(META)) delete meta[key];
  const out = { ...params };
  if (Object.keys(meta).length) out._meta = meta;
  else delete out._meta;
  delete out.requestState;
  delete out.inputResponses;
  return out;
}
