#!/usr/bin/env node
/**
 * Verifies subscriptions/listen against real published legacy MCP servers.
 *
 * For each package this checks the whole stream lifecycle:
 *   1. server/discover reports the upstream capabilities
 *   2. subscriptions/listen is acknowledged, stamped with its own request id
 *   3. the acknowledged filter never claims a type the server did not declare
 *   4. no response to the listen request arrives while the stream is open
 *   5. closing stdin produces the graceful empty result for that same id
 *
 * Needs network, so it is deliberately excluded from `npm test`. Written in
 * Node rather than shell because the sibling .sh drivers depend on pkill,
 * which does not exist in Git Bash on Windows.
 *
 *   node test/real-world-subscriptions.mjs [--timeout 90] [package...]
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const REPORT = fileURLToPath(new URL('../subscriptions-results.txt', import.meta.url));

const META = {
  version: 'io.modelcontextprotocol/protocolVersion',
  caps: 'io.modelcontextprotocol/clientCapabilities',
  subId: 'io.modelcontextprotocol/subscriptionId',
};
const ENVELOPE = { [META.version]: '2026-07-28', [META.caps]: {} };
const LISTEN_ID = 'listen-probe';

/** Established stdio MCP packages that predate 2026-07-28. */
const PACKAGES = [
  '@modelcontextprotocol/server-everything',
  '@modelcontextprotocol/server-filesystem',
  '@modelcontextprotocol/server-memory',
  '@modelcontextprotocol/server-sequential-thinking',
  '@modelcontextprotocol/server-puppeteer',
  '@modelcontextprotocol/server-brave-search',
  '@modelcontextprotocol/server-slack',
  '@modelcontextprotocol/server-github',
  '@modelcontextprotocol/server-postgres',
  '@modelcontextprotocol/server-google-maps',
  '@modelcontextprotocol/server-gdrive',
  '@modelcontextprotocol/server-sentry',
  '@modelcontextprotocol/server-redis',
  '@modelcontextprotocol/server-gitlab',
  '@modelcontextprotocol/server-aws-kb-retrieval',
  '@upstash/context7-mcp',
  '@playwright/mcp',
  '@executeautomation/playwright-mcp-server',
  '@browserbasehq/mcp-server-browserbase',
  '@notionhq/notion-mcp-server',
  '@supabase/mcp-server-supabase',
  '@wonderwhy-er/desktop-commander',
  '@21st-dev/magic',
  '@cyanheads/git-mcp-server',
  '@modelcontextprotocol/server-time',
  'mcp-sqlite',
  'sqlite-mcp-server',
  'chrome-devtools-mcp',
  'server-perplexity-ask',
  'mcp-server-fetch',
  'mcp-server-git',
  'mcp-server-time',
  'mcp-server-memory',
  'mcp-server-filesystem',
  'slack-mcp-server',
  'github-mcp-server',
  'postgres-mcp',
  'mongodb-mcp-server',
  'redis-mcp-server',
  'mysql-mcp-server',
  'puppeteer-mcp-server',
  'playwright-mcp',
  'filesystem-mcp-server',
  'fetch-mcp',
  'git-mcp-server',
  'youtube-mcp-server',
  'google-maps-mcp-server',
  'notion-mcp-server',
  'linear-mcp-server',
  'docker-mcp',
];

function parseArgs(argv) {
  const packages = [];
  let timeoutMs = 90_000;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--timeout') {
      const seconds = Number(argv[++i]);
      if (!Number.isFinite(seconds) || seconds < 1) throw new Error('--timeout needs seconds');
      timeoutMs = seconds * 1000;
    } else packages.push(argv[i]);
  }
  return { packages: packages.length ? packages : PACKAGES, timeoutMs };
}

