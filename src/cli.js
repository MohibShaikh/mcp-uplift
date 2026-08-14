#!/usr/bin/env node
import { UpliftBridge } from './bridge.js';
import { MODERN_VERSION, LIMITS } from './protocol.js';

const HELP = `mcp-uplift - run a trusted legacy MCP server as modern ${MODERN_VERSION}

usage: mcp-uplift [options] -- <command> [args...]
       mcp-uplift <command> [args...]

options:
  --env NAME                    forward one environment variable (repeatable)
  --inherit-env                 forward the complete environment (less secure)
  --max-line-bytes N            default ${LIMITS.maxLineBytes}
  --max-buffer-bytes N          default ${LIMITS.maxBufferBytes}
  --max-in-flight N             default ${LIMITS.maxInFlight}
  --max-subscriptions N         default ${LIMITS.maxSubscriptions}
  --max-subscription-uris N     default ${LIMITS.maxSubscriptionUris}
  --initialize-timeout-ms N     default ${LIMITS.initializeTimeoutMs}
  --request-timeout-ms N        default ${LIMITS.requestTimeoutMs}
  --mrtr-ttl-ms N               default 300000
  --shutdown-grace-ms N         default ${LIMITS.shutdownGraceMs}
`;

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`mcp-uplift: ${err.message}\n`);
  process.exit(2);
}
if (options.help || !options.command.length) {
  process.stdout.write(HELP);
  process.exit(options.help ? 0 : 1);
}

let buffer = '';
let inFlight = 0;
let inputEnded = false;
let shuttingDown = false;
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

const bridge = new UpliftBridge({
  command: options.command[0], args: options.command.slice(1), env: options.env,
  ttlMs: options.mrtrTtlMs, maxLineBytes: options.maxLineBytes,
  maxBufferBytes: options.maxBufferBytes, initializeTimeoutMs: options.initializeTimeoutMs,
  requestTimeoutMs: options.requestTimeoutMs, shutdownGraceMs: options.shutdownGraceMs,
  maxSubscriptions: options.maxSubscriptions,
  maxSubscriptionUris: options.maxSubscriptionUris,
  onStderr: (data) => process.stderr.write(data),
  // Subscription traffic is not the answer to the request being handled, so it
  // is written as it happens rather than returned.
  onMessage: write,
});

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  await bridge.stop();
  // stop() writes the closing result for any open subscription. Writes to a
  // pipe are asynchronous, so exiting here would truncate them.
  await new Promise((resolve) => process.stdout.write('', resolve));
  process.exit(code);
}

function drain() {
  if (inputEnded && inFlight === 0) void startup.then((ok) => shutdown(ok ? 0 : 2));
}

// Start eagerly so a bad command or failed handshake is reported now, rather
// than exiting silently when no request ever arrives. Shutdown waits on this
// so a closed stdin cannot exit 0 before the failure is known.
const startup = bridge.start().then(() => true, (err) => {
  process.stderr.write(`mcp-uplift: could not start ${options.command[0]}: ${err.message}\n`);
  return false;
});

function dispatch(line) {
  if (Buffer.byteLength(line) > options.maxLineBytes) {
    write(error(null, -32600, 'Request line limit exceeded'));
    return;
  }
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    write(error(null, -32700, 'Parse error'));
    return;
  }
  // A notification carries no id and gets no reply; cancellation arrives this way.
  if (request?.id === undefined) {
    if (typeof request?.method === 'string') bridge.handleNotification(request);
    return;
  }
  if (inFlight >= options.maxInFlight) {
    write(error(request.id, -32000, 'Too many concurrent requests'));
    return;
  }
  inFlight++;
  // A null response means the request stays open, as subscriptions/listen does.
  bridge.handle(request)
    .then((response) => { if (response) write(response); },
      (err) => write(error(request.id, -32603, err.message)))
    .finally(() => { inFlight--; drain(); });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > options.maxBufferBytes && !buffer.includes('\n')) {
    write(error(null, -32600, 'Input buffer limit exceeded'));
    void shutdown(1);
    return;
  }
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) dispatch(line);
  }
});
process.stdin.on('end', () => { inputEnded = true; drain(); });
process.on('SIGINT', () => void shutdown(130));
process.on('SIGTERM', () => void shutdown(143));

function parseArgs(argv) {
  const values = { ...LIMITS, mrtrTtlMs: 300_000, inheritEnv: false, envNames: [] };
  const numeric = new Map([
    ['--max-line-bytes', 'maxLineBytes'], ['--max-buffer-bytes', 'maxBufferBytes'],
    ['--max-in-flight', 'maxInFlight'], ['--max-subscriptions', 'maxSubscriptions'],
    ['--max-subscription-uris', 'maxSubscriptionUris'],
    ['--initialize-timeout-ms', 'initializeTimeoutMs'],
    ['--request-timeout-ms', 'requestTimeoutMs'], ['--mrtr-ttl-ms', 'mrtrTtlMs'],
    ['--shutdown-grace-ms', 'shutdownGraceMs'],
  ]);
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { i++; break; }
    if (arg === '--help' || arg === '-h') return { help: true, command: [] };
    if (arg === '--inherit-env') { values.inheritEnv = true; continue; }
    if (arg === '--env') {
      const name = argv[++i];
      if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('--env requires a valid name');
      values.envNames.push(name);
      continue;
    }
    const key = numeric.get(arg);
    if (key) {
      const number = Number(argv[++i]);
      if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${arg} requires a positive integer`);
      values[key] = number;
      continue;
    }
    // An unknown flag is a typo, not a command; running it would be surprising.
    if (arg.startsWith('-') && arg !== '-') {
      throw new Error(`unknown option ${arg}\nRun 'mcp-uplift --help' to see available options.`);
    }
    break;
  }
  const baseNames = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
    'SystemRoot', 'ComSpec', 'PATHEXT'];
  const names = new Set([...baseNames, ...values.envNames]);
  values.env = values.inheritEnv ? { ...process.env }
    : Object.fromEntries([...names].filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]));
  values.command = argv.slice(i);
  return values;
}
