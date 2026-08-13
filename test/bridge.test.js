import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { UpliftBridge } from '../src/bridge.js';
import { MODERN_VERSION, META, ERROR } from '../src/protocol.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/legacy-server.js', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

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

  test('drops legacy notifications and writes one clean response', async () => {
    const child = spawn(process.execPath, [CLI, process.execPath, FIXTURE], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.setEncoding('utf8').on('data', (chunk) => chunks.push(chunk));
    child.stdin.end(JSON.stringify(modern('tools/call', { name: 'notify', arguments: {} })) + '\n');
    const [code] = await new Promise((resolve) => child.on('close', (...args) => resolve(args)));
    assert.equal(code, 0);
    const lines = chunks.join('').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).result.content[0].text, 'clean');
  });

  test('maps resource-not-found and preserves every other upstream error', async () => {
    const missing = await bridge.handle(modern('tools/call', { name: 'resource-error' }));
    assert.deepEqual(missing.error, { code: -32602, message: 'missing resource', data: { uri: 'file:///missing' } });
    const custom = await bridge.handle(modern('tools/call', { name: 'custom-error' }));
    assert.deepEqual(custom.error, { code: -32000, message: 'custom failure', data: { retryable: false } });
  });

  test('turns an upstream crash into a JSON-RPC internal error', async () => {
    const crashing = new UpliftBridge({ command: process.execPath, args: [FIXTURE] });
    try {
      await crashing.start();
      const res = await crashing.handle(modern('tools/call', { name: 'crash' }));
      assert.equal(res.jsonrpc, '2.0');
      assert.equal(res.error.code, ERROR.INTERNAL);
      assert.match(res.error.message, /exited \(code 7\)/);
    } finally {
      crashing.stop();
    }
  });

  test('rejects parked MRTR state after its TTL', async () => {
    const expiring = new UpliftBridge({ command: process.execPath, args: [FIXTURE], ttlMs: 10 });
    const originalNow = Date.now;
    let now = 100;
    Date.now = () => now;
    try {
      await expiring.start();
      const first = await expiring.handle(modern('tools/call', { name: 'deploy', arguments: {} }));
      now = 111;
      const res = await expiring.handle(modern('tools/call', { name: 'deploy', requestState: first.result.requestState }));
      assert.equal(res.error.code, ERROR.INVALID_PARAMS);
    } finally {
      Date.now = originalNow;
      expiring.stop();
    }
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

  test('does not leak listeners across repeated round trips', async () => {
    // 1 is the constructor's own collector; anything above it is a leak that
    // would eventually stop the process from exiting.
    const baseline = bridge.legacy.listenerCount('server-request');
    assert.equal(baseline, 1);

    for (let i = 0; i < 10; i++) {
      await bridge.handle(modern('tools/call', { name: 'echo', arguments: { text: `n${i}` } }));
      const first = await bridge.handle(modern('tools/call', { name: 'deploy', arguments: {} }));
      await bridge.handle(modern('tools/call', {
        name: 'deploy',
        requestState: first.result.requestState,
        inputResponses: [{
          id: first.result.inputRequests[0].id,
          result: { action: 'accept', content: { env: 'prod' } },
        }],
      }));
    }

    assert.equal(bridge.legacy.listenerCount('server-request'), baseline);
  });

  test('keeps concurrent input-requiring calls from stealing each other', async () => {
    const [a, b] = await Promise.all([
      bridge.handle(modern('tools/call', { name: 'deploy', arguments: {} })),
      bridge.handle(modern('tools/call', { name: 'deploy', arguments: {} })),
    ]);

    // Serialized, so the second call is still queued and only one question is
    // outstanding; each must carry its own distinct resume token.
    assert.equal(a.result.resultType, 'input_required');
    assert.equal(b.result.resultType, 'input_required');
    assert.notEqual(a.result.requestState, b.result.requestState);
    assert.equal(a.result.inputRequests.length, 1);
    assert.equal(b.result.inputRequests.length, 1);
    assert.notEqual(a.result.inputRequests[0].id, b.result.inputRequests[0].id);

    const answer = (res, env) => bridge.handle(modern('tools/call', {
      name: 'deploy',
      requestState: res.result.requestState,
      inputResponses: [{
        id: res.result.inputRequests[0].id,
        result: { action: 'accept', content: { env } },
      }],
    }));

    const [ra, rb] = await Promise.all([answer(a, 'alpha'), answer(b, 'beta')]);
    assert.equal(ra.result.content[0].text, 'deployed to alpha');
    assert.equal(rb.result.content[0].text, 'deployed to beta');
  });
});
