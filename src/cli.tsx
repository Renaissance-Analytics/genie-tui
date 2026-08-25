#!/usr/bin/env node
import React, { useEffect, useState } from 'react';
import { render } from 'ink';
import { Agent } from '@mastra/core/agent';
import { TuiSurfaceProvider, createTuiSurfaceRegistry } from '@particle-academy/fancy-tui';

import { App } from './ui/App.js';
import { createGenieBridge } from './bridge/genie.js';
import { offlineModel } from './offline-model.js';
import { createHarness } from './harness.js';
import { harnessSurfaces } from './surfaces.js';
import type { Harness } from './harness.js';
import type { HarnessState } from './protocol.js';

/**
 * Entry point. Genie spawns this in a pty exactly as it spawns Claude Code or
 * Codex — `genie-tui --session-id <uuid>` — with `GENIE_MCP_URL` and
 * `GENIE_TERMINAL_ID` already in the environment.
 */

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
    const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
    return inline?.slice(name.length + 3);
}

/**
 * Mastra resolves models through its router, keyed off auto-detected provider
 * env vars. With no key there is nothing to talk to, so the skeleton falls back
 * to Mastra's own mock model and SAYS SO in the agent's name — a walking
 * skeleton that silently pretended to be a coding agent would be worse than one
 * that cannot answer.
 */
function buildAgent(): { agent: Agent; offline: boolean } {
    const model = process.env['GENIE_TUI_MODEL'] ?? 'anthropic/claude-sonnet-4-6';
    const hasKey = Boolean(
        process.env['ANTHROPIC_API_KEY'] ??
            process.env['OPENAI_API_KEY'] ??
            process.env['GOOGLE_GENERATIVE_AI_API_KEY'],
    );

    if (!hasKey) {
        return {
            offline: true,
            agent: new Agent({
                id: 'genie-tui',
                name: 'genie-tui (offline)',
                instructions: 'Offline skeleton.',
                model: offlineModel(
                    'No API key set — this is the offline skeleton. Set ANTHROPIC_API_KEY to talk to a model.',
                ) as never,
            }),
        };
    }

    return {
        offline: false,
        agent: new Agent({
            id: 'genie-tui',
            name: 'genie-tui',
            instructions:
                'You are Genie TUI, a first-party coding agent running inside Genie. Be concise.',
            model,
        }),
    };
}

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

async function main(): Promise<void> {
    const sessionId = arg('session-id') ?? crypto.randomUUID();
    const name = arg('name') ?? 'genie';
    const { agent, offline } = buildAgent();

    const harness = await createHarness({ name, cwd: process.cwd(), agent, sessionId });

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

    if (arg('print') !== undefined || process.argv.includes('--print')) {
        // Non-interactive smoke, for CI and for `--print`: prove the stack boots
        // and the surfaces answer, without needing a TTY.
        const out = {
            offline,
            bridge: bridge.enabled,
            surfaces: registry.list().map((s) => s.id),
            session: registry.get('session')?.read(),
            turn: registry.get('turn')?.read(),
            composer: registry.get('composer')?.read(),
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
    process.stderr.write(`genie-tui: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
});
