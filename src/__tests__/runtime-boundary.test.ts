import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { createHarness } from '../harness.js';
import type { HarnessEvent } from '../protocol.js';
import type { Runtime, RuntimeSession } from '../runtime.js';

/**
 * Mastra is a TEMPORARY dependency with a planned exit — the owner is shipping
 * his own harness once the Prism language-parity packages land. So the value of
 * this boundary is not tidiness; it is the migration path, and it has to be
 * real rather than asserted.
 *
 * These are the two tests that make it real:
 *
 *  1. a BEHAVIOURAL one — the whole harness runs a turn against a runtime that
 *     has never heard of Mastra, so "replaceable" is demonstrated by replacing it;
 *  2. a STRUCTURAL one — the files above the seam are checked, as source, to
 *     contain no Mastra import at all. That is the invariant that rots silently
 *     otherwise: one convenient `import type` and the seam is gone with every
 *     test still green.
 */

const here = path.dirname(url.fileURLToPath(import.meta.url));

/** A runtime with no dependencies whatsoever. It replays a script. */
function fakeRuntime(script: HarnessEvent[]): Runtime {
    return {
        async createSession(): Promise<RuntimeSession> {
            const listeners = new Set<(e: HarnessEvent[]) => void>();
            return {
                async send() {
                    for (const event of script) {
                        for (const fn of listeners) fn([event]);
                    }
                },
                interrupt() {},
                subscribe(fn) {
                    listeners.add(fn);
                    return () => {
                        listeners.delete(fn);
                    };
                },
                async dispose() {},
            };
        },
    };
}

describe('the harness runs on a runtime that is not Mastra', () => {
    it('completes a full turn against a hand-written runtime', async () => {
        const harness = await createHarness({
            name: 'fake',
            cwd: '/repo',
            sessionId: 'fake-1',
            runtime: fakeRuntime([
                { kind: 'turn-start' },
                { kind: 'tool-start', id: 't1', name: 'read_file' },
                { kind: 'tool-end', id: 't1', isError: false },
                { kind: 'message', id: 'm1', role: 'agent', content: 'Replaced.', done: true },
                { kind: 'turn-end', reason: 'complete' },
            ]),
        });

        await harness.send('who is running this?');

        const state = harness.state();
        expect(state.turn.state).toBe('idle');
        expect(state.transcript.some((m) => m.content === 'Replaced.')).toBe(true);
        expect(state.tools).toEqual([{ id: 't1', name: 'read_file', status: 'success' }]);

        await harness.dispose();
    });

    /**
     * Deliberately NOT awaited.
     *
     * `send()` resolves on a DECLARED `turn-end`, and a turn parked on an
     * approval has not ended — so awaiting it here would hang, correctly. The
     * first draft of this test did exactly that and timed out, which is worth
     * recording rather than quietly fixing: it means **`send()` never resolves
     * if a runtime dies mid-turn without declaring an end.** That is a real hang
     * risk with no timeout or abort path today (GAPS H1), and the honest fix is
     * a cancellation contract on `RuntimeSession`, not a timeout bolted on here.
     */
    it('reports turn state from the runtime it was given, whatever that is', async () => {
        const harness = await createHarness({
            name: 'fake',
            cwd: '/repo',
            sessionId: 'fake-2',
            runtime: fakeRuntime([
                { kind: 'turn-start' },
                { kind: 'approval-required', id: 'a1', name: 'rm_rf', args: {} },
            ]),
        });

        const reached = new Promise<void>((resolve) => {
            const off = harness.subscribe((s) => {
                if (s.turn.state === 'awaiting-approval') {
                    off();
                    resolve();
                }
            });
        });

        void harness.send('go');
        await reached;

        expect(harness.state().turn.state).toBe('awaiting-approval');
        expect(harness.state().approvals).toEqual([{ id: 'a1', name: 'rm_rf', args: {} }]);

        await harness.dispose();
    });
});

describe('the seam holds, as source', () => {
    /**
     * The behavioural test above would still pass if `harness.ts` imported
     * Mastra for one convenient type — the fake runtime would work, the seam
     * would be gone, and nothing would say so. This checks the files instead of
     * the behaviour.
     *
     * `runtime/mastra.ts` is the ONE place allowed to know Mastra, and it is
     * excluded here by name rather than by accident.
     */
    const ABOVE_THE_SEAM = [
        'protocol.ts',
        'reduce.ts',
        'harness.ts',
        'runtime.ts',
        'surfaces.ts',
        'bridge/genie.ts',
        'ui/App.tsx',
    ];

    for (const rel of ABOVE_THE_SEAM) {
        it(`${rel} does not import Mastra`, () => {
            const source = fs.readFileSync(path.join(here, '..', rel), 'utf8');
            expect(source).not.toMatch(/@mastra/);
        });
    }

    /**
     * The positive control. "No match for @mastra" passes trivially against a
     * path that does not exist or a file that is empty, so prove the check can
     * FAIL: the one file that is supposed to import Mastra must.
     */
    it('positive control — the adapter below the seam DOES import Mastra', () => {
        const source = fs.readFileSync(path.join(here, '..', 'runtime', 'mastra.ts'), 'utf8');
        expect(source).toMatch(/@mastra/);
    });
});
