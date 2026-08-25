# Gaps

What was tried, what was expected, what had to be done instead. Every workaround
here is a design gap in something — Mastra, `fancy-tui`, the Fancy backends, or
Genie. Recorded as they were hit while building the walking skeleton, not
reconstructed afterwards.

Nothing here is filed yet. Fancy items are **issue-first** by protocol — file on
the Fancy repo, never clone-fix-publish.

---

## Mastra

### M1 — `@mastra/core/test-utils/llm-mock` is unusable outside vitest *(blocking, worked around)*

**Tried:** `createMockModel({ mockText, version: 'v2' })` to give the CLI a
no-credentials mode.

**Expected:** a mock language model. It is a *published export* in the package's
`exports` map, and it is the documented way to run an agent without a provider.

**Got:**

```
Error: Vitest failed to access its internal state.
  at getWorkerState (node_modules/vitest/dist/chunks/utils.XdZDrNZV.js:9:9)
```

`node_modules/@mastra/core/dist/test-utils/llm-mock.js` line 13 is a bare
`import "vitest"`. **`vitest` is not a dependency of `@mastra/core`** — it
resolved here only because this project has it as a devDependency; in a consumer
without vitest it would fail to resolve entirely.

**Instead:** hand-wrote a ~60-line AI SDK v2 model (`src/offline-model.ts`).

**Worth reporting upstream.** A published, exported entry point should not
import a test framework at module scope, and certainly not one absent from its
dependency list. Silver lining: the replacement keeps a test-only dependency off
the shipping path, which is where it belonged.

### M2 — `agent-controller/test-utils` exists but is not exported

`dist/agent-controller/test-utils.d.ts` ships `createTestController` and
`createTestSession`, documented in-file as *"the standard entry point for
controller tests"*. Neither is reachable: the package `exports` map has
`./agent-controller` and `./test-utils/llm-mock`, but no
`./agent-controller/test-utils`.

**Instead:** constructed `AgentController` by hand in `src/harness.ts`. Fine —
arguably better, since the skeleton now exercises the real construction path
that production code will use. But it is dist weight nobody can reach.

### M3 — no token-level text delta at controller level

`AgentControllerEvent` carries `message_start` / `message_update` /
`message_end`, each with a **whole `MastraDBMessage`**. There is no top-level
`text_delta` (there *is* a `subagent_text_delta`, which makes the omission look
accidental).

So a terminal re-renders the entire in-flight message on every update rather
than appending. Survivable — `LiveRegion` is mutable by design and this is what
`src/ui/App.tsx` does — but it means the fine-grained path (`agent.stream()`'s
`fullStream`, which *does* have `text-delta`) and the controller path are not
interchangeable, and the docs never show them composed.

**Consequence for the design:** if token-smooth painting matters, the harness
has to reach past `AgentController` to the underlying stream, which reintroduces
the two-event-model problem this adapter was meant to close.

### M4 — `AgentControllerDisplayState` is undocumented in shape

`display_state_changed` is described as a complete render snapshot. No published
field list; `defaultDisplayState` is exported but the type is not spelled out
anywhere reachable. A snapshot is also the wrong shape for scrollback-safe
terminal output, which wants append-only deltas rather than diff-a-snapshot.

Ignored entirely in the adapter. That may be leaving real value on the table.

### M5 — a ~50-member event union for eleven facts

`AgentControllerEvent` covers observational-memory cycles, subagent lifecycles,
workspace status, goal evaluation, token usage. Nothing is *wrong* here — but
every consumer must write the same normalising `switch`, and Mastra's own churn
(core 1.61.0, with a hard `stream`/`streamVNext`/`streamLegacy` rename already
behind it) lands directly on that switch. This is why `src/adapter/mastra.ts`
exists and is the only file allowed to import Mastra's vocabulary.

### M6 — model ids are unvalidated router strings

