# mcp-uplift

MCP `2026-07-28` removed the initialization handshake, sessions, ping,
logging configuration, resource subscriptions, and server-initiated requests.
Older MCP servers still use those protocol features. `mcp-uplift` wraps one
legacy stdio server and presents it as a modern stateless server.

> **Security:** wrapping a server executes that server with your operating-system
> permissions. This bridge is not a sandbox. Only run packages and commands you
> trust.

## Demo

![mcp-uplift translating a real legacy MCP server](https://github.com/MohibShaikh/mcp-uplift/raw/main/docs/demo.gif)

The unmodified official `@modelcontextprotocol/server-filesystem` running behind
the `2026-07-28` protocol: `server/discover` is synthesized from the legacy
handshake, the server's own `roots/list` request becomes a keyed `input_required`
result, and answering it resumes the call and returns all 14 tools.

## Usage

Run without installing:

```sh
npx mcp-uplift <legacy-command> [args...]
```

For example:

```sh
npx mcp-uplift npx -y @modelcontextprotocol/server-filesystem /tmp
```

The wrapped command receives a minimal environment by default. Forward a needed
credential explicitly, before `--`:

```sh
npx mcp-uplift --env BRAVE_API_KEY -- npx -y @modelcontextprotocol/server-brave-search
```

`--inherit-env` is available for compatibility but exposes every environment
variable to the wrapped process. Run `npx mcp-uplift --help` for resource and
timeout controls.

## Client configuration

Before, a client launches the legacy server directly:

```json
{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

After, launch the same command through `mcp-uplift`:

```json
{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["mcp-uplift", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

## Compatibility

Because `2026-07-28` is stateless, every request must carry its own envelope in
`params._meta`: the protocol version and the client's capabilities, plus
optional client identity. A request missing them is rejected rather than
guessed at.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": { "roots": {} },
      "io.modelcontextprotocol/clientInfo": { "name": "my-client", "version": "1.0.0" }
    }
  }
}
```

If a wrapped server needs a capability the client did not declare, the bridge
returns `-32021` naming what was required, rather than failing deep inside the
call.

| Feature | Behavior |
| --- | --- |
| Legacy `initialize` | Performed once and exposed as `server/discover` |
| Per-request version metadata | Validated as `2026-07-28`, else `-32022` |
| Tools, prompts, and resources | Forwarded with modern result and cache metadata |
| Legacy resource-not-found errors | Mapped from `-32002` to `-32602` |
| Sampling, elicitation, and roots requests | Translated into multi-round-trip `input_required` results |
| Legacy change notifications | Filtered onto a `subscriptions/listen` stream |
| Legacy `resources/subscribe` | Called upstream on behalf of `resourceSubscriptions` |
| Removed methods | Rejected with `-32601` method-not-found |
| Upstream failures | Returned as `-32603` internal errors |

## Answering a server's question

A legacy server can interrupt its own call to ask the client something.
Because a modern client cannot receive that push, the bridge returns an
`input_required` result instead, keyed by request id:

```json
{
  "resultType": "input_required",
  "inputRequests": {
    "ir_1000": {
      "method": "elicitation/create",
      "params": { "message": "Which environment?" }
    }
  },
  "requestState": "c0a2db7b-62bc-4420-b2e9-31da87f8f999"
}
```

To resume, send the **same request again** with the `requestState` you were
given and an `inputResponses` map using those same keys. Each value is the
response body itself, not wrapped in `result`:

```json
{
  "name": "deploy",
  "arguments": {},
  "requestState": "c0a2db7b-62bc-4420-b2e9-31da87f8f999",
  "inputResponses": {
    "ir_1000": { "action": "accept", "content": { "env": "prod" } }
  }
}
```

The parked call then finishes and returns its ordinary `"complete"` result.
Shapes per method: `elicitation/create` takes `{ action, content }` with
`action` one of `accept`, `decline`, or `cancel`; `roots/list` takes
`{ roots: [...] }`; `sampling/createMessage` takes `{ model, role, content }`.

The resumed request must match the original, every key must be answered, and
`requestState` is single-use and expires, so an invalid resume is rejected
rather than half-applied.

## Receiving change notifications

A legacy server pushes notifications at its client unprompted. `2026-07-28`
instead has the client open a stream and name the types it wants, and forbids
the server from sending anything else. The bridge keeps the legacy end
permanently opted in and does that filtering itself.

```json
{
  "jsonrpc": "2.0",
  "id": "listen-1",
  "method": "subscriptions/listen",
  "params": {
    "_meta": { "io.modelcontextprotocol/protocolVersion": "2026-07-28",
               "io.modelcontextprotocol/clientCapabilities": {} },
    "notifications": {
      "toolsListChanged": true,
      "resourceSubscriptions": ["file:///project/config.json"]
    }
  }
}
```

The request stays open. Its JSON-RPC id **is** the subscription id, and it is
answered only when the stream closes. The first message back is always the
acknowledgement, whose filter reports the subset the wrapped server can
actually deliver — a type the legacy server never declared is omitted rather
than silently promised:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/subscriptions/acknowledged",
  "params": {
    "_meta": { "io.modelcontextprotocol/subscriptionId": "listen-1" },
    "notifications": { "toolsListChanged": true }
  }
}
```

Every notification on the stream carries the same `subscriptionId`, which is
how a client demultiplexes concurrent subscriptions sharing one stdio channel.
`resourceSubscriptions` is registered upstream with the legacy
`resources/subscribe` that `2026-07-28` removed, and URIs are reference counted,
so two subscriptions watching one URI do not unsubscribe each other.

Cancel with `notifications/cancelled` naming the listen request id. When the
bridge itself closes a stream it answers the still-open request with an empty
`complete` result, which is how a client tells a clean shutdown from a dropped
transport.

## Known limitations

Real-world validation confirmed discovery and tool listing against 39 distinct
legacy MCP packages. The official filesystem server also completed a real
`roots/list` MRTR round trip and returned all 14 tools. These are tested
examples, not a guarantee that every server or session-dependent behavior can
be translated.

- **All legacy calls are serialized.** The
  legacy protocol never links a `sampling/createMessage`, `elicitation/create`,
  or `roots/list` request back to the call that caused it, so the bridge
  keeps one call in flight through all of its MRTR rounds. This favors correct
  attribution over throughput.
- **Progress and logging notifications are still dropped.** A
  `subscriptions/listen` stream carries change notifications only. Progress and
  logging belong to an in-flight request rather than to a stream, and the
  stateless request/response shape has nowhere to put them, so
  `notifications/progress` and `notifications/message` from the wrapped server
  are discarded.
- Real-server checks require downloads and remain outside the offline suite.
- The kill switch terminates the launched process tree on POSIX and Windows,
  but trusted code can deliberately daemonize into a new OS process session.
  Use an OS sandbox or container when stronger confinement is required.

## Security reports

Do not include credentials or exploit details in a public issue. Report a
suspected vulnerability privately through the repository's GitHub security
advisory page. Ordinary bugs can use the public issue tracker.
