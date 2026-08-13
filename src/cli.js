#!/usr/bin/env node
import { UpliftBridge } from './bridge.js';
import { MODERN_VERSION } from './protocol.js';

const argv = process.argv.slice(2);

if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
  process.stdout.write(`mcp-uplift - run a legacy MCP server as a modern ${MODERN_VERSION} server

  usage: mcp-uplift <command> [args...]
  e.g.:  mcp-uplift npx -y @modelcontextprotocol/server-filesystem /tmp

Speaks modern MCP on stdio, speaks the legacy handshake protocol upstream.
`);
  process.exit(argv.length ? 0 : 1);
}

const bridge = new UpliftBridge({
  command: argv[0],
  args: argv.slice(1),
  // Upstream stderr passes through so the wrapped server stays debuggable.
  onStderr: (d) => process.stderr.write(d),
});

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;

    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    // Notifications get no response.
    if (req.id === undefined) continue;

    const res = await bridge.handle(req);
    process.stdout.write(JSON.stringify(res) + '\n');
  }
});

const shutdown = () => { bridge.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('end', shutdown);
