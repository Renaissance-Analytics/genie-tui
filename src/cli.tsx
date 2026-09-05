#!/usr/bin/env node
import fs from 'node:fs';
import React, { useEffect, useState } from 'react';
import { render } from 'ink';
import { TuiSurfaceProvider, createTuiSurfaceRegistry } from '@particle-academy/fancy-tui';

import { App } from './ui/App.js';
import { createGenieBridge } from './bridge/genie.js';
import { createHarness } from './harness.js';
import { mastraRuntime } from './runtime/mastra.js';
import { resolveModel } from './model.js';
import { harnessSurfaces, SURFACE_IDS } from './surfaces.js';
import { autoApprovePolicy, harnessTools, toolNames } from './tools.js';
import type { Harness } from './harness.js';
import type { HarnessState } from './protocol.js';

/**
 * Entry point. Genie spawns this in a pty exactly as it spawns Claude Code or
 * Codex — `genie --session-id <uuid>` — with `GENIE_MCP_URL` and
 * `GENIE_TERMINAL_ID` already in the environment.
 *
 * The binary is `genie`, matching `TUI_REGISTRY.genie.defaultCommand` in Genie
 * (`main/agents/registry.ts`). It was `genie-tui` on this side for long enough
 * that Genie had to fix the mismatch on its own, after selecting the provider
 * produced `bash: genie-tui: command not found`.
 */

/** A flag with a value: `--name x` or `--name=x`. */
function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    const next = process.argv[i + 1];
    if (i >= 0 && next !== undefined && !next.startsWith('-')) return next;
    const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
    return inline?.slice(name.length + 3);
}

/** A bare flag. Separate from {@link arg} so `--print --name ci` is not read as
 *  `print === '--name'`. */
function flag(...names: string[]): boolean {
    return names.some((n) => process.argv.includes(n));
}

/** The shipped version, read from the package rather than duplicated in source
 *  where it would drift on the first release nobody thought about. */
