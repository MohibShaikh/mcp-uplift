#!/usr/bin/env node
/**
 * A deliberately old-fashioned MCP server (2025-11-25 semantics) used as a
 * test fixture: it requires the initialize handshake, and one of its tools
 * pushes a server-initiated elicitation request at the client.
 */

let buf = '';
let nextServerId = 1000;
const write = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const pendingElicit = new Map();

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handle(JSON.parse(line));
  }
});

function handle(msg) {
  // A response to our own server-initiated request.
  if (msg.id !== undefined && !msg.method) {
    const waiting = pendingElicit.get(msg.id);
    if (waiting) {
      pendingElicit.delete(msg.id);
      if (msg.error) {
        write({ jsonrpc: '2.0', id: waiting.reqId, error: { code: -32603, message: 'declined' } });
      } else {
        write({
          jsonrpc: '2.0', id: waiting.reqId,
          result: { content: [{ type: 'text', text: `deployed to ${msg.result.content.env}` }] },
        });
      }
    }
    return;
  }

  const { id, method, params } = msg;

  if (method === 'initialize') {
    write({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {}, logging: {} },
        serverInfo: { name: 'legacy-demo', version: '1.2.3' },
        instructions: 'A legacy server.',
      },
    });
    return;
  }
  if (method === 'notifications/initialized') return;

  if (method === 'ping') { write({ jsonrpc: '2.0', id, result: {} }); return; }

  if (method === 'tools/list') {
    write({
      jsonrpc: '2.0', id,
      result: {
        tools: [
          { name: 'zebra', description: 'last alphabetically', inputSchema: { type: 'object' } },
          { name: 'deploy', description: 'asks a question mid-call', inputSchema: { type: 'object' } },
          { name: 'echo', description: 'echoes', inputSchema: { type: 'object' } },
        ],
      },
    });
    return;
  }

  if (method === 'tools/call') {
    if (params.name === 'echo') {
      write({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: params.arguments?.text ?? '' }] },
      });
      return;
    }
    if (params.name === 'notify') {
      write({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1, total: 1 } });
      write({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'done' } });
      write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'clean' }] } });
      return;
    }
    if (params.name === 'resource-error') {
      write({ jsonrpc: '2.0', id, error: { code: -32002, message: 'missing resource', data: { uri: 'file:///missing' } } });
      return;
    }
    if (params.name === 'custom-error') {
      write({ jsonrpc: '2.0', id, error: { code: -32000, message: 'custom failure', data: { retryable: false } } });
      return;
    }
    if (params.name === 'crash') {
      process.exit(7);
    }
    if (params.name === 'deploy') {
      // Server-initiated request: impossible under 2026-07-28.
      const sid = nextServerId++;
      pendingElicit.set(sid, { reqId: id });
      write({
        jsonrpc: '2.0', id: sid, method: 'elicitation/create',
        params: {
          message: 'Which environment?',
          requestedSchema: {
            type: 'object',
            properties: { env: { type: 'string' } },
            required: ['env'],
          },
        },
      });
      return;
    }
    write({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool' } });
    return;
  }

  write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
}
