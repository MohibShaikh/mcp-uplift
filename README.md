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
| Removed methods | Rejected with `-32601` method-not-found |
| Upstream failures | Returned as `-32603` internal errors |

## Known limitations

Real-world validation confirmed discovery and tool listing against 39 distinct
legacy MCP packages. The official filesystem server also completed a real
`roots/list` MRTR round trip and returned all 14 tools. These are tested
examples, not a guarantee that every server or session-dependent behavior can
be translated. See [COMPATIBILITY.md](COMPATIBILITY.md) for the exact method
and its limits.

- **All legacy calls are serialized.** The
  legacy protocol never links a `sampling/createMessage`, `elicitation/create`,
  or `roots/list` request back to the call that caused it, so the bridge
  keeps one call in flight through all of its MRTR rounds. This favors correct
  attribution over throughput.
- **Legacy notifications have no home and are dropped.** `2026-07-28` moved
  streamed notifications onto a dedicated `subscriptions/listen` stream; this
  bridge is a plain one-request-one-response stdio proxy and does not
  implement that stream, so `notifications/progress` and
  `notifications/message` from the wrapped server are discarded rather than
  delivered.
- Real-server checks require downloads and remain outside the offline suite.
- The kill switch terminates the launched process tree on POSIX and Windows,
  but trusted code can deliberately daemonize into a new OS process session.
  Use an OS sandbox or container when stronger confinement is required.

## Security reports

Do not include credentials or exploit details in a public issue. Report a
suspected vulnerability privately through the repository's GitHub security
advisory page. Ordinary bugs can use the public issue tracker.
