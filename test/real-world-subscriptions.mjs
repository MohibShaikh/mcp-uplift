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
 * SECURITY: this downloads and executes every package it probes, most of them
 * written by people you have never heard of. That is the point — the bridge
 * exists to wrap other people's servers — but run it on a throwaway machine or
 * an ephemeral CI runner, never on a workstation holding anything you care
 * about. The same warning the README gives about wrapping a server applies
 * here, multiplied by the size of the list.
 *
 *   node test/real-world-subscriptions.mjs [options] [package...]
 *
 *     --timeout 90              seconds per package
 *     --only official|community which half of the list to run
 *     --bin mcp-uplift          drive an installed binary instead of src/cli.js,
 *                               so CI exercises the published package the way a
 *                               user actually invokes it
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { resolveLaunch } from '../src/legacy-client.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const REPORT = fileURLToPath(new URL('../subscriptions-results.txt', import.meta.url));

const META = {
  version: 'io.modelcontextprotocol/protocolVersion',
  caps: 'io.modelcontextprotocol/clientCapabilities',
  subId: 'io.modelcontextprotocol/subscriptionId',
};
const ENVELOPE = { [META.version]: '2026-07-28', [META.caps]: {} };
const LISTEN_ID = 'listen-probe';

/**
 * Reference servers from the protocol authors and well-funded vendors. These
 * are the best-maintained implementations and the least representative ones.
 */
const OFFICIAL = [
  '@modelcontextprotocol/server-everything',
  '@modelcontextprotocol/server-filesystem',
  '@modelcontextprotocol/server-memory',
  '@modelcontextprotocol/server-sequential-thinking',
  '@upstash/context7-mcp',
  '@playwright/mcp',
  '@notionhq/notion-mcp-server',
  '@cyanheads/git-mcp-server',
  'chrome-devtools-mcp',
  'mcp-sqlite',
];

/**
 * Servers written by individuals and small teams, which is what most of the
 * ecosystem actually is. Every entry was checked against the npm registry for
 * a `bin`, a dependency on a pre-v2 `@modelcontextprotocol/sdk`, and a last
 * publish before 2026-07-28, so each one is a real legacy server the bridge
 * is supposed to be able to wrap.
 *
 * These are the interesting cases. A hand-rolled server that never quite
 * matched the reference implementation is exactly where a translation bug
 * shows up, and nobody else is testing against them.
 */
const COMMUNITY = [
  '@abhiz123/todoist-mcp-server',
  '@anaisbetts/mcp-youtube',
  '@browsermcp/mcp',
  '@drawio/mcp',
  '@leonardsellem/n8n-mcp-server',
  '@mieubrisse/notion-mcp-server',
  '@ohah/react-native-mcp-server',
  '@theupsider/lsp-mcp',
  '@zencoderai/slack-mcp-server',
  'advanced-websearch-mcp',
  'agent-browser-mcp-server',
  'agent5ive-mcp',
  'agentation-mcp',
  'bitbucket-mcp',
  'bitget-mcp-server',
  'bugsnag-mcp-server',
  'cls-mcp-server',
  'codex-mcp-server',
  'containerization-assist-mcp',
  'dapp-local-mcp',
  'datadog-mcp-server',
  'duckduckgo-mcp-server',
  'enhanced-postgres-mcp-server',
  'excalidraw-mcp',
  'expo-mcp',
  'fetcher-mcp',
  'figma-mcp',
  'gezhe-mcp-server',
  'graphlit-mcp-server',
  'groq-compound-mcp-server',
  'hlims-mcp',
  'hourei-mcp-server',
  'ifconfig-mcp',
  'joplin-mcp-server',
  'jsonresume-mcp',
  'langsmith-mcp-server',
  'learn-mcp',
  'leda-tickets-mcp',
  'linkup-mcp-server',
  'lsp-mcp-server',
  'mayar-mcp',
  'mcp-atlassian',
  'mcp-hello-world',
  'mcp-mermaid',
  'mcp-rime',
  'mcp-server-docker',
  'mcp-server-linear',
  'mcp-server-sqlite',
  'mcp-server-sqlite-npx',
  'mcp-servers',
  'merkl-mcp',
  'next-devtools-mcp',
  'ollama-mcp',
  'ollama-mcp-server',
  'openapi-mcp-server',
  'openrpc-mcp-server-updated',
  'outline-mcp-server',
  'playwright-mcp-server',
  'playwright-stealth-mcp-server',
  'puppeteer-mcp-server',
  'puppeteer-mcp-server-ws',
  'ref-mcp-cli',
  'ref-tools-mcp',
  'rime-mcp',
  'search-mcp-server',
  'serper-search-scrape-mcp-server',
  'sk-calculator-mcp-server',
  'skillsmp-mcp-server',
  'slack-workspace-mcp-server',
  'slite-mcp-server',
  'square-mcp-server',
  'stepfun-mcp',
  'storybook-mcp-server',
  'supabase-mcp',
  'tailwindcss-mcp-server',
  'tdesign-mcp-server',
  'tea-color-to-vars-mcp-server',
  'terraform-mcp-server',
  'terry-mcp',
  'tokportal-mcp',
  'user-postgresql-mcp',
  'valjs-mcp-alpha',
  'valjs-mcp-beta',
  'workers-mcp',
  'xmcp',
  'youtube-data-mcp-server',
  'zubeid-youtube-mcp-server',
];

