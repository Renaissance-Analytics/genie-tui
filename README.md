# genie-tui

A first-party coding-agent harness for Genie — a third **provider** alongside
Claude Code and Codex, built on **Mastra** for the agent runtime and
**`@particle-academy/fancy-tui`** for the terminal surface.

**Status: it builds, installs and works as a coding agent.** It reads, lists
and searches a workspace, writes files with your approval, and declares its
state instead of being sniffed. It does not run shell commands, and nothing
persists between runs. See [`GAPS.md`](GAPS.md) for the rest.

For ten releases it did neither of the first two: `bin` pointed at
`./dist/cli.js` and no script produced `dist/`, so there was nothing to install
— and the first frame it painted in a terminal was also its last, because two
Human+ surfaces registered under the same id and the registry throws on
duplicates. Both are fixed, and both now have the test that would have caught
them.

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
npm run build     # produces dist/, which `bin` points at
npm test          # 130 tests; builds first, so the artifact under test is current
npm run typecheck

node dist/cli.js --help
node dist/cli.js --print        # boot, report surfaces + tools as JSON, exit
node dist/cli.js                # the TUI (needs a real terminal)
```

The binary is **`genie`**, matching `TUI_REGISTRY.genie.defaultCommand` in
Genie. It was `genie-tui` here for long enough that Genie had to fix the
mismatch on its own side after `bash: genie-tui: command not found`.

`npm test` builds before it runs. That is deliberate: a suite that asserts on a
`dist/` somebody left behind can pass against code that no longer exists.

### Which model

Local first, cloud as the fallback, decided in `model.ts` and asserted in
`model.test.ts` — a configured local endpoint wins even when a cloud key is
also present, and it needs no credential.

```bash
node dist/cli.js --model-url http://127.0.0.1:11434/v1 --model qwen3-coder
```

That object form is the only one that can carry a URL, and it is what Ollama,
llama.cpp, LM Studio and vLLM all speak. A bare model name is namespaced
`local/` on purpose: Mastra strips `temperature`/`topP`/`topK` for any model
absent from its hardcoded list, and *absent* means unlisted rather than
unsupported — so a provider id its registry recognises silently discards your
sampling config.

With no endpoint and no key it runs against `offline-model.ts` and says so,
rather than pretending to be a coding agent.

## Tools, and who says yes

`read_file`, `list_dir`, `search_files`, `write_file`. Every path is resolved
against the working directory **and realpathed**, so a symlink that sits inside
the workspace and points at `/etc` is refused — a prefix check cannot see that
one. Output is capped and says when it truncated, because the target is local
models where 8k context is common.

Reading is free. Anything that changes the workspace stops and asks, showing the
arguments — `y` approves, `n` declines. `--yes` approves everything, for
unattended runs.

Every tool is offered to the model, including `write_file`. Hiding it would be a
permission model the human never participates in: a model that cannot see the
tool cannot ask, so the agent just seems unable rather than asking to be
allowed.

## How Genie would launch it

Exactly as it launches the other two — a command in a pty, with `GENIE_MCP_URL`
and `GENIE_TERMINAL_ID` already in the environment:

```
genie --session-id <uuid> --name <agent-name>
```

Provider id `genie`, which now exists in Genie's `TUI_REGISTRY` with
`defaultCommand: 'genie'` — so the chat-id binds **at launch** and becomes the
Mastra thread id. Codex's late-binding path exists
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

Three of them exist because of what they caught:

- `dist.test.ts` asserts on the ARTIFACT — a build script exists, the bin is
  named `genie`, and `npm pack --dry-run` actually CONTAINS `dist/cli.js`. That
  last one is a separate failure mode: `dist/` is gitignored, npm falls back to
  `.gitignore` when there is no `files` array, so a correct build could still
  ship a tarball with no entry point in it.
- `cli.test.ts` EXECUTES the built file and drives it — paints, takes typed
  characters, submits, completes a turn, exits on Ctrl-C. A build that exits 0
  and has never been run is the assumption that created this repository's
  situation.
- `composition.test.tsx` mounts what the CLI mounts, provider and all.
  `app.test.tsx` renders `App` with no `TuiSurfaceProvider`, which makes every
  `fancy-tui` component's surface registration a silent no-op — so the id
  collision that killed the app on mount was invisible to it. A component test
  that omits the provider is testing a different program from the one that
  ships.

`tool-turn.test.ts` is the one worth copying: it stands up an OpenAI-compatible
server that asks for a tool, then asserts the SERVER was sent the file's real
contents back. Without that control, the canned answer would pass against a tool
that never touched the disk.
