import { SUBSCRIBABLE, SUBSCRIPTION_CAPABILITY } from './protocol.js';

/**
 * Open `subscriptions/listen` streams.
 *
 * 2026-07-28 moved change notifications onto a long-lived stream the client
 * opts into per notification type. A legacy server has no such stream: it
 * simply pushes notifications once its client says it can accept them. The
 * bridge keeps the legacy end permanently opted in and uses this store to
 * decide, for each notification, which modern streams asked for it.
 *
 * A subscription is identified by the JSON-RPC id of the request that opened
 * it, which is also the value stamped into every notification's
 * `io.modelcontextprotocol/subscriptionId`.
 *
 * Resource URIs are reference counted. Two subscriptions may watch the same
 * URI, and the legacy `resources/unsubscribe` is per-URI rather than per
 * subscriber, so unsubscribing upstream on the first close would silently
 * blind the other subscription.
 */
export class SubscriptionStore {
  #open = new Map();
  #uriRefs = new Map();

  add(id, filter) {
    const uris = filter.resourceSubscriptions ?? [];
    // The array is what the acknowledgement reports; the set is what every
    // incoming notification is matched against, which is the hot path.
    this.#open.set(id, { filter, uris: new Set(uris) });
    for (const uri of uris) {
      this.#uriRefs.set(uri, (this.#uriRefs.get(uri) ?? 0) + 1);
    }
  }

  has(id) {
    return this.#open.has(id);
  }

  /** Removes a subscription and reports which URIs no longer have any watcher. */
  delete(id) {
    const entry = this.#open.get(id);
    if (!entry) return null;
    this.#open.delete(id);
    const released = [];
    for (const uri of entry.filter.resourceSubscriptions ?? []) {
      const next = (this.#uriRefs.get(uri) ?? 1) - 1;
      if (next > 0) this.#uriRefs.set(uri, next);
      else {
        this.#uriRefs.delete(uri);
        released.push(uri);
      }
    }
    return { entry, released };
  }

  /** URIs being watched for the first time, which need a legacy subscribe. */
  novel(uris) {
    return uris.filter((uri) => !this.#uriRefs.has(uri));
  }

  ids() {
    return [...this.#open.keys()];
  }

  get size() {
    return this.#open.size;
  }

  /** Subscription ids that opted into this legacy notification. */
  match(method, params) {
    const field = SUBSCRIBABLE[method];
    if (!field) return [];
    const matched = [];
    for (const [id, { filter, uris }] of this.#open) {
      if (field === 'resourceSubscriptions') {
        if (uris.has(params?.uri)) matched.push(id);
      } else if (filter[field] === true) matched.push(id);
    }
    return matched;
  }
}

/**
 * Narrows a client's requested filter to what the wrapped server can actually
 * deliver, given the capabilities it declared during the legacy handshake.
 * Unsupported types are omitted rather than refused: the spec asks the
 * acknowledgement to report the subset the server agreed to honor.
 */
export function negotiateFilter(requested, capabilities) {
  const filter = {};
  for (const [field, supported] of Object.entries(SUBSCRIPTION_CAPABILITY)) {
    if (!supported(capabilities)) continue;
    if (field === 'resourceSubscriptions') {
      const uris = requested.resourceSubscriptions;
      if (Array.isArray(uris) && uris.length) {
        filter.resourceSubscriptions = [...new Set(uris.filter((u) => typeof u === 'string'))];
      }
    } else if (requested[field] === true) filter[field] = true;
  }
  return filter;
}

/** Rejects a malformed filter before any of it reaches the legacy server. */
export function validFilter(requested) {
  if (requested === undefined) return true;
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) return false;
  for (const field of ['toolsListChanged', 'promptsListChanged', 'resourcesListChanged']) {
    if (requested[field] !== undefined && typeof requested[field] !== 'boolean') return false;
  }
  const uris = requested.resourceSubscriptions;
  if (uris !== undefined && (!Array.isArray(uris) || uris.some((u) => typeof u !== 'string' || !u))) {
    return false;
  }
  return true;
}
