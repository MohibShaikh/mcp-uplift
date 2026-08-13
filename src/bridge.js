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
    this.pendingServerRequests = [];

    const params = stripModernMeta(req.params);
    const call = this.legacy.request(req.method, params);

    // Race the call against any server-initiated request it triggers. If the
    // legacy server asks us something, we cannot answer inline under MRTR.
    const outcome = await Promise.race([
      call.then((result) => ({ kind: 'result', result })),
      this.#waitForServerRequest().then((msgs) => ({ kind: 'input', msgs })),
    ]);

    if (outcome.kind === 'input') {
      const inputRequests = outcome.msgs.map(toInputRequest);
      const legacyIds = new Map(outcome.msgs.map((m) => [`ir_${m.id}`, m.id]));
      const token = this.mrtr.park({ inputRequests, legacyIds, settle: call });
      return this.#ok(id, inputRequiredResult({ inputRequests, requestState: token }));
    }

    return this.#ok(id, this.#decorate(req.method, outcome.result));
  }

  /** Resolves once the legacy server has pushed at least one request at us. */
  #waitForServerRequest() {
    return new Promise((resolve) => {
      const check = () => {
        if (this.pendingServerRequests.length) {
          const msgs = this.pendingServerRequests;
          this.pendingServerRequests = [];
          resolve(msgs);
          return true;
        }
        return false;
      };
      if (check()) return;
      const onReq = () => {
        // Collect requests arriving in the same tick before resuming.
        setImmediate(() => {
          if (check()) this.legacy.off('server-request', onReq);
        });
      };
      this.legacy.on('server-request', onReq);
    });
  }

  /** Second leg of MRTR: feed the client's answers back into the legacy call. */
  async #resume(id, req) {
    const entry = this.mrtr.take(req.params.requestState);
    if (!entry) {
      return this.#error(id, ERROR.INVALID_PARAMS, 'Unknown or expired requestState');
    }

    for (const response of req.params.inputResponses ?? []) {
      const legacyId = entry.legacyIds.get(response.id);
      if (legacyId === undefined) continue;
      if (response.error) this.legacy.rejectServer(legacyId, response.error.message ?? 'declined');
      else this.legacy.respondToServer(legacyId, response.result);
    }

    // The original legacy call is still in flight; it may now complete, or ask
    // another question, in which case we park it again.
    this.pendingServerRequests = [];
    const outcome = await Promise.race([
      entry.settle.then((result) => ({ kind: 'result', result })),
      this.#waitForServerRequest().then((msgs) => ({ kind: 'input', msgs })),
    ]);

    if (outcome.kind === 'input') {
      const inputRequests = outcome.msgs.map(toInputRequest);
      const legacyIds = new Map(outcome.msgs.map((m) => [`ir_${m.id}`, m.id]));
      const token = this.mrtr.park({ inputRequests, legacyIds, settle: entry.settle });
      return this.#ok(id, inputRequiredResult({ inputRequests, requestState: token }));
    }

    return this.#ok(id, this.#decorate(req.method, outcome.result));
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
