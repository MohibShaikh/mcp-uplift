import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpliftBridge } from '../src/bridge.js';
import {
  MODERN_VERSION, META, ERROR, LISTEN_METHOD, SUBSCRIPTION_ACK, CANCELLED_NOTIFICATION,
} from '../src/protocol.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/legacy-server.js', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

let bridge;
let id = 0;
const modern = (method, params = {}) => ({
  jsonrpc: '2.0',
  id: ++id,
  method,
  params: { ...params, _meta: {
    [META.protocolVersion]: MODERN_VERSION,
    [META.clientCapabilities]: { roots: {}, sampling: {}, elicitation: { form: {} } },
    ...(params._meta ?? {}),
  } },
});

const firstInput = (res) => Object.entries(res.result.inputRequests)[0];

/** Lets queued notification fan-out reach the sink before it is asserted on. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A bridge with its own upstream and a sink for everything written outside a
 * response, which is where subscription traffic goes.
 */
const listening = async () => {
  const sent = [];
  const stream = new UpliftBridge({
    command: process.execPath, args: [FIXTURE], onMessage: (msg) => sent.push(msg),
  });
  await stream.start();
  return { stream, sent, stop: () => stream.stop() };
};

const runCli = async (args, input, env = process.env) => {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.setEncoding('utf8').on('data', (chunk) => stdout.push(chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => stderr.push(chunk));
  child.stdin.end(input);
  const [code] = await new Promise((resolve) => child.on('close', (...values) => resolve(values)));
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
};

describe('mcp-uplift bridge', () => {
  before(async () => {
    bridge = new UpliftBridge({ command: process.execPath, args: [FIXTURE] });
    await bridge.start();
  });
  after(() => bridge.stop());

  test('synthesizes server/discover from a legacy initialize', async () => {
    const res = await bridge.handle(modern('server/discover'));
    assert.equal(res.result.resultType, 'complete');
    assert.deepEqual(res.result.supportedVersions, [MODERN_VERSION]);
    assert.equal(res.result.ttlMs, 0);
    assert.equal(res.result.cacheScope, 'private');
    assert.equal(res.result._meta[META.serverInfo].upstream.name, 'legacy-demo');
    assert.equal(res.result.serverInfo, undefined);
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

  test('turns a missing executable into a JSON-RPC internal error', async () => {
    const missing = new UpliftBridge({ command: '/definitely/not/a/real/mcp-uplift-command',
      shutdownGraceMs: 10 });
    try {
      const res = await missing.handle(modern('server/discover'));
      assert.equal(res.error.code, ERROR.INTERNAL);
      assert.match(res.error.message, /ENOENT/);
    } finally {
      await missing.stop();
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
    assert.equal(Object.keys(first.result.inputRequests).length, 1);
    const [irId, ir] = firstInput(first);
    assert.equal(ir.method, 'elicitation/create');
    assert.equal(ir.params.message, 'Which environment?');
    assert.ok(first.result.requestState, 'must hand back an opaque resume token');

    // Leg 2: the client retries with answers, and the parked call completes.
    const second = await bridge.handle(modern('tools/call', {
      name: 'deploy',
      arguments: {},
      requestState: first.result.requestState,
      inputResponses: { [irId]: { action: 'accept', content: { env: 'prod' } } },
    }));
    assert.equal(second.result.resultType, 'complete');
    assert.equal(second.result.content[0].text, 'deployed to prod');
  });

  test('rejects an unknown or replayed requestState', async () => {
    const res = await bridge.handle(modern('tools/call', {
      name: 'deploy',
      requestState: 'not-a-real-token',
      inputResponses: {},
    }));
    assert.equal(res.error.code, ERROR.INVALID_PARAMS);
  });

  test('propagates a client decline back to the legacy server', async () => {
    const first = await bridge.handle(modern('tools/call', { name: 'deploy', arguments: {} }));
    const [irId] = firstInput(first);
    const second = await bridge.handle(modern('tools/call', {
      name: 'deploy',
      arguments: {},
      requestState: first.result.requestState,
      inputResponses: { [irId]: { action: 'decline' } },
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
        arguments: {},
        requestState: first.result.requestState,
        inputResponses: { [firstInput(first)[0]]: { action: 'accept', content: { env: 'prod' } } },
      }));
    }

    assert.equal(bridge.legacy.listenerCount('server-request'), baseline);
  });

  test('keeps concurrent input-requiring calls from stealing each other', async () => {
    const a = await bridge.handle(modern('tools/call', { name: 'deploy', arguments: {} }));
    let bSettled = false;
    const bPending = bridge.handle(modern('tools/call', { name: 'deploy', arguments: {} }))
      .then((value) => { bSettled = true; return value; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bSettled, false, 'another call must wait while an MRTR call owns the channel');
    assert.equal(a.result.resultType, 'input_required');
    assert.equal(Object.keys(a.result.inputRequests).length, 1);

    const answer = (res, env) => bridge.handle(modern('tools/call', {
      name: 'deploy',
      arguments: {},
      requestState: res.result.requestState,
      inputResponses: { [firstInput(res)[0]]: { action: 'accept', content: { env } } },
    }));

    const ra = await answer(a, 'alpha');
    const b = await bPending;
    const rb = await answer(b, 'beta');
    assert.equal(ra.result.content[0].text, 'deployed to alpha');
    assert.equal(rb.result.content[0].text, 'deployed to beta');
  });

  test('requires the final per-request metadata envelope', async () => {
    const res = await bridge.handle({ jsonrpc: '2.0', id: 900, method: 'tools/list', params: {} });
    assert.equal(res.error.code, ERROR.INVALID_PARAMS);
  });

  test('preserves falsey upstream error data', async () => {
    const res = await bridge.handle(modern('tools/call', { name: 'falsey-error' }));
    assert.deepEqual(res.error, { code: -32000, message: 'falsey data', data: false });
  });

  test('legacy results cannot forge modern result or cache control fields', async () => {
    const res = await bridge.handle(modern('resources/read', { uri: 'poison-result' }));
    assert.equal(res.result.resultType, 'complete');
    assert.equal(res.result.ttlMs, 60_000);
    assert.equal(res.result.cacheScope, 'private');
    const tool = await bridge.handle(modern('tools/call', { name: 'poison-result' }));
    assert.equal(tool.result.resultType, 'complete');
  });

  test('does not consume requestState when a resume is invalid', async () => {
    const first = await bridge.handle(modern('tools/call', { name: 'deploy', arguments: {} }));
    const [key] = firstInput(first);
    const bad = await bridge.handle(modern('tools/call', { name: 'deploy', arguments: {},
      requestState: first.result.requestState, inputResponses: { wrong: { action: 'decline' } } }));
    assert.equal(bad.error.code, ERROR.INVALID_PARAMS);
    const good = await bridge.handle(modern('tools/call', { name: 'deploy', arguments: {},
      requestState: first.result.requestState,
      inputResponses: { [key]: { action: 'accept', content: { env: 'safe' } } } }));
    assert.equal(good.result.content[0].text, 'deployed to safe');
  });

  test('rejects a malformed MRTR value without consuming its state', async () => {
    const first = await bridge.handle(modern('tools/call', { name: 'deploy', arguments: {} }));
    const [key] = firstInput(first);
    const bad = await bridge.handle(modern('tools/call', { name: 'deploy', arguments: {},
      requestState: first.result.requestState, inputResponses: { [key]: { action: 'accept', content: 'bad' } } }));
    assert.equal(bad.error.code, ERROR.INVALID_PARAMS);
    const good = await bridge.handle(modern('tools/call', { name: 'deploy', arguments: {},
      requestState: first.result.requestState,
      inputResponses: { [key]: { action: 'accept', content: { env: 'valid' } } } }));
    assert.equal(good.result.content[0].text, 'deployed to valid');
  });

  test('rejects malformed optional clientInfo metadata', async () => {
    const req = modern('tools/list');
    req.params._meta[META.clientInfo] = { name: 'missing-version' };
    const res = await bridge.handle(req);
    assert.equal(res.error.code, ERROR.INVALID_PARAMS);
  });

  test('rejects an undeclared client capability with -32021', async () => {
    const req = modern('tools/call', { name: 'deploy', arguments: {} });
    req.params._meta[META.clientCapabilities] = {};
    const res = await bridge.handle(req);
    assert.equal(res.error.code, ERROR.MISSING_REQUIRED_CLIENT_CAPABILITY);
    assert.deepEqual(res.error.data.requiredCapabilities, { elicitation: { form: {} } });
  });

  test('supports delayed server requests as another MRTR round', async () => {
    const first = await bridge.handle(modern('tools/call', { name: 'two-round', arguments: {} }));
    const [firstKey] = firstInput(first);
    const second = await bridge.handle(modern('tools/call', { name: 'two-round', arguments: {},
      requestState: first.result.requestState,
      inputResponses: { [firstKey]: { action: 'accept', content: {} } } }));
    assert.equal(second.result.resultType, 'input_required');
    assert.equal(firstInput(second)[1].method, 'roots/list');
    const [secondKey] = firstInput(second);
    const done = await bridge.handle(modern('tools/call', { name: 'two-round', arguments: {},
      requestState: second.result.requestState, inputResponses: { [secondKey]: { roots: [] } } }));
    assert.equal(done.result.content[0].text, 'two rounds complete');
  });

  test('acknowledges a subscription with only the types the server supports', async () => {
    const { stream, sent, stop } = await listening();
    const res = await stream.handle(modern(LISTEN_METHOD, { notifications: {
      toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true,
    } }));
    // The request stays open, so there is no response to write yet.
    assert.equal(res, null);
    const ack = sent[0];
    assert.equal(ack.method, SUBSCRIPTION_ACK);
    assert.equal(ack.params._meta[META.subscriptionId], id);
    // The fixture declares listChanged for prompts and resources but not tools.
    assert.deepEqual(ack.params.notifications,
      { promptsListChanged: true, resourcesListChanged: true });
    await stop();
  });

  test('delivers only subscribed notifications, stamped with the subscription id', async () => {
    const { stream, sent, stop } = await listening();
    await stream.handle(modern(LISTEN_METHOD, { notifications: { resourcesListChanged: true } }));
    const subId = id;
    sent.length = 0;
    await stream.handle(modern('tools/call', { name: 'emit-updates', arguments: {} }));
    await tick();
    assert.deepEqual(sent.map((m) => m.method), ['notifications/resources/list_changed']);
    assert.equal(sent[0].params._meta[META.subscriptionId], subId);
    await stop();
  });

  test('registers resource URIs upstream and reports one the server refused', async () => {
    const { stream, sent, stop } = await listening();
    await stream.handle(modern(LISTEN_METHOD, { notifications: {
      resourceSubscriptions: ['file:///watched', 'file:///refused'],
    } }));
    assert.deepEqual(sent[0].params.notifications, { resourceSubscriptions: ['file:///watched'] });
    sent.length = 0;
    await stream.handle(modern('tools/call', { name: 'emit-updates', arguments: {} }));
    await tick();
    assert.deepEqual(sent.map((m) => m.params.uri), ['file:///watched']);
    await stop();
  });

  test('keeps a shared URI watched until its last subscription closes', async () => {
    const { stream, sent, stop } = await listening();
    const uri = 'file:///shared';
    await stream.handle(modern(LISTEN_METHOD, { notifications: { resourceSubscriptions: [uri] } }));
    const first = id;
    await stream.handle(modern(LISTEN_METHOD, { notifications: { resourceSubscriptions: [uri] } }));
    const second = id;

    stream.handleNotification({ jsonrpc: '2.0', method: CANCELLED_NOTIFICATION,
      params: { requestId: first } });
    await tick();
    let log = await stream.handle(modern('unsubscribe-log'));
    assert.deepEqual(log.result.uris, [], 'the second subscription still needs the URI');

    sent.length = 0;
    await stream.handle(modern('tools/call', { name: 'emit-updates', arguments: {} }));
    await tick();
    assert.deepEqual(sent.map((m) => m.params._meta[META.subscriptionId]), [second]);

    stream.handleNotification({ jsonrpc: '2.0', method: CANCELLED_NOTIFICATION,
      params: { requestId: second } });
    await tick();
    log = await stream.handle(modern('unsubscribe-log'));
    assert.deepEqual(log.result.uris, [uri]);
    await stop();
  });

  test('answers open subscriptions on shutdown so a client sees a clean end', async () => {
    const { stream, sent, stop } = await listening();
    await stream.handle(modern(LISTEN_METHOD, { notifications: { resourcesListChanged: true } }));
    const subId = id;
    sent.length = 0;
    await stop();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].id, subId);
    assert.deepEqual(sent[0].result,
      { resultType: 'complete', _meta: { [META.subscriptionId]: subId } });
  });

  test('rejects a malformed, duplicate, or oversized subscription', async () => {
    const { stream, stop } = await listening();
    const bad = await stream.handle(modern(LISTEN_METHOD, { notifications: { toolsListChanged: 'yes' } }));
    assert.equal(bad.error.code, ERROR.INVALID_PARAMS);

    const many = await stream.handle(modern(LISTEN_METHOD, { notifications: {
      resourceSubscriptions: Array.from({ length: 300 }, (_, i) => `file:///${i}`),
    } }));
    assert.match(many.error.message, /Too many resource subscriptions/);

    const open = modern(LISTEN_METHOD, { notifications: { resourcesListChanged: true } });
    assert.equal(await stream.handle(open), null);
    const duplicate = await stream.handle({ ...open });
    assert.match(duplicate.error.message, /already in use/);
    await stop();
  });

  test('CLI streams a subscription and closes it on shutdown', async () => {
    const listen = JSON.stringify(modern(LISTEN_METHOD, { notifications: { resourcesListChanged: true } }));
    const subId = id;
    const emit = JSON.stringify(modern('tools/call', { name: 'emit-updates', arguments: {} }));
    const { code, stdout } = await runCli([process.execPath, FIXTURE], `${listen}\n${emit}\n`);
    const messages = stdout.trim().split('\n').map((line) => JSON.parse(line));

    const ack = messages.find((m) => m.method === SUBSCRIPTION_ACK);
    assert.equal(ack.params._meta[META.subscriptionId], subId);
    const update = messages.find((m) => m.method === 'notifications/resources/list_changed');
    assert.equal(update.params._meta[META.subscriptionId], subId);
    // Unsubscribed types never reach the client.
    assert.equal(messages.some((m) => m.method === 'notifications/prompts/list_changed'), false);
    // The still-open request is answered last, on shutdown.
    assert.equal(messages.at(-1).id, subId);
    assert.equal(messages.at(-1).result.resultType, 'complete');
    assert.equal(code, 0);
  });

  test('launches a server behind a Windows .cmd shim',
    { skip: process.platform !== 'win32' }, async () => {
      // Node cannot spawn a .cmd directly, and nearly every published MCP
      // server is launched through one, so the bridge routes it via cmd.exe.
      const dir = mkdtempSync(join(tmpdir(), 'mcp-uplift-cmd-'));
      const shim = join(dir, 'legacy-shim.cmd');
      writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${FIXTURE}" %*\r\n`);
      const shimmed = new UpliftBridge({ command: shim, args: [] });
      try {
        await shimmed.start();
        const res = await shimmed.handle(modern('server/discover'));
        assert.equal(res.result._meta[META.serverInfo].upstream.name, 'legacy-demo');
      } finally {
        await shimmed.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });

  test('does not let an argument break out of the Windows command line',
    { skip: process.platform !== 'win32' }, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mcp-uplift-inject-'));
      const shim = join(dir, 'echo-arg.cmd');
      const marker = join(dir, 'INJECTED');
      // If the argument were pasted in unescaped, cmd would run the second
      // command and create the marker file.
      writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${FIXTURE}" %*\r\n`);
      const hostile = `x& echo pwned > "${marker}"`;
      const attacked = new UpliftBridge({ command: shim, args: [hostile] });
      try {
        await attacked.start();
        assert.equal(existsSync(marker), false, 'argument escaped into a second command');
      } finally {
        await attacked.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });

  test('CLI returns parse and line-limit errors without launching upstream', async () => {
    const parsed = await runCli([process.execPath, FIXTURE], '{nope}\n');
    assert.equal(JSON.parse(parsed.stdout).error.code, -32700);
    const oversized = await runCli(['--max-line-bytes', '64', '--', process.execPath, FIXTURE],
      `${JSON.stringify(modern('tools/call', { name: 'echo', arguments: { text: 'x'.repeat(100) } }))}\n`);
    assert.equal(JSON.parse(oversized.stdout).error.message, 'Request line limit exceeded');
  });

  test('CLI withholds secrets unless explicitly forwarded', async () => {
    const request = `${JSON.stringify(modern('tools/call', { name: 'env' }))}\n`;
    const env = { ...process.env, TEST_SECRET: 'hidden', TEST_ALLOWED: 'shown' };
    const safe = await runCli([process.execPath, FIXTURE], request, env);
    assert.equal(JSON.parse(safe.stdout).result.content[0].text, 'absent|absent');
    const allowed = await runCli(['--env', 'TEST_ALLOWED', '--', process.execPath, FIXTURE], request, env);
    assert.equal(JSON.parse(allowed.stdout).result.content[0].text, 'absent|shown');
  });

  test('CLI bounds concurrent requests and legacy request time', async () => {
    const input = `${JSON.stringify(modern('tools/call', { name: 'hang' }))}\n${JSON.stringify(modern('tools/list'))}\n`;
    const result = await runCli(['--max-in-flight', '1', '--request-timeout-ms', '25', '--',
      process.execPath, FIXTURE], input);
    const responses = result.stdout.trim().split('\n').map(JSON.parse);
    assert.ok(responses.some((res) => res.error?.message === 'Too many concurrent requests'));
    assert.ok(responses.some((res) => /timed out/.test(res.error?.message)));
  });

  test('kill switch terminates descendants that ignore SIGTERM', { skip: process.platform === 'win32' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-uplift-kill-'));
    const pidFile = join(dir, 'pid');
    try {
      const req = `${JSON.stringify(modern('tools/list'))}\n`;
      const result = await runCli(['--env', 'SPAWN_DESCENDANT_FILE', '--shutdown-grace-ms', '25', '--',
        process.execPath, FIXTURE], req, { ...process.env, SPAWN_DESCENDANT_FILE: pidFile });
      assert.equal(result.code, 0);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      let alive = true;
      try { process.kill(pid, 0); } catch (err) { if (err.code === 'ESRCH') alive = false; else throw err; }
      if (alive) {
        const state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2];
        assert.equal(state, 'Z', 'descendant remained live after the kill switch');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('CLI rejects an unknown option instead of running it as the command', async () => {
    const res = await runCli(['--nonsense', '--', process.execPath, FIXTURE], '');
    assert.equal(res.code, 2);
    assert.match(res.stderr, /unknown option --nonsense/);
    assert.match(res.stderr, /--help/);
  });

  test('CLI reports a command that cannot start, even with no input', async () => {
    // Closed stdin used to race startup and exit 0, hiding the real failure.
    const res = await runCli(['this-binary-does-not-exist'], '');
    assert.equal(res.code, 2);
    assert.match(res.stderr, /could not start this-binary-does-not-exist/);
  });

  test('CLI exits 0 on a successful run', async () => {
    const request = JSON.stringify(modern('tools/list')) + '\n';
    const res = await runCli([process.execPath, FIXTURE], request);
    assert.equal(res.code, 0);
    assert.equal(res.stderr, '');
    assert.equal(JSON.parse(res.stdout.trim()).result.resultType, 'complete');
  });
});
