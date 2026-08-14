/**
 * Protocol constants for MCP 2026-07-28 ("modern") and earlier ("legacy").
 * @see https://modelcontextprotocol.io/specification/2026-07-28/changelog
 */

export const MODERN_VERSION = '2026-07-28';
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];

/** Reserved _meta keys introduced by SEP-2575 / SEP-2322. */
export const META = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
  logLevel: 'io.modelcontextprotocol/logLevel',
  subscriptionId: 'io.modelcontextprotocol/subscriptionId',
};

/**
 * Error codes. -32020..-32099 is reserved for the MCP spec; the codes below
 * were renumbered in 2026-07-28 (HeaderMismatch -32001 -> -32020, etc).
 */
export const ERROR = {
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  HEADER_MISMATCH: -32020,
  MISSING_REQUIRED_CLIENT_CAPABILITY: -32021,
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
};

/**
 * Methods deleted in 2026-07-28. A modern client must never send these, and
 * if one does we answer directly rather than forwarding to the legacy server.
 */
export const REMOVED_METHODS = new Set([
  'initialize',
  'notifications/initialized',
  'ping',
  'logging/setLevel',
  'notifications/roots/list_changed',
  'resources/subscribe',
  'resources/unsubscribe',
]);

/** Results that must carry cache metadata under SEP-2549. */
export const CACHEABLE_METHODS = new Set([
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/read',
  'resources/templates/list',
]);

/** Server-initiated requests a legacy server may send us. Replaced by MRTR. */
export const SERVER_INITIATED = new Set([
  'sampling/createMessage',
  'elicitation/create',
  'roots/list',
]);

export const LISTEN_METHOD = 'subscriptions/listen';
export const SUBSCRIPTION_ACK = 'notifications/subscriptions/acknowledged';
export const CANCELLED_NOTIFICATION = 'notifications/cancelled';

/**
 * Legacy notification -> the subscriptions/listen filter field that opts into
 * it. A notification with no entry here has no home in 2026-07-28 and is
 * dropped: progress and logging travel with an in-flight request, not a stream.
 */
export const SUBSCRIBABLE = {
  'notifications/tools/list_changed': 'toolsListChanged',
  'notifications/prompts/list_changed': 'promptsListChanged',
  'notifications/resources/list_changed': 'resourcesListChanged',
  'notifications/resources/updated': 'resourceSubscriptions',
};

/**
 * The legacy capability each filter field depends on. The acknowledgement may
 * only claim fields the wrapped server actually supports, so a client learns
 * what it will really receive instead of waiting on a notification that the
 * upstream server was never able to send.
 */
export const SUBSCRIPTION_CAPABILITY = {
  toolsListChanged: (caps) => Boolean(caps.tools?.listChanged),
  promptsListChanged: (caps) => Boolean(caps.prompts?.listChanged),
  resourcesListChanged: (caps) => Boolean(caps.resources?.listChanged),
  resourceSubscriptions: (caps) => Boolean(caps.resources?.subscribe),
};

export const DEFAULT_TTL_MS = 60_000;

export const LIMITS = {
  maxLineBytes: 4 * 1024 * 1024,
  maxBufferBytes: 8 * 1024 * 1024,
  maxInFlight: 32,
  maxSubscriptions: 16,
  maxSubscriptionUris: 256,
  initializeTimeoutMs: 60_000,
  requestTimeoutMs: 120_000,
  shutdownGraceMs: 3_000,
};
