# mcp-uplift

A bridge that runs a trusted legacy MCP stdio server behind the stateless
`2026-07-28` protocol. One legacy session is kept warm and presented as a
stateless modern server.

## Working conventions

### Simple implementations for complex concepts

The problems here are intricate; the code should not be. Prefer a plain data
structure and a short function over a framework or a clever abstraction. A
reader should be able to follow the protocol translation without first learning
an internal vocabulary. If a concept is genuinely hard, spend the words in a
comment explaining *why*, not in machinery.

### No assumptions, only verified truths

Never write protocol behavior from memory or inference. Before implementing
anything spec-facing, fetch the actual source and work from what it says:

- Spec prose: `docs/specification/2026-07-28/` in
  `modelcontextprotocol/modelcontextprotocol` (reachable via `gh api`).
- Schema and canonical payloads: `schema/2026-07-28/`, including the
  `examples/` directory, which holds real request/response JSON.

Quote exact method and field names from those sources. If a detail cannot be
verified, say so and stop rather than guessing at a wire format. Blog posts and
summaries are leads, not authority.

### Comments explain why, not what

Existing comments in `src/` state the reason a thing is done the way it is
(usually a protocol constraint or a failure that forced it). Match that. Do not
narrate what the next line already says.

### Commit messages

Conventional-commit subject, then a body that leads with the *problem* and only
then the change, wrapped near 72 columns. Release commits are the bare version
string (`0.1.2`), which is what `npm version` writes. No `Co-Authored-By`
trailers.

### Honest limitations

The README's "Known limitations" section is load-bearing. When a limitation
narrows, rewrite it to match reality; do not delete it and do not overstate what
was fixed.

## Layout

- `src/protocol.js` — version constants, `_meta` keys, error codes, method sets
- `src/legacy-client.js` — the child process and legacy JSON-RPC session
- `src/mrtr.js` — parked calls awaiting client input (`input_required`)
- `src/subscriptions.js` — open `subscriptions/listen` streams
- `src/bridge.js` — request translation, the piece that ties the rest together
- `src/cli.js` — stdio framing and process lifecycle

## Commands

- `npm test` — offline suite (`node --test test/*.test.js`)
- `test/real-world-60.sh` — real published servers; needs network, not in `npm test`
