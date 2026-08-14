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

### Numbers must come from a run that happened

The README's "Verified against real servers" table states counts. Every one of
them must trace to a sweep that actually completed, and it separates three
numbers that are easy to blur into one:

- **Selected** — how many packages are in the list. Adding to the list proves
  nothing on its own.
- **Reached discovery** — how many actually responded. This is the denominator
  for any claim about correctness.
- **Never reached** — needed credentials or no longer run. These exercise
  nothing and must never be counted as passes.

"0 failures across 97" was wrong when only 62 responded; the honest claim is
"0 failures across 62 reachable servers". Re-run the sweep, then write down
what it returned.

## Layout

- `src/protocol.js` — version constants, `_meta` keys, error codes, method sets
- `src/legacy-client.js` — the child process and legacy JSON-RPC session, plus
  `resolveLaunch`, which does the Windows executable resolution Node's `spawn`
  does not
- `src/mrtr.js` — parked calls awaiting client input (`input_required`)
- `src/subscriptions.js` — open `subscriptions/listen` streams
- `src/bridge.js` — request translation, the piece that ties the rest together
- `src/cli.js` — stdio framing and process lifecycle

There is no version module: `bridge.js` and `legacy-client.js` each read the
installed `package.json` directly. A hardcoded version shipped a release that
reported itself as `0.1.0`; do not reintroduce one.

## Commands

- `npm test` — offline suite (`node --test test/*.test.js`)
- `node test/real-world-subscriptions.mjs` — the current real-server driver. 97
  published packages, `--only official|community`, `--bin` to drive an installed
  binary instead of `src/cli.js`. Needs network, executes everything it
  downloads, and is not in `npm test`.
- `test/real-world-60*.sh` — the older discovery sweeps. Bash, and their cleanup
  depends on `pkill`, which Git Bash on Windows does not have.

`npm test` globs `test/*.test.js`. Node expands that itself from 22; before that
it depends on the shell, so the suite cannot run on Windows under Node 20.

## Things that look like bugs and are not

Each of these has been questioned and verified. Do not "fix" one without new
evidence; if you think one is wrong, prove it the way it was proven here.

- **Every forwarded call is serialized.** `#acquire()` has one call site, inside
  `#forward`, so every request but discover/listen/removed/resume takes the
  lock. That is deliberate: a legacy server can interrupt *any* call to ask the
  client something, and the question carries no link back to its caller.
  `--max-in-flight` bounds requests *accepted*, not executed — they queue.
  Demonstrated by parking a call and watching an unrelated `echo` block.
- **`roots.listChanged: false` is advertised upstream.** `2026-07-28` removed
  `notifications/roots/list_changed` (it is in `REMOVED_METHODS`), so a modern
  client has no way to report a change. Saying `true` would promise the wrapped
  server something the bridge cannot deliver.
- **One warm legacy session serves every request.** That is the design — the
  handshake runs once. Each client launches its own bridge process over its own
  stdio pipe, so this is sharing within a client, not across clients.
- **Parked MRTR calls do not survive a restart.** Each is a promise waiting on a
  child process that dies with the bridge; persisting the token would not
  resurrect the server's in-flight call. The token carries the run that issued
  it only so a stale one can be *explained*, not recovered.
- **Non-JSON stdout lines are skipped silently.** Legacy servers print banners.
  A malformed JSON-RPC line is indistinguishable from one, and treating either
  as fatal would break working servers.

## Maintaining the probe list

`test/real-world-subscriptions.mjs` holds two arrays and a rule:

- **`REACHABLE`** — servers a sweep proved answer `initialize` with nothing
  configured. Only a completed run may add to this.
- **`CANDIDATES`** — new, unproven servers. Add here, never straight to
  `REACHABLE`.

Run the sweep (`real-world.yml`, `--only candidates`), then promote what
reached discovery and **delete** what did not. A package that stops at a missing
API key exercises none of the bridge; keeping it only inflates the list and
depresses the reachable figure. The list is a set of useful servers, not a
headcount — 79 real ones beat 100 with a fifth unreachable.

## Releasing

`npm version patch && git push --follow-tags` is the whole release.
`.github/workflows/release.yml` fires on the tag, refuses to publish when the
tag disagrees with `package.json`, and authenticates to npm with OIDC trusted
publishing, so there is no token anywhere and no OTP prompt. It also cuts the
GitHub Release.

`npm version` writes an annotated tag, which is what `--follow-tags` pushes. A
hand-written `git tag` is lightweight and will be left behind silently.

Anything in `files` (`src`, `README.md`, `LICENSE`) only reaches npm through a
release; a README correction needs a version bump to show up on the package
page. Everything else — workflows, tests, `.gitignore` — never ships, so it
needs no release at all.