`model: 'anthropic/claude-sonnet-4-6'` is a plain string resolved at runtime
against auto-detected provider env vars. A typo is a runtime error, and "why is
this unauthenticated" is hard to diagnose because auth is implicit. No
compile-time surface at all.

### M7 — telemetry on by default

`@mastra/core` depends on `posthog-node`. A review item before this ships in a
product, not a bug.

---

## fancy-tui

Version tested: **0.10.0** (peers `ink@^7.1.0`, `react@^19.2.0`, node `>=22`).
Nothing here blocked the skeleton — the component set covered every surface
needed. These are friction points.

### F1 — `Composer` is too small an API for an agent prompt *(the real one)*

```ts
Composer({ id, value, onChange, onSubmit, placeholder })
```

That is the whole surface. An agent composer also needs, at minimum:

- **`busy` / `disabled`** — the skeleton signals "working" through `placeholder`
  text, which is a hack. There is no way to visually disable submission while a
  turn runs.
- **`cursor` / `onCursorChange`** — the composer owns the cursor internally, so
  `read()` on the composer surface reports a cursor the harness *computed*
  rather than one the component *reported*. That is a small reintroduction of
  exactly the inference this project exists to remove, at the last hop.
- **`onCancel` / Esc** — no interrupt affordance.
- **history (up/down)** — every coding TUI has it.

`MultilineInput` is richer (grapheme-aware buffer, selection, enhanced-keyboard
support) and is probably the right base, but then `Composer`'s submit semantics
have to be rebuilt by hand. **Filing the cursor point at least is worth it.**

### F2 — `Text` carries two styling vocabularies

`TextProps extends` Ink's `TextProps`, so `color`, `bold` and `dimColor` are all
accepted alongside the token-based `tone`. Writing `<Text dim>` fails
(TypeScript catches it, which is good) but `<Text dimColor>` would compile and
silently bypass the theme. A themed component that also accepts raw Ink styling
props makes the un-themed path the easier one to reach for.

### F3 — no streaming/partial notion on `MessageData`

`MessageData` is `{ id, role, content, name?, timestamp? }` — `content` is a
plain string. The committed/live split has to be built by the consumer:
`MessageList` for committed, a hand-assembled `LiveRegion` for in-flight. The
`fancy-ui:tui` skill documents exactly this pattern, so it is intentional, but
it means every agent TUI writes the same 20 lines. A `<StreamingMessage>` or a
`pending` flag on `MessageData` would carry the pattern in the library.

### F4 — `TuiSurfaceCommand.policy` values are undocumented at the point of use

`ActionPolicy = 'observe' | 'execute' | 'propose' | 'confirm' | 'human-only'`.
Reasonable, but the type is only discoverable by reading `.d.mts`; the registry
docs do not enumerate them or say which one gates what. I guessed `'auto'`
first, which does not exist. Small docs gap.

### F5 — `TuiSurfaceRegistry` has no built-in MCP bridge in this package

