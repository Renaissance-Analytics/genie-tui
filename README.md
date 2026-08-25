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
| `src/adapter/mastra.ts` | the **only** file that knows Mastra's vocabulary. |
| `src/harness.ts` | Mastra `AgentController` + `Session`, embedded in-process. |
| `src/surfaces.ts` | `fancy-tui` Human+ surfaces — the integration contract. |
| `src/bridge/genie.ts` | reports state over Genie's per-terminal MCP endpoint. |
| `src/ui/App.tsx` | the surface. `MessageList` (committed) + `LiveRegion` (live). |
| `src/offline-model.ts` | a minimal AI SDK v2 model, so it runs with no API key. |

The dependency rule: `protocol` and `reduce` import nothing; `ui` and `bridge`
import `protocol` but never Mastra. Upstream churn lands in `adapter/` alone.

## Run

```bash
npm install
npm test          # 59 tests
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

## Tests

TDD throughout: failing test first, confirmed red for the right reason, then
implement. Two of these are the design argument written as assertions —

- `reduce.test.ts` → *"stays busy across a long, silent tool call"*
- `surfaces.test.ts` → *"reports the buffer verbatim, with no confidence caveat"*

`harness.test.ts` boots a **real** Mastra `AgentController` and `Session`, so the
embedding claim is checked rather than believed. `bridge.test.ts` runs over real
HTTP against a stub endpoint, because the JSON-RPC frame *is* the deliverable and
a mock would let a wrong one pass.
