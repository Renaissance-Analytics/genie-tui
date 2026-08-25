# genie-tui

A first-party coding-agent harness for Genie — a third **provider** alongside
Claude Code and Codex, built on **Mastra** for the agent runtime and
**`@particle-academy/fancy-tui`** for the terminal surface.

**Status: walking skeleton.** It boots, runs a real Mastra turn, renders, and
reports itself. It is not yet a usable coding agent — there are no file or shell
tools, and nothing persists. See [`GAPS.md`](GAPS.md).

Design: [`.ai/_discovery/genie-native-tui.md`](../../_discovery/genie-native-tui.md).

## Why this exists

Genie has to know two things about every agent terminal: what is in the input
box, and whether the agent is mid-turn. Neither Claude Code nor Codex will say,
so Genie **reconstructs both from pty bytes** — a keystroke-folded model of the
input box (`main/agentinbox/draft.ts`) and busy-ness inferred from fifteen
seconds of measured output silence (`main/agentinbox/wake.ts`).

Those inferences fail silently. genie#218: a notice arrived as one chunk, was
read as a paste, and its newline never submitted. genie#257: Codex's Kitty-mode
Enter (`CSI 13 u`) destroyed draft confidence on *every* submit, degrading every
nudge to append-only for a release cycle, with no error.

A first-party harness does not need to be sniffed. It **declares**. That is the
justification for the whole project, and it is the thing the tests assert.

## Layout

| path | what |
|---|---|
| `src/protocol.ts` | the harness protocol — state + a closed event union. No dependencies. |
| `src/reduce.ts` | pure `reduce(state, event, now)`. Where turn state is derived. |
| `src/runtime.ts` | **our** agent-runtime interface. Mastra is temporary; this is the seam it leaves through. |
| `src/runtime/mastra.ts` + `src/adapter/mastra.ts` | the only files that know Mastra exists. |
| `src/harness.ts` | Mastra `AgentController` + `Session`, embedded in-process. |
| `src/surfaces.ts` | `fancy-tui` Human+ surfaces — the integration contract. |
| `src/bridge/genie.ts` | reports state over Genie's per-terminal MCP endpoint. |
| `src/ui/App.tsx` | the surface. `MessageList` (committed) + `LiveRegion` (live). |
| `src/offline-model.ts` | a minimal AI SDK v2 model, so it runs with no API key. |

The dependency rule: **nothing above `src/runtime.ts` may import a vendor.**
`protocol` and `reduce` import nothing at all; `harness`, `ui`, `bridge` and
`surfaces` are written against `HarnessEvent`, which we define. Swapping the
runtime is one new file implementing `Runtime`.

That is enforced, not asked for: `runtime-boundary.test.ts` runs the whole
harness against a hand-written runtime AND reads the files above the seam as
source, failing on any `@mastra` import — with a positive control asserting the
adapter below it still has one. An earlier version of this README claimed the
seam existed when it did not (GAPS H2); it is now a test rather than a promise.

## Local models first

The product constraint is **local models first, cloud as the fallback**, and
`src/__tests__/local-endpoint.test.ts` proves it rather than asserting it: it
stands up a real OpenAI-compatible server on an ephemeral port and drives a full
turn against it with the object form —

```ts
model: { id: 'local/test-model', url: 'http://127.0.0.1:<port>/v1' }
```

— which is the shape Ollama, llama.cpp, LM Studio and vLLM all speak. No API
key, no model download, no network egress, so it runs identically on every OS in
CI. Its third case points at a dead port and requires the turn to FAIL, which is
what stops the other two passing for the wrong reason.

Two limits worth knowing, both in [`GAPS.md`](GAPS.md): Mastra has no `ollama`
provider id, and `session.model.switch()` takes a string, so a URL cannot be
carried — **runtime** model switching to a local endpoint needs a custom
`MastraModelGateway`.

## Run

```bash
npm install
npm test          # 72 tests
npm run typecheck

npx tsx src/cli.tsx --print                      # non-interactive smoke
npx tsx src/cli.tsx --session-id <uuid> --name x # the TUI
```

With no `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`, …) it runs against
`offline-model.ts` and says so, rather than pretending to be a coding agent.

## How Genie would launch it

Exactly as it launches the other two — a command in a pty, with `GENIE_MCP_URL`
and `GENIE_TERMINAL_ID` already in the environment:

```
genie-tui --session-id <uuid> --name <agent-name>
```

Provider id `genie`, `LAUNCH_PROFILES` entry
`{ strategy: 'flag', flagTemplate: '--session-id {id}' }` — so the chat-id binds
**at launch** and becomes the Mastra thread id. Codex's late-binding path exists
because its session id is unknowable before its harness runs; being first-party,
this takes the easy path deliberately.

Genie does not accept the state report yet — `agentinbox` has no `reportState`
action. See GAPS.md §G1 for the live probe and the exact frame it would need.

## CI

Every push runs the suite on **ubuntu / macOS / windows × Node 22.13 and 24**.
Genie spawns this in a pty on all three, so all three are a requirement, not a
courtesy. The repository is public so that matrix is free — Actions is metered on
private repos and macOS runners bill at a 10x multiplier.

## Tests

TDD throughout: failing test first, confirmed red for the right reason, then
implement. Two of these are the design argument written as assertions —

- `reduce.test.ts` → *"stays busy across a long, silent tool call"*
- `surfaces.test.ts` → *"reports the buffer verbatim, with no confidence caveat"*

`harness.test.ts` boots a **real** Mastra `AgentController` and `Session`, so the
embedding claim is checked rather than believed. `bridge.test.ts` runs over real
HTTP against a stub endpoint, because the JSON-RPC frame *is* the deliverable and
a mock would let a wrong one pass.