/** Runs one package through the bridge and reports what the stream did. */
async function probe(pkg, timeoutMs) {
  // Windows needs the real filename: Node's spawn does not apply PATHEXT, so
  // a bare "npx" is ENOENT there.
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const child = spawn(process.execPath, [CLI, npx, '-y', pkg], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  const messages = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      messages.push(JSON.parse(line));
    } catch {
      // Legacy servers sometimes print banners on stdout.
    }
  });

  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  const kill = () => {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'],
        { stdio: 'ignore', windowsHide: true }).unref();
      else child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  };
  const finish = (status, detail) => { kill(); settle({ status, detail }); };

  // Not unref'd: these timers are the only thing holding the event loop open
  // while a probe waits, and the driver would otherwise exit mid-package.
  const overall = setTimeout(() => finish('UNAVAILABLE', 'timed out'), timeoutMs);
  child.on('error', () => finish('UNAVAILABLE', 'could not launch'));

  const send = (msg) => {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify(msg)}\n`);
  };
  const waitFor = (predicate, ms) => new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      const hit = messages.find(predicate);
      if (hit || Date.now() - started > ms) {
        clearInterval(poll);
        resolve(hit ?? null);
      }
    }, 100);
  });

  void (async () => {
    send({ jsonrpc: '2.0', id: 'discover', method: 'server/discover', params: { _meta: ENVELOPE } });
    const discovered = await waitFor((m) => m.id === 'discover', timeoutMs - 20_000);
    if (!discovered) return finish('UNAVAILABLE', 'no server/discover response');
    if (discovered.error) return finish('UNAVAILABLE', `discover error ${discovered.error.code}`);

    const caps = discovered.result?.capabilities ?? {};
    const supported = {
      toolsListChanged: Boolean(caps.tools?.listChanged),
      promptsListChanged: Boolean(caps.prompts?.listChanged),
      resourcesListChanged: Boolean(caps.resources?.listChanged),
    };
    if (!Object.values(supported).some(Boolean)) {
      return finish('UNSUPPORTED', 'declares no list_changed capability');
    }

    send({ jsonrpc: '2.0', id: LISTEN_ID, method: 'subscriptions/listen', params: {
      _meta: ENVELOPE,
      notifications: { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true },
    } });

    const ack = await waitFor((m) => m.method === 'notifications/subscriptions/acknowledged', 30_000);
    if (!ack) return finish('FAIL', 'no acknowledgement');
    if (ack.params?._meta?.[META.subId] !== LISTEN_ID) {
      return finish('FAIL', `acknowledgement carried subscriptionId ${ack.params?._meta?.[META.subId]}`);
    }

    // The acknowledgement must never promise a type the server cannot send.
    const acked = ack.params?.notifications ?? {};
    for (const [field, isSupported] of Object.entries(supported)) {
      if (acked[field] && !isSupported) return finish('FAIL', `acknowledged unsupported ${field}`);
    }
    // The request stays open; answering it now would end the stream early.
    if (messages.some((m) => m.id === LISTEN_ID)) return finish('FAIL', 'listen answered while open');

    child.stdin.end();
    const closed = await waitFor((m) => m.id === LISTEN_ID && m.result, 20_000);
    if (!closed) return finish('FAIL', 'no graceful closure on shutdown');
    if (closed.result.resultType !== 'complete') {
      return finish('FAIL', `closure resultType ${closed.result.resultType}`);
    }
    if (closed.result._meta?.[META.subId] !== LISTEN_ID) {
      return finish('FAIL', 'closure missing subscriptionId');
    }
    return finish('PASS', `acknowledged ${Object.keys(acked).join(',') || 'nothing'}`);
  })();

  const outcome = await done;
  clearTimeout(overall);
  return outcome;
}

const { packages, timeoutMs } = parseArgs(process.argv.slice(2));
const tally = { PASS: 0, FAIL: 0, UNSUPPORTED: 0, UNAVAILABLE: 0 };
const lines = [`Probing ${packages.length} packages (timeout ${timeoutMs / 1000}s each)`];
console.log(lines[0]);

for (const pkg of packages) {
  const { status, detail } = await probe(pkg, timeoutMs);
  tally[status] = (tally[status] ?? 0) + 1;
  const line = `${status.padEnd(12)} ${pkg.padEnd(48)} ${detail}`;
  lines.push(line);
  console.log(line);
}

const summary = `PASS=${tally.PASS} FAIL=${tally.FAIL} ` +
  `UNSUPPORTED=${tally.UNSUPPORTED} UNAVAILABLE=${tally.UNAVAILABLE}`;
lines.push('===== SUBSCRIPTION SUMMARY =====', summary);
console.log(`===== SUBSCRIPTION SUMMARY =====\n${summary}`);
writeFileSync(REPORT, `${lines.join('\n')}\n`);
console.log(`Report: ${REPORT}`);

// Only a real protocol violation is a failure; a package that will not install
// says nothing about the bridge.
process.exit(tally.FAIL > 0 ? 1 : 0);
