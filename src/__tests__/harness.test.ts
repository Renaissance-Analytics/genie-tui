import { describe, expect, it } from 'vitest';
import { Agent } from '@mastra/core/agent';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';

import { createHarness } from '../harness.js';
import { mastraRuntime } from '../runtime/mastra.js';

/**
 * The proof that the stack actually works: a REAL Mastra `AgentController` and
 * `Session`, embedded in this process, driving the adapter and the reducer.
 *
 * The model is Mastra's own mock, so this asserts the integration boundary
 * rather than a provider's behaviour, and runs with no API key and no network.
 *
 * `AgentController` is documented as an "in-process, collaborative session"
 * rather than a stateless endpoint, which is exactly what a TUI needs — this
 * test is where that claim gets checked instead of believed.
 */

function agentAnswering(text: string): Agent {
    return new Agent({
        id: 'skeleton',
        name: 'Skeleton',
        instructions: 'You are a walking skeleton.',
        model: createMockModel({ mockText: text, version: 'v2' }) as never,
    });
}

describe('embedding Mastra', () => {
    it('boots a controller and session in-process, with no dev server', async () => {
        const harness = await createHarness({
            name: 'skeleton',
            cwd: process.cwd(),
            runtime: mastraRuntime({ agent: agentAnswering('ok') }),
            sessionId: 'chat-1',
        });

        expect(harness.state().session.sessionId).toBe('chat-1');
        expect(harness.state().session.threadId).toBe('chat-1');
        expect(harness.state().turn.state).toBe('idle');

        await harness.dispose();
    });

    /**
     * Genie's chat-id is minted at launch (`--session-id`, `LAUNCH_PROFILES`
     * strategy `flag`) and adopted here as Mastra's thread id. One identifier in
     * two vocabularies — which is what lets a saved agent be reattached rather
     * than re-minted, and is the easier path Codex cannot take because its
     * session id does not exist until its harness is running.
     */
    it('adopts the launch chat-id as the Mastra thread id', async () => {
        const harness = await createHarness({
            name: 'skeleton',
            cwd: process.cwd(),
            runtime: mastraRuntime({ agent: agentAnswering('ok') }),
            sessionId: 'e2f1c0de-0000-4000-8000-000000000000',
        });

        expect(harness.state().session.threadId).toBe('e2f1c0de-0000-4000-8000-000000000000');
        await harness.dispose();
    });

    it('runs a full turn and commits the answer to the transcript', async () => {
        const harness = await createHarness({
            name: 'skeleton',
            cwd: process.cwd(),
            runtime: mastraRuntime({ agent: agentAnswering('Hello from Mastra.') }),
            sessionId: 'chat-2',
        });

        const seen: string[] = [];
        harness.subscribe((s) => seen.push(s.turn.state));

        await harness.send('hi');

        const state = harness.state();
        expect(state.turn.state).toBe('idle');
        expect(state.transcript.map((m) => m.role)).toContain('user');
        expect(state.transcript.some((m) => m.content.includes('Hello from Mastra'))).toBe(true);

        // The turn was OBSERVED as running, not just inferred from the end
        // state — this is the signal Genie currently has to derive from output
        // silence.
        expect(seen).toContain('thinking');

        await harness.dispose();
    }, 30_000);

    it('reports live text separately from the committed transcript during the turn', async () => {
        const harness = await createHarness({
            name: 'skeleton',
            cwd: process.cwd(),
            runtime: mastraRuntime({ agent: agentAnswering('Streaming answer.') }),
            sessionId: 'chat-3',
        });

        let sawLiveWithEmptyTranscript = false;
        harness.subscribe((s) => {
            if (s.live && !s.transcript.some((m) => m.id === s.live?.id)) {
                sawLiveWithEmptyTranscript = true;
            }
        });

        await harness.send('go');

        expect(sawLiveWithEmptyTranscript).toBe(true);
        expect(harness.state().live).toBeNull();

        await harness.dispose();
    }, 30_000);
});
