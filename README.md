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

The pinned, unmodified official `@modelcontextprotocol/server-filesystem@2025.8.21`
running behind the `2026-07-28` protocol: `server/discover` is synthesized from
the legacy handshake, the server's own `roots/list` request becomes a keyed
`input_required` result, and answering it resumes the call and returns all 14
tools. The second half shows a live `subscriptions/listen` stream from
acknowledgement through `resources/list_changed` to graceful closure.

Every command shown in the clip was first executed in a clean npm sandbox
against the registry release displayed onscreen.

## When you need this

The official SDKs already handle the migration for servers whose maintainers
will ship an update. This is for the ones that will not:

- **Servers nobody maintains any more.** A server that works and has not been
  touched in a year is not going to be ported, and it stops working the day its
  client goes modern-only.
- **Servers you cannot rebuild.** Vendor binaries, internal tools whose author
  left, anything shipped without source.
- **Servers outside the tier-1 SDKs.** The migration story is good in
  TypeScript and Python and thinner everywhere else.
- **Servers you do not want to fork.** Wrapping is reversible; a fork is a
  maintenance burden you own forever.

`mcp-uplift` buys time for all of these. Point your client at the bridge
instead of the server and nothing about the server changes.

## Verified against real servers

Every claim here is reproducible with the drivers in `test/`.

| | |
| --- | --- |
| Servers in the probe list | 79 |
| **Reached discovery** | **79** |
| **Protocol failures** | **0** |
| Full `subscriptions/listen` lifecycles | 36 |
| Declared no `list_changed` capability | 43 |
| Offline test suite | 41 tests, Linux/macOS/Windows, Node 20/22/24 |