`createTuiSurfaceRegistry()` gives `register` / `list` / `get` / `subscribe`.
Wiring it to MCP needs `@particle-academy/agent-integrations`
(`registerTuiBridge(server, { registry, eventStore })`) — a separate package,
not a peer dependency, and not mentioned in `fancy-tui`'s README. Deferred here
(`src/bridge/genie.ts` speaks to Genie's endpoint directly), but that means the
skeleton has **not** yet proven the generic Human+ path, only the Genie one.
Flagged as deferred work, not as a defect.

---

## ink-testing-library

### I1 — `not.toThrow()` is a vacuous assertion

`render()` swallows a component's render error and returns an empty frame. So:

```ts
expect(() => draw(boot())).not.toThrow();   // PASSES against a component that throws
```

Caught live: the "mounts without a TTY" test **passed while `App` was still a
stub that threw `not implemented`**. Rewritten to assert on frame content.

Worth knowing generally: any Ink smoke test must assert the *frame*, never the
absence of a throw.

---

## Genie

### G1 — `agentinbox` has no `reportState` action *(the one that matters)*

The whole design rests on the harness telling Genie what Genie currently infers.
The transport is fine; the receiver does not exist.

Probed live against this terminal's real endpoint:

```
POST $GENIE_MCP_URL
{"method":"tools/call","params":{"name":"agentinbox",
 "arguments":{"action":"reportState","state":{"turn":{"state":"idle"}}}}}

HTTP 200
{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":
 "agentinbox requires `action`: list | send | receive | receipts |
  saveAttachment | registerSession | setAccessibility | join | leave."}}
```

So: transport works, endpoint authenticates, frame is valid JSON-RPC — and the
action is simply absent. `src/bridge/genie.ts` emits the frame Genie *would*
need to accept, which makes it a concrete proposal rather than a description of
one. Failures are swallowed, because an unreported harness must still be a
working coding agent.

**Needed in Genie:** `reportState` on `agentinbox` (or a new `harness` tool),
plus consumers in `wake.ts` / `draft.ts` that prefer a declared state over an
inferred one when the provider supplies it.

### G2 — the provider set is a closed union restated ~37 times

Adding a provider is not adding a `LAUNCH_PROFILES` entry. It is ~37 edit sites,
of which only ~11 are compiler-enforced. The dangerous ones are silent:

- `main/agents/identity.ts` — `PROVIDERS` literal. Miss it and `isAgentProvider`
  returns false, so `savedAgentsOf` **silently skips** the agent.
- `main/mcp/protocol.ts` — the `runAgent.agent` JSON-Schema enum. Without it an
  agent cannot name the provider at all.
- `renderer/lib/recipes/workstation-setup.ts` — mirrors genie-cloud's
  `AGENT_CATALOG` **by hand**, i.e. a cross-repo sync obligation.

There is **no provider registry and no plugin route** to contribute one.

### G3 — late session registration is hardcoded to Codex

`main/agentinbox/session-registration.ts`:

```ts
if (spec.meta?.agent !== 'codex')
    return { ok: false, error: 'Late session registration is only supported for Codex agents.' };
```

Not blocking for this design — `genie` binds its chat-id at launch — but any
provider that ever needs late binding hits a hard gate.

### G4 — resume and restart are hardcoded to Claude

`renderAgentResume` and `renderAgentContinue` both `return null` unless
`agent === 'claude'`. So a `genie` provider would launch fine and then have **no
graceful restart**, with `runAgent restart` refusing. This one *does* bite,
because it is a capability the first-party harness could support better than
either vendor: the session id is ours and it is in storage.

### G5 — server-push is a probe whose central question is unanswered

`main/mcp/server-push.ts` ships `streamsOpened` / `streamsWithSession` /
`pushesReached` counters because nobody knows whether a real MCP client opens
the GET SSE stream. A first-party TUI answers it by construction — but the
skeleton **does not open the stream yet**. Deferred; it is the obvious next
increment and would turn Genie→TUI delivery from theory into a measurement.

### G6 — provider marks are placeholders

`TERMINAL_TYPES` maps `claude` to the **Tynn** logo and `codex` to a generic
box. Adding a fourth is one entry, but the existing three should be fixed at the
same time rather than a fourth placeholder joining them.

---

## Deferred, deliberately

Not gaps — scope calls, recorded so they are not mistaken for oversights.

- **Real tools.** No file/edit/shell tools. Mastra's `Workspace` + `LocalSandbox`
  cover them; they are not what the skeleton is proving.
- **Memory.** No `@mastra/memory`, no semantic recall, no storage backend — so
  nothing persists across runs, and **Mastra's HITL suspend/resume needs storage**,
  which is why approvals are rendered but not yet resolvable.
- **The generic Human+ MCP bridge** (F5) — Genie's path only, so far.
- **Genie→TUI push** (G5).
- **Tynn board surface.** Designed, not built.
- **The `PROVIDER_REGISTRY` refactor** (G2) — reported as a separate finding, and
  explicitly not attempted: three agents are working in Genie's agent/terminal
  model right now.