function version(): string {
    const pkg = JSON.parse(
        fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
}

const USAGE = `genie — Genie's first-party coding-agent harness

Usage
  genie [options]

Options
  --name <name>          Agent name, as Genie addresses it. Default: genie
  --session-id <id>      Genie chat-id to bind to. Default: a fresh uuid
  --model <id>           Model id. Default: $GENIE_TUI_MODEL
  --model-url <url>      OpenAI-compatible base URL — an Ollama, llama.cpp,
                         LM Studio or vLLM server. Default: $GENIE_TUI_MODEL_URL
  --yes                  Approve every tool call without asking. For unattended
                         runs only; the default stops and asks before any change
                         to the workspace. Nothing reaches outside the working
                         directory either way.
  --print                Boot, report the surfaces and tools as JSON, exit. No
                         terminal required, so it is also the health check.
  --version              Print the version
  --help                 This

Environment (set by Genie when it launches the terminal)
  GENIE_MCP_URL          Per-terminal MCP endpoint the harness reports to
  GENIE_TERMINAL_ID      The terminal this agent is running in
`;

function Root({ harness }: { harness: Harness }): React.JSX.Element {
    const [state, setState] = useState<HarnessState>(harness.state());
    useEffect(() => harness.subscribe(setState), [harness]);

    return (
        <App
            state={state}
            actions={harness.actions}
            // Composer edits go through the harness, so the state Genie is
            // told about is the same state that is on screen.
            onChange={(text) => harness.actions.setText(text)}
            onSubmit={(text) => void harness.send(text)}
        />
    );
}

/**
 * Refuse to start the interactive UI without a terminal, and say why.
 *
 * Ink needs raw mode for `useInput`, and the composer is nothing but input
 * handling, so a non-TTY stdin cannot work. Left alone, Ink throws from inside a
 * React effect and the operator gets twenty lines of react-reconciler stack —
 * indistinguishable from a broken install, which is exactly the wrong
 * impression for THIS binary to give given its history.
 *
 * Requiring a terminal is correct behaviour, not a limitation to paper over.
 * The fix is to state the requirement in one line and name the flag that works
 * without one.
 */
function requireTerminal(): void {
    if (process.stdin.isTTY) return;
    process.stderr.write(
        'genie: needs an interactive terminal — stdin is not a tty, so there is no way to read keys.\n' +
            '       Genie launches this in a pty. To run it yourself, start it from a terminal;\n' +
            '       for a non-interactive check use `genie --print`.\n',
    );
    process.exit(1);
}

async function main(): Promise<void> {
    if (flag('--help', '-h')) {
        process.stdout.write(USAGE);
        return;
    }
    if (flag('--version', '-v')) {
        process.stdout.write(`${version()}\n`);
        return;
    }

    const printOnly = flag('--print');
    // Checked BEFORE the harness is built. Standing up an AgentController and a
    // session only to discover there is nowhere to draw wastes the startup and
    // buries the real message under whatever the runtime logs on the way.
    if (!printOnly) requireTerminal();

    const sessionId = arg('session-id') ?? crypto.randomUUID();
    const name = arg('name') ?? 'genie';

    const model = resolveModel({
        model: arg('model'),
        modelUrl: arg('model-url'),
        env: process.env,
    });
    if (model.kind === 'invalid') {
        process.stderr.write(`genie: ${model.reason}\n`);
        process.exit(2);
    }

    // The workspace is the process's cwd — Genie launches the terminal there,
    // so the agent's reach is the same folder the human is looking at.
    const tools = harnessTools({ cwd: process.cwd() });

    // Read freely, ask before changing anything. `--yes` collapses that to
    // "approve everything", which is a real need for an unattended run and a
    // terrible default: the gate is the only thing standing between a model's
    // guess and the user's files.
    const approveEverything = flag('--yes');
    const autoApprove = approveEverything ? () => true : autoApprovePolicy(tools);

    const harness = await createHarness({
        name,
        cwd: process.cwd(),
        sessionId,
        autoApprove,
        // The ONE place a runtime is chosen, and the entry point states only
        // WHAT it wants to talk to. Swapping Mastra out is a change in
        // runtime/mastra.ts and this one line — which is why no vendor is
        // imported anywhere in this file.
        runtime: mastraRuntime({ model, tools }),
    });

    // The Human+ registry: the same surfaces Genie reads are the ones any
    // Human+ MCP client reads. Not a Genie back door.
    const registry = createTuiSurfaceRegistry();
    for (const surface of harnessSurfaces(() => harness.state(), harness.actions)) {
        registry.register(surface);
    }

    const bridge = createGenieBridge({
        url: process.env['GENIE_MCP_URL'],
        terminalId: process.env['GENIE_TERMINAL_ID'],
    });
    harness.subscribe((s) => bridge.schedule(s));
    void bridge.report(harness.state());

    if (printOnly) {
        // Non-interactive smoke, for CI and for `--print`: prove the stack boots
        // and the surfaces answer, without needing a TTY.
        const out = {
            offline: model.kind === 'offline',
            model: model.kind === 'remote' ? { id: model.id, url: model.url ?? null } : null,
            bridge: bridge.enabled,
            tools: toolNames(tools),
            // What this agent may do WITHOUT asking. Reported because it is the
            // one question an operator should be able to answer about an agent
            // without starting a turn and finding out.
            approval: approveEverything ? 'all' : 'ask-before-changes',
            surfaces: registry.list().map((s) => s.id),
            session: registry.get(SURFACE_IDS.session)?.read(),
            turn: registry.get(SURFACE_IDS.turn)?.read(),
            composer: registry.get(SURFACE_IDS.composer)?.read(),
        };
        process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
        await harness.dispose();
        return;
    }

    const { waitUntilExit } = render(
        <TuiSurfaceProvider registry={registry}>
            <Root harness={harness} />
        </TuiSurfaceProvider>,
    );
    await waitUntilExit();
    bridge.dispose();
    await harness.dispose();
}

main().catch((err: unknown) => {
    process.stderr.write(`genie: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
});
