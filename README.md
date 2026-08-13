# mcp-uplift

MCP `2026-07-28` removed the initialization handshake, sessions, ping,
logging configuration, resource subscriptions, and server-initiated requests.
Older MCP servers still use those protocol features. `mcp-uplift` wraps one
legacy stdio server and presents it as a modern stateless server.

## Usage

Run without installing:

```sh
npx mcp-uplift <legacy-command> [args...]
```

For example:

```sh
npx mcp-uplift npx -y @modelcontextprotocol/server-filesystem /tmp
```

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

| Feature | Behavior |
| --- | --- |
| Legacy `initialize` | Performed once and exposed as `server/discover` |
| Per-request version metadata | Validated as `2026-07-28` |
| Tools, prompts, and resources | Forwarded with modern result and cache metadata |
| Legacy resource-not-found errors | Mapped from `-32002` to `-32602` |
| Sampling, elicitation, and roots requests | Translated into multi-round-trip `input_required` results |
| Removed methods | Rejected with method-not-found |
| Upstream failures | Returned as JSON-RPC internal errors |

## Known limitations

- **Calls that can trigger a server-initiated request are serialized.** The
  legacy protocol never links a `sampling/createMessage`, `elicitation/create`,
  or `roots/list` request back to the call that caused it, so the bridge
  cannot attribute a question to the right call if two run concurrently.
  Ordinary calls that never ask a question are unaffected.
- **Legacy notifications have no home and are dropped.** `2026-07-28` moved
  streamed notifications onto a dedicated `subscriptions/listen` stream; this
  bridge is a plain one-request-one-response stdio proxy and does not
  implement that stream, so `notifications/progress` and
  `notifications/message` from the wrapped server are discarded rather than
  delivered.
- **Verified against a real upstream server**, not just the test fixture: the
  official `@modelcontextprotocol/server-filesystem` (`0.2.0`) was wrapped
  unmodified via
  `node src/cli.js npx -y @modelcontextprotocol/server-filesystem <dir>`.
  `server/discover` returned its real identity, `tools/list` triggered a
  genuine server-initiated `roots/list` request that the bridge correctly
  turned into an `input_required` result, and after that round trip it
  returned all 14 of its real tools. A real `read_text_file` call returned
  the actual contents of a file on disk. Requires network access (`npx`
  fetches the package), so it is not part of the offline test suite.

