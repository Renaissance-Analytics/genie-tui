# Gaps

What was tried, what was expected, what had to be done instead. Every workaround
here is a design gap in something — Mastra, `fancy-tui`, the Fancy backends, or
Genie. Recorded as they were hit while building the walking skeleton, not
reconstructed afterwards.

**G0 is filed as genie#261.** Everything else is unfiled. Fancy items are
**issue-first** by protocol — file on the Fancy repo, never clone-fix-publish.

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

### M7 — `session.model.switch()` cannot reach a local endpoint *(blocking, must build around)*

**Tried:** let the user pick a local model at runtime — the owner's "local models
first" constraint requires model choice to be a runtime concern, not a constant.

**Expected:** `session.model.switch()` to accept whatever `new Agent({ model })`
accepts, since the object form `{ id: 'ollama/x', url: 'http://localhost:11434/v1' }`
works beautifully at construction — `url` short-circuits the whole gateway/auth
chain and defaults `apiKey` to `''`, so a keyless local server just works.

**Got:** `switch({ modelId: string, scope?, modeId? })`. **String only.** There is
nowhere to attach a URL through `AgentController`, and `AgentControllerConfig` has
no per-model URL map either.

**Instead:** the TUI has to ship its own `MastraModelGateway` (~40 lines,
registerable via `new AgentController({ gateways: [...] })`). Not avoidable, so
it is budgeted as a component rather than logged as a workaround.