The sweep ran on a clean GitHub runner on 2026-08-14
([run 31826150110](https://github.com/MohibShaikh/mcp-uplift/actions/runs/31826150110)).

The list holds only servers that answer `initialize` with nothing configured.
Packages fronting a paid API were removed rather than counted: they stop at the
missing key, exercise none of the bridge, and prove nothing either way. Every
one of the 79 was carried through the full protocol check — 36 completed a
subscription lifecycle end to end, and 43 correctly reported that they declare
no `list_changed` capability.

Community servers matter more here than reference ones. They were hand-rolled
against the 2025 spec by people who read it once, which is exactly where a
translation bug hides — and each was checked against the npm registry for an
executable, a pre-v2 SDK dependency, and a publish date before the cutoff, so
every one is a genuine legacy server.

Separately, discovery and tool listing were confirmed against 39 distinct legacy
packages, and the official filesystem server completed a real `roots/list` MRTR
round trip and returned all 14 tools.

These are tested examples, not a guarantee that every server or
session-dependent behaviour can be translated.

## Usage

Run without installing:

```sh
npx -y mcp-uplift -- <legacy-command> [args...]
```

For example:

```sh
npx -y mcp-uplift -- npx -y @modelcontextprotocol/server-filesystem@2025.8.21 .
```

The wrapped command receives a minimal environment by default. Forward a needed
credential explicitly, before `--`:

```sh
npx -y mcp-uplift --env BRAVE_API_KEY -- npx -y @brave/brave-search-mcp-server --transport stdio
```

`--inherit-env` is available for compatibility but exposes every environment
variable to the wrapped process. Inspect all line, buffer, concurrency,
subscription, initialization, request, MRTR, and shutdown controls with:

```sh
npx -y mcp-uplift --help
```

## Client configuration

Before, a client launches the legacy server directly:

```json
{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem@2025.8.21", "."]
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
      "args": ["-y", "mcp-uplift", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem@2025.8.21", "."]
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
  "requestState": "9f1c0e7a-1d33-4b02-8a55-2b6f0c4d1e88.c0a2db7b-62bc-4420-b2e9-31da87f8f999"
}
```

To resume, send the **same request again** with the `requestState` you were
given and an `inputResponses` map using those same keys. Each value is the
response body itself, not wrapped in `result`:

```json
{
  "name": "deploy",
  "arguments": {},
  "requestState": "9f1c0e7a-1d33-4b02-8a55-2b6f0c4d1e88.c0a2db7b-62bc-4420-b2e9-31da87f8f999",
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

Cancel by sending `notifications/cancelled` with the listen request id:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/cancelled",
  "params": { "requestId": "listen-1" }
}
```

A client cancellation ends the stream without a response because the result is
no longer wanted. When the bridge itself closes a stream, it answers the
still-open request with an empty `complete` result, which is how a client tells
a clean shutdown from a dropped transport.

## Known limitations

The stale-numbers paragraph that used to open this section now lives in
[Verified against real servers](#verified-against-real-servers). What follows is
what the bridge cannot do, and why.

### The shape of the design

- **Every forwarded call is serialized.** A legacy server can interrupt any call
  to ask the client something, and the legacy protocol never links that question
  back to the call that caused it. The bridge therefore keeps one call in flight
  upstream and holds it through all of its MRTR rounds. Requests are accepted
  concurrently up to `--max-in-flight`, but they execute one at a time: a call
  parked awaiting client input blocks unrelated calls until it is answered,
  cancelled, or expires. This favours correct attribution over throughput.
- **The bridge is stateful; only its interface is stateless.** Parked MRTR calls
  live in memory, because each one is a promise waiting on the wrapped server's
  own in-flight call. Restart the bridge and they are gone — the child process
  that was waiting died with it. A `requestState` from before a restart is
  rejected with `restarted: true` in the error data so a client can tell that
  apart from a bad token, but the call itself must be reissued.
- **One warm session serves every request, and the bridge assumes one client.**
  The legacy handshake runs once and the session is shared, so any state the
  wrapped server keeps is shared too: a memory or session-scoped server has one
  store, not one per request. Over stdio that is safe because `mcp-uplift` reads
  a single pipe and each client launches its own process, so the sharing is
  within one caller.

  `UpliftBridge` is also exported as a module, and **that path is not
  multi-tenant**. Nothing in it is partitioned by caller: a parked MRTR call is
  resumed on possession of its `requestState` alone, with no principal bound to
  it, and subscriptions are keyed on the client-chosen JSON-RPC request id, so
  two callers picking the same id collide. A legacy server may also have cached
  roots, credentials, or capabilities at `initialize` that outlive any one
  request. If you put this class behind a shared transport, isolating sessions
  per principal is yours to build, and failing closed when identity is unknown
  is the only safe default.
- **The wrapped server is told roots will never change.** `2026-07-28` removed
  `notifications/roots/list_changed`, so a modern client has no way to report a
  change and the bridge advertises `roots.listChanged: false` upstream. That is
  accurate rather than convenient: a server that would have adapted to a roots
  change cannot be told about one.

### What gets dropped or capped

- **Progress and logging notifications are dropped.** A `subscriptions/listen`
  stream carries change notifications only. Progress and logging belong to an
  in-flight request rather than to a stream, and the stateless request/response
  shape has nowhere to put them.
- **Unparseable stdout lines are skipped silently.** Legacy servers print
  banners on stdout, so a line that is not JSON is ignored rather than treated as
  an error. A genuinely malformed JSON-RPC message is indistinguishable from a
  banner and disappears the same way.
- **Exceeding a size cap ends the session, not the message.** A line over
  `--max-line-bytes` or a buffer over `--max-buffer-bytes` stops the wrapped
  server rather than dropping the one oversized message.
- **Hard ceilings, all tunable.** 120 s per upstream request, 16 concurrent
  subscriptions, 256 URIs per subscription. A legitimately long-running tool
  call becomes a timeout error; raise `--request-timeout-ms` for it.
- **The kill switch can be escaped.** It terminates the launched process tree on
  POSIX and Windows, but trusted code can deliberately daemonize into a new OS
  process session. Use an OS sandbox or container when stronger confinement is
  required.

Real-server checks require downloads and stay outside the offline suite.

## Security reports

Do not include credentials or exploit details in a public issue. Report a
suspected vulnerability privately through the repository's GitHub security
advisory page. Ordinary bugs can use the public issue tracker.
