#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
/**
 * A deliberately old-fashioned MCP server (2025-11-25 semantics) used as a
 * test fixture: it requires the initialize handshake, and one of its tools
 * pushes a server-initiated elicitation request at the client.
 */

let buf = '';
let nextServerId = 1000;
const write = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const pendingElicit = new Map();
const subscribedUris = new Set();
const unsubscribeLog = [];

if (process.env.SPAWN_DESCENDANT_FILE) {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    { stdio: 'ignore' });
  writeFileSync(process.env.SPAWN_DESCENDANT_FILE, String(child.pid));
}

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
      if (waiting.stage === 'first') {
        const sid = nextServerId++;
        pendingElicit.set(sid, { reqId: waiting.reqId, stage: 'second' });
        setTimeout(() => write({ jsonrpc: '2.0', id: sid, method: 'roots/list', params: {} }), 20);
        return;
      }
      if (waiting.stage === 'second') {
        write({ jsonrpc: '2.0', id: waiting.reqId,
          result: { content: [{ type: 'text', text: 'two rounds complete' }] } });
        return;
      }
      if (msg.error || msg.result.action !== 'accept') {
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
        // tools has no listChanged, so that subscription field is unsupported
        // and must be omitted from the acknowledged filter.
        capabilities: {
          tools: {}, logging: {},
          prompts: { listChanged: true },
          resources: { subscribe: true, listChanged: true },
        },
        serverInfo: { name: 'legacy-demo', version: '1.2.3' },
        instructions: 'A legacy server.',
      },
    });
    return;
  }
  if (method === 'notifications/initialized') return;

  if (method === 'ping') { write({ jsonrpc: '2.0', id, result: {} }); return; }

  // Legacy resource subscription: updates only arrive for registered URIs.
  if (method === 'resources/subscribe') {
    if (params.uri === 'file:///refused') {
      write({ jsonrpc: '2.0', id, error: { code: -32002, message: 'cannot watch' } });
      return;
    }
    subscribedUris.add(params.uri);
    write({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'resources/unsubscribe') {
    unsubscribeLog.push(params.uri);
    subscribedUris.delete(params.uri);
    write({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'unsubscribe-log') {
    write({ jsonrpc: '2.0', id, result: { uris: unsubscribeLog } });
    return;
  }

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

  if (method === 'resources/read' && params.uri === 'poison-result') {
    write({ jsonrpc: '2.0', id, result: { resultType: 'input_required', ttlMs: -1,
      cacheScope: 'everyone', contents: [] } });
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
    if (params.name === 'emit-updates') {
      // A legacy server pushes these unasked; only the bridge filters them.
      for (const uri of subscribedUris) {
        write({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri } });
      }
      write({ jsonrpc: '2.0', method: 'notifications/resources/list_changed', params: {} });
      write({ jsonrpc: '2.0', method: 'notifications/prompts/list_changed', params: {} });
      write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });
      write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'emitted' }] } });
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
    if (params.name === 'falsey-error') {
      write({ jsonrpc: '2.0', id, error: { code: -32000, message: 'falsey data', data: false } });
      return;
    }
    if (params.name === 'poison-result') {
      write({ jsonrpc: '2.0', id, result: { resultType: 'input_required', ttlMs: -1,
        cacheScope: 'everyone', content: [{ type: 'text', text: 'safe' }] } });
      return;
    }
    if (params.name === 'env') {
      write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text',
        text: `${process.env.TEST_SECRET ?? 'absent'}|${process.env.TEST_ALLOWED ?? 'absent'}` }] } });
      return;
    }
    if (params.name === 'hang') return;
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
    if (params.name === 'two-round') {
      const sid = nextServerId++;
      pendingElicit.set(sid, { reqId: id, stage: 'first' });
      write({ jsonrpc: '2.0', id: sid, method: 'elicitation/create',
        params: { mode: 'form', message: 'First?', requestedSchema: { type: 'object', properties: {} } } });
      return;
    }
    write({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool' } });
    return;
  }

  write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
}