const PACKAGES = [...OFFICIAL, ...COMMUNITY];

function parseArgs(argv) {
  const packages = [];
  let timeoutMs = 90_000;
  let only = null;
  let bin = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--timeout') {
      const seconds = Number(argv[++i]);
      if (!Number.isFinite(seconds) || seconds < 1) throw new Error('--timeout needs seconds');
      timeoutMs = seconds * 1000;
    } else if (argv[i] === '--bin') {
      bin = argv[++i];
      if (!bin) throw new Error('--bin needs a command');
    } else if (argv[i] === '--only') {
      only = argv[++i];
      if (only !== 'official' && only !== 'community') {
        throw new Error('--only takes official or community');
      }
    } else packages.push(argv[i]);
  }
  if (packages.length) return { packages, timeoutMs, bin };
  if (only === 'official') return { packages: OFFICIAL, timeoutMs, bin };
  if (only === 'community') return { packages: COMMUNITY, timeoutMs, bin };
  return { packages: PACKAGES, timeoutMs, bin };
}

/** Runs one package through the bridge and reports what the stream did. */
async function probe(pkg, timeoutMs, bin) {
  // A bare "npx" is correct on every platform: the bridge resolves the Windows
  // shim itself, which is exactly what this is exercising.
  //
  // An installed `mcp-uplift` is itself a .cmd shim on Windows, so reaching it
  // needs the same resolution the bridge does. Borrowing resolveLaunch here
  // keeps the driver honest: it invokes the installed command rather than
  // quietly falling back to a path only a developer would have.
  // npx alone can take half a minute to start a server on a cold cache, and an
  // installed shim adds another process layer on Windows, so the bridge's own
  // 60s initialize default is raised to match the budget this probe was given.
  const initializeMs = Math.max(60_000, timeoutMs - 20_000);
  const flags = ['--initialize-timeout-ms', String(initializeMs), '--'];
  const [command, args] = bin
    ? [bin, [...flags, 'npx', '-y', pkg]]
    : [process.execPath, [CLI, ...flags, 'npx', '-y', pkg]];
  const launch = resolveLaunch(command, args);
  const child = spawn(launch.command, launch.args, {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsVerbatimArguments: launch.verbatim,
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

const { packages, timeoutMs, bin } = parseArgs(process.argv.slice(2));
const tally = { PASS: 0, FAIL: 0, UNSUPPORTED: 0, UNAVAILABLE: 0 };
const lines = [`Probing ${packages.length} packages (timeout ${timeoutMs / 1000}s each)`];
console.log(lines[0]);

for (const pkg of packages) {
  const { status, detail } = await probe(pkg, timeoutMs, bin);
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