Compounding it: **there is no `ollama` provider id at all.** The bundled
178-provider registry has `ollama-cloud` (Mastra's paid API) and `lmstudio`;
local Ollama is punted to a third-party AI SDK package. `'ollama/llama3.3'`
throws *"Could not find config for provider ollama"*. And `lmstudio/*` demands
`LMSTUDIO_API_KEY` even though the server needs no auth — a keyless local server
is rejected with a missing-key error until you set a dummy.

### M8 — sampling params are silently stripped for unlisted models *(nasty)*

`stripUnsupportedSamplingParams()` deletes `temperature`, `topP` **and** `topK`
when `modelSupportsTemperature(id)` is false — and false means *"provider known,
model not in our list"*, not *"model rejects it"*. Measured:

| model id | temperature survives |
|---|---|
| `lmstudio/qwen/qwen3-coder-30b` | yes — one of 3 hardcoded |
| `lmstudio/mistral-7b-instruct` | **no — silently stripped** |
| `llamacpp/anything` | yes — provider unknown, no lookup |

So any LM Studio model outside Mastra's hardcoded three loses its sampling config
with no warning, surfacing to a user as "why is my local model incoherent".
Workaround: use a provider id *not* in the bundled registry so the lookup returns
`undefined` and the params survive. That is a real workaround, and an ugly one —
correct behaviour depends on being *unknown* to the registry.

### M9 — no context-window metadata anywhere

Zero `context` / `limit` / `window` keys across the 178 provider entries and 178
capability files. Nothing in Mastra knows an 8k model is 8k, so `TokenLimiter`
limits, `lastMessages`, and OM thresholds must all be hand-tuned per model —
exactly the toil a local-first TUI wants automated. **Instead:** the TUI owns a
model-profile table. Reasonable to own, but it is Mastra's data to publish.

### M10 — no tool-call repair, and no schema-compat layer for local endpoints

`experimental_repairToolCall` exists in the vendored AI SDK types but Mastra's
loop never plumbs it through, so malformed tool JSON from a 7B model surfaces as
an error chunk with no retry. `structuredOutput.jsonPromptInjection` is a genuine
prompt-based fallback but covers **structured output, not tool calls**.

Separately, `@mastra/schema-compat` has layers for Anthropic/DeepSeek/Google/
Meta/OpenAI only. **A local model behind a generic OpenAI-compatible endpoint gets
full unmodified Zod→JSON-Schema** — nested unions, refinements, format constraints
— which is precisely what small models fumble. **Instead:** write our own
`SchemaCompatLayer`. Also: `structuredOutput` capability data for local providers
is `undefined`, so `jsonPromptInjection: 'auto'` cannot make an informed choice —
set it explicitly.

### M11 — Observational Memory defaults to a cloud call, and its runtime switcher is string-only

Mastra's answer to context growth is OM (compaction is explicitly *"not provided
out of the box"*). Two findings, and the first is milder than it first looked.

**The cloud dependency is a default, not a constraint.**
`ObservationalMemoryObservationConfig.model` and its reflection counterpart are
both typed `AgentConfig['model']` — the same type `new Agent({ model })` takes —
so the object form `{ id: 'ollama/…', url: 'http://localhost:11434/v1' }` is
accepted. Compile-verified, not inferred. But **left unset it is
`google/gemini-2.5-flash`** (`@default` in the source), i.e. an unrequested cloud
call in a local-first product. A silent default is a poor choice for a model
selection; it should have no default, or an explicit opt-in.

**The runtime switcher cannot express a local endpoint.**
`AgentControllerOMConfig.defaultObserverModelId` and
`session.om.observer.switchModel({ modelId })` are both `string` — the same wall
as M7. So a local Observer can be *pinned at construction* with no gateway, but
cannot be *selected at runtime* without one.

**Correction to an earlier version of this entry**, which said OM must stay off
because it runs two background agents contending for VRAM. The thresholds say
otherwise: observation fires only above `messageTokens` (default 30,000) and
reflection above `observationTokens` (default 40,000), so it is **zero extra
calls on a typical turn**, not continuous load. The real local constraint is that
the Observer ingests up to `maxTokensPerBatch` (default 10,000) in ONE call, so
it needs more context than the main loop may have.

### M12 — the model catalogue needs the network

`listAvailableModels()` calls each gateway's `fetchProviders()`, live against
`https://models.dev/api.json`. `MASTRA_OFFLINE=true` prevents the fetch, but then
the picker is limited to the bundled snapshot — which, per M7, contains no local
Ollama entry. A fully-offline machine gets a model picker that cannot list the
models it can actually run.

### M13 — ~4,050 tokens of always-resident prompt

Measured by executing `buildBasePrompt()` with a minimal context: 10,161 chars
(~2,540 tokens), plus ~800 for six controller built-in tool descriptions, ~656 for
ten workspace tools, ~61 for the workspace blurb — **~4,050 tokens before a single
message**, excluding JSON schemas for 16 tools. That is half an 8k window.

Not a defect — `buildBasePrompt` is a plain `(ctx) => string` and trivially
replaceable, and `disableBuiltinTools` exists. But it means **"use Mastra's coding
agent as-is" is not viable below ~32k context**, which is most local setups.

### M14 — telemetry on by default

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

### G0 — adding a provider is a ~37-site sweep, only ~11 compiler-enforced *(FILED: genie#261)*

**Tried:** register `genie` as a third agent provider, expecting to add one
`LAUNCH_PROFILES` entry — the shape the codebase advertises.

**Expected:** a provider registry, or at minimum a single closed union the
compiler would walk me through.

**Got:** the provider set is a string-literal union **restated in ~37 places**,
measured on `origin/main` @ `49fa6f2`:

| category | non-test sites | compiler-enforced? |
|---|---|---|
| type-union restatements (`'claude' \| 'codex' \| 'custom'`) | 12 | **yes** |
| runtime literal arrays / JSON-Schema enums | 3 | **no** |
| per-provider hardcoded `if`/ternary branches | 17 | no |
| `agent_command_<id>` / `agent_flags_<id>` settings keys | 52 occurrences across 12 files | no |

The unenforced half is the dangerous half, because the failure is silence:

- `main/agents/identity.ts:92` — `PROVIDERS` is typed `readonly string[]`, so it
  is *deliberately* outside the union. Miss it and `isAgentProvider()` returns
  false, which makes `savedAgentsOf` **silently skip every agent of the new
  provider**. Nothing throws.
- `main/mcp/protocol.ts:2047` — the `runAgent.agent` JSON-Schema enum. Miss it and
  an agent cannot name the provider over MCP at all, whatever the types say.
- `main/agentinbox/session-capture.ts:121,139` — `renderAgentResume` and
  `renderAgentContinue` both `if (agent !== 'claude') return null`, so **any
  non-Claude provider has no graceful restart**.
- `renderer/lib/recipes/workstation-setup.ts` mirrors genie-cloud's
  `AGENT_CATALOG` **by hand** — the sweep does not even end at this repo.

There is **no provider registry and no plugin route**. `PluginContributes`
(`main/plugins/manifest.ts`) offers `mcpTools | editors | panels | recipes`, with
`flyouts | modals | wizards | workstationPage | workspaceSettingsPage` reserved.
Nothing provider-shaped — so a third party cannot contribute one.

**Instead:** stopped, filed **genie#261**, and did not touch Genie. The owner has
since made the `PROVIDER_REGISTRY` refactor the *first* piece of work, ahead of
the TUI. It must sequence behind PR #258 and Codex's harness-startup work, which
are live in the same files.

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

### G7 — the four memory classes are implemented but unreachable *(the memory one)*

**Tried:** write a `procedural` memory node through Genie's `knowledge` MCP tool,
rather than building a second store in the TUI.

**Expected:** to pass `class: 'procedural'`. The store genuinely supports it —
migration v38 added the `class` column, `store.add()` **refuses** an unknown class
rather than coercing it, `store.search()` filters by class with over-fetch so
narrowing does not starve `limit`, and 11 tests cover per-class isolation and
cross-class linking. The framing is documented in `main/knowledge/types.ts:17-34`.

**Got:** `class` does not exist on `KnowledgeToolRequest`, is absent from the MCP
JSON schema — which is `additionalProperties: false`, so passing it would be
**rejected** — is dropped by the MCP dispatcher, is absent from both IPC handlers,
and is absent from all 940 lines of the renderer. Agent-facing docs never mention
classes.

**Consequence: 100% of knowledge nodes written today are `class: 'knowledge'`.**
The feature is finished one layer below every caller that could reach it.

Worse, it is **write-once**: `KnowledgeUpdateInput` has only
`title | body | tags | links`, so there is no path — MCP, IPC or store API — to
reclassify. Any backfill needs a schema/API change or raw SQL.

**Instead:** deferred. The fix is ~12 lines across four files, but it is a Genie
change, so it is a separate finding and a separate PR.

### G8 — episodic memory has no schema to stand on

`episodic` answers *"what happened, and when?"* A knowledge node carries only
`source: 'agent' | 'user'` — a binary. There is **no agent identity, no workspace,
no session id, and no *occurred-at* distinct from *created_at*** (which is when it
was recorded, not when it happened).

So even with G7 fixed, an episodic node cannot answer "when did this happen", "who
did it", or "in which project". Genie schema change.

### G9 — nothing writes episodic memory, and nothing ever will by accident

There is **no automatic capture of any kind** in Genie: no session-end hook, no
transcript summariser, no ingestion of `.ai/knowledge/*.md`. Every node is a
deliberate act by an agent or the user via MCP/IPC.

Memory that depends on an agent *remembering* to write it is the class least
likely to get written — the same shape of problem as `imDone` being forgotten.

**This is the one the TUI can actually fix**, because a first-party harness owns
the turn boundary and can write on turn-end without the model's cooperation. It is
on the build list (§4.3), not deferred.

### G10 — no embeddings anywhere in Genie, and no plugin memory contribution point

Confirmed absent: no `sqlite-vec`, no `fastembed`, no ONNX, no cosine similarity,
no ANN index, no embedding dependency in `package.json`. Retrieval is FTS5 bm25
with a LIKE fallback. The store's own comment scopes the future: a semantic layer
*"on top of `search` with a graceful fallback to this floor."*

That is **correct for local-first** and not a complaint — but it means semantic
recall over durable memory is a Genie schema change, not a switch.

Separately, `PluginContributes` has no memory/knowledge entry (and plugin workers
are fs-only), so a plugin cannot contribute a memory provider, an embedding
backend, or an ingestion source — which is exactly the pluggable
`AgentMemoryProvider` shape the agent-resources doc recommends.

Two smaller ones found alongside: the `class` column has **no DB-level CHECK
constraint** (unlike `source` and `kind`), and reads silently coerce an
unrecognised value back to `knowledge` — hiding corruption rather than surfacing
it; and **inbound links are stored but never queried**, so there are no backlinks
and no graph traversal, only a full-graph dump for the force-graph renderer.

---

## Deferred, deliberately

Not gaps — scope calls, recorded so they are not mistaken for oversights.

- **Real tools.** No file/edit/shell tools. Mastra's `Workspace` + `LocalSandbox`
  cover them; they are not what the skeleton is proving.
- **Memory.** No `@mastra/memory`, no semantic recall, no storage backend — so
  nothing persists across runs, and **Mastra's HITL suspend/resume needs storage**,
  which is why approvals are rendered but not yet resolvable. Durable memory is
  Genie's knowledge graph (G7–G10), not a second store; an external backend such
  as Supermemory sits behind an interface and is not a v1 dependency.
- **Local-model support.** The `MastraModelGateway` (M7), the model-profile table
  (M9) and the local `SchemaCompatLayer` (M10) are designed and budgeted, not
  built. The skeleton runs against whatever `ANTHROPIC_API_KEY` finds, or its own
  offline model — i.e. it does not yet prove the local path.
- **Observational Memory** (M11) — works locally when its model is set
  explicitly; deferred as scope, not as a limitation.
- **The generic Human+ MCP bridge** (F5) — Genie's path only, so far.
- **Genie→TUI push** (G5).
- **Tynn board surface.** Designed, not built.
- **The `PROVIDER_REGISTRY` refactor** (G2) — reported as a separate finding, and
  explicitly not attempted: three agents are working in Genie's agent/terminal
  model right now.
