# AGENTS.md

Instructions for coding agents working in this repository. Read this before
touching anything. `CLAUDE.md` holds the same project conventions in more
detail; this file is the operating contract.

## What this project is

`mcp-uplift` wraps one trusted legacy MCP stdio server and presents it behind
the stateless `2026-07-28` protocol. It is a protocol translator. It is not a
framework, not a sandbox, and not a general proxy.

It ships with **zero runtime dependencies** and 6 source files. That is a
deliberate design property, not an accident waiting to be fixed.

## Hard rules

These are not preferences. Violating any of them makes the change unacceptable
regardless of how good the code is.

1. **Never invent protocol behavior.** Do not write a method name, field name,
   or error code from memory. Fetch the real thing first:
   - Prose: `docs/specification/2026-07-28/` in the
     `modelcontextprotocol/modelcontextprotocol` repo (`gh api` works).
   - Schema and canonical payloads: `schema/2026-07-28/`, especially
     `examples/`, which contains real request and response JSON.

   If you cannot verify a detail, stop and say so. A plausible guess about a
   wire format is worse than an unfinished task.

2. **Add no dependencies.** Not to `dependencies`, not to `devDependencies`.
   The test suite is `node --test`. If you want a library, you do not need it.

3. **Create no new files unless the task explicitly asks for one.** Put the
   change where the related code already lives.

4. **Do not refactor code you were not asked to change.** Renaming, reformatting,
   reorganizing, "modernizing", extracting helpers, or tidying adjacent code are
   all out of scope by default. A diff that touches files unrelated to the task
   will be rejected.

5. **Simple implementations for complex concepts.** A plain `Map` and a short
   function beat a class hierarchy. If a concept is hard, spend the words in a
   comment explaining *why*, not in machinery.

6. **Comments explain why, not what.** Match the existing style in `src/`:
   every comment states the protocol constraint or the failure that forced the
   code to be the way it is. Never narrate what the next line already says.

## Scope discipline

The most common failure mode here is doing more than was asked. Guard against it:

- **Do exactly the task named. Nothing adjacent.** Finding a second problem is
  not permission to fix it — report it and leave it alone.
- **Stop when the acceptance check passes.** Passing tests means done. It does
  not mean "now improve it".
- **Prefer the smallest diff that works.** If your change is large, that is
  evidence you misunderstood the task, not evidence of thoroughness.
- **No speculative generality.** Do not add options, hooks, configuration, or
  abstraction for a case nobody asked for. There is no future requirement you
  need to prepare for.
- **No new public API.** Do not add exported functions, constructor options, or
  CLI flags unless the task says to.
- **Do not rewrite tests to make them pass.** If an existing test fails, your
  change is wrong until proven otherwise. Existing assertions encode real bugs
  that were fixed; treat them as fixed points.
- **Do not touch** `README.md`, `package.json`, `LICENSE`, git history, tags, or
  anything under `.git/` unless the task is explicitly about them. Never run
  `git push`, `npm publish`, or `npm version`.
- **Pushing a `v*` tag publishes to npm.** `release.yml` turns a tag into a
  released package, and a published version can never be reused. Do not create
  or push tags.
- **Editing `.github/workflows/release.yml` can break releasing.** Its filename
  is registered with npm as a trusted publisher; renaming the file revokes
  publishing until someone updates the npm settings by hand.

If the task turns out to be underspecified, ask. Do not resolve ambiguity by
building more.

## Verifying

```sh
npm test          # offline suite, must be fully green
```

The real-server drivers hit the network and **execute every package they
download**, most written by strangers. They are excluded from `npm test` on
purpose. Run them only when asked, and prefer the GitHub workflow
(`real-world.yml`, which has `workflow_dispatch`) over a local machine.

- `node test/real-world-subscriptions.mjs` — current driver, 97 packages.
- `test/real-world-60*.sh` — older discovery sweeps; their cleanup calls
  `pkill`, absent from Git Bash on Windows.

Report results honestly. Paste the actual summary line. If something fails or
you skipped part of the task, say which part and why. Never describe work as
complete based on expectation rather than a command you ran.

**Never state a count that a run did not produce.** The README separates how
many packages are in the probe list from how many were actually probed. Adding
packages to the list does not increase the probed count. If you want a bigger
number, run the sweep and report what came back.

## Layout

| File | Responsibility |
| --- | --- |
| `src/protocol.js` | version constants, `_meta` keys, error codes, method sets |
| `src/legacy-client.js` | the child process, the legacy JSON-RPC session, and Windows executable resolution |
| `src/mrtr.js` | parked calls awaiting client input (`input_required`) |
| `src/subscriptions.js` | open `subscriptions/listen` streams |
| `src/bridge.js` | request translation; ties the rest together |
| `src/cli.js` | stdio framing and process lifecycle |
| `test/fixtures/legacy-server.js` | a deliberately old-fashioned MCP server |
| `.github/workflows/` | matrix CI, scheduled real-server sweep, tag-driven release |

The version is read from the installed `package.json` in `bridge.js` and
`legacy-client.js`. Never hardcode it — a hardcoded value shipped a release
that reported itself as `0.1.0`.

## Concepts you will need

- **MRTR** — a legacy server can interrupt its own call to ask the client
  something. A stateless client cannot receive that, so the bridge parks the
  call and returns `input_required` with a single-use `requestState` the client
  replays. See `src/mrtr.js`.
- **Subscriptions** — `subscriptions/listen` stays open for the life of the
  stream. Its JSON-RPC id *is* the subscription id, its response is withheld
  until closure, and everything else it emits goes out through the bridge's
  `onMessage` channel. See `src/subscriptions.js`.
- **The serialization lock** — legacy server-initiated requests carry no link
  back to the call that caused them, so calls that can trigger one are
  serialized. Never hold that lock across a long-lived operation.
