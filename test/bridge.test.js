import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { UpliftBridge } from '../src/bridge.js';
import { MODERN_VERSION, META, ERROR } from '../src/protocol.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/legacy-server.js', import.meta.url));

let bridge;
let id = 0;
const modern = (method, params = {}) => ({
  jsonrpc: '2.0',
  id: ++id,
  method,
  params: { ...params, _meta: { [META.protocolVersion]: MODERN_VERSION, ...(params._meta ?? {}) } },
});

describe('mcp-uplift bridge', () => {
  before(async () => {
    bridge = new UpliftBridge({ command: process.execPath, args: [FIXTURE] });
    await bridge.start();
  });
  after(() => bridge.stop());

  test('synthesizes server/discover from a legacy initialize', async () => {
    const res = await bridge.handle(modern('server/discover'));
    assert.equal(res.result.resultType, 'complete');
    assert.deepEqual(res.result.protocolVersions, [MODERN_VERSION]);
    assert.equal(res.result.serverInfo.name, 'legacy-demo');
    assert.equal(res.result.serverInfo._upliftedFrom, '2025-11-25');
    // Logging was deprecated, so the bridge stops advertising it.
    assert.equal(res.result.capabilities.logging, undefined);
    assert.deepEqual(res.result.capabilities.tools, {});
  });

  test('rejects an unsupported protocol version with -32022 and a supported list', async () => {
    const req = modern('tools/list');
    req.params._meta[META.protocolVersion] = '1900-01-01';
    const res = await bridge.handle(req);
    assert.equal(res.error.code, ERROR.UNSUPPORTED_PROTOCOL_VERSION);
    assert.deepEqual(res.error.data.supported, [MODERN_VERSION]);
    assert.equal(res.error.data.requested, '1900-01-01');
  });

  test('refuses methods removed in 2026-07-28 instead of forwarding them', async () => {
    for (const method of ['initialize', 'ping', 'logging/setLevel', 'resources/subscribe']) {
      const res = await bridge.handle(modern(method));
      assert.equal(res.error.code, ERROR.METHOD_NOT_FOUND, `${method} should be refused`);
      assert.match(res.error.message, /removed in 2026-07-28/);
    }
  });

  test('forwards tools/list, adding resultType, cache metadata, and stable order', async () => {
    const res = await bridge.handle(modern('tools/list'));
    assert.equal(res.result.resultType, 'complete');
    assert.equal(typeof res.result.ttlMs, 'number');
    assert.equal(res.result.cacheScope, 'private');
    assert.deepEqual(res.result.tools.map((t) => t.name), ['deploy', 'echo', 'zebra']);
    assert.equal(res.result._meta[META.serverInfo].upstream.name, 'legacy-demo');
  });

  test('forwards an ordinary tool call', async () => {
    const res = await bridge.handle(modern('tools/call', { name: 'echo', arguments: { text: 'hi' } }));
    assert.equal(res.result.resultType, 'complete');
    assert.equal(res.result.content[0].text, 'hi');
  });

  test('converts a server-initiated elicitation into an MRTR round trip', async () => {
    // Leg 1: the legacy server asks a question, which becomes input_required.
    const first = await bridge.handle(modern('tools/call', { name: 'deploy', arguments: {} }));
    assert.equal(first.result.resultType, 'input_required');
    assert.equal(first.result.inputRequests.length, 1);
    const ir = first.result.inputRequests[0];
    assert.equal(ir.method, 'elicitation/create');
    assert.equal(ir.params.message, 'Which environment?');
    assert.ok(first.result.requestState, 'must hand back an opaque resume token');

    // Leg 2: the client retries with answers, and the parked call completes.
    const second = await bridge.handle(modern('tools/call', {
      name: 'deploy',
      arguments: {},
      requestState: first.result.requestState,
      inputResponses: [{ id: ir.id, result: { action: 'accept', content: { env: 'prod' } } }],
    }));
    assert.equal(second.result.resultType, 'complete');
    assert.equal(second.result.content[0].text, 'deployed to prod');
  });

  test('rejects an unknown or replayed requestState', async () => {
    const res = await bridge.handle(modern('tools/call', {
      name: 'deploy',
      requestState: 'not-a-real-token',
      inputResponses: [],
    }));
    assert.equal(res.error.code, ERROR.INVALID_PARAMS);
  });

  test('propagates a client decline back to the legacy server', async () => {
    const first = await bridge.handle(modern('tools/call', { name: 'deploy', arguments: {} }));
    const ir = first.result.inputRequests[0];
    const second = await bridge.handle(modern('tools/call', {
      name: 'deploy',
      requestState: first.result.requestState,
      inputResponses: [{ id: ir.id, error: { code: -32603, message: 'user declined' } }],
    }));
    assert.equal(second.error.message, 'declined');
  });
});
