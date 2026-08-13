import { randomUUID } from 'node:crypto';

/**
 * Multi Round-Trip Requests (SEP-2322).
 *
 * Legacy servers push requests at the client mid-call (sampling/createMessage,
 * elicitation/create, roots/list). Modern clients cannot receive pushes, so the
 * bridge parks the in-flight legacy call, returns an `input_required` result
 * carrying the questions, and resumes when the client retries with answers.
 *
 * The parked state lives here because the modern protocol is stateless: the
 * client hands back an opaque `requestState` token and we look the call up.
 */
export class MrtrStore {
  #parked = new Map();

  constructor({ ttlMs = 300_000 } = {}) {
    this.ttlMs = ttlMs;
  }

  /**
   * Parks a legacy call awaiting client input.
   * @param {object} p
   * @param {Array} p.inputRequests   requests to surface to the modern client
   * @param {Map}   p.legacyIds       inputRequest id -> legacy JSON-RPC id
   * @param {Promise} p.settle        the original in-flight legacy request
   */
  park({ inputRequests, legacyIds, settle }) {
    this.sweep();
    const token = randomUUID();
    this.#parked.set(token, {
      inputRequests,
      legacyIds,
      settle,
      expiresAt: Date.now() + this.ttlMs,
    });
    return token;
  }

  take(token) {
    const entry = this.#parked.get(token);
    if (!entry) return null;
    this.#parked.delete(token);
    if (entry.expiresAt < Date.now()) return null;
    return entry;
  }

  sweep() {
    const now = Date.now();
    for (const [k, v] of this.#parked) if (v.expiresAt < now) this.#parked.delete(k);
  }

  get size() {
    return this.#parked.size;
  }
}

/**
 * Converts a legacy server-initiated request into a modern inputRequest entry.
 * Shapes follow the MRTR pattern: each entry names the method the client would
 * have been asked to serve, plus its original params.
 */
export function toInputRequest(legacyMsg) {
  return {
    id: `ir_${legacyMsg.id}`,
    method: legacyMsg.method,
    params: legacyMsg.params ?? {},
  };
}

/**
 * Builds the interim result handed back to the modern client.
 * `resultType: "input_required"` is mandatory in 2026-07-28.
 */
export function inputRequiredResult({ inputRequests, requestState }) {
  return {
    resultType: 'input_required',
    inputRequests,
    requestState,
  };
}
