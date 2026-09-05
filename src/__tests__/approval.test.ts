import { describe, expect, it } from 'vitest';

import { createHarness } from '../harness.js';
import type { HarnessEvent } from '../protocol.js';
import type { Runtime, RuntimeSession } from '../runtime.js';

/**
 * Approvals, resolved.
 *
 * This is the state the whole project exists to make legible. Genie decides
 * whether an agent is working by measuring fifteen seconds of output silence
 * (`main/agentinbox/wake.ts`), so an agent parked on a question for a human is
 * indistinguishable to it from an agent that has finished. `awaiting-approval`
 * is a DECLARED state — but only if something can leave it again.
 *
 * Until now nothing could. Mastra's `AgentController` gates every tool call and
 * parks the run on a promise, and the harness had no way to respond, so the
 * first tool call of the first real turn hung forever. The protocol had the
 * state, the reducer folded it, the UI painted it, and it was a dead end.
 *
 * The policy split asserted here is the useful part: reading is what the agent
 * is FOR, so read-only tools resolve themselves and never reach a human;
 * anything that changes the workspace stops and asks. `awaiting-approval` then
 * means exactly one thing — a person has to act — which is what makes it worth
 * reporting to Genie at all.
 */

interface Fake {
    runtime: Runtime;
    /** Approvals the runtime was told about, in order. */
    responses: { id: string; decision: 'approve' | 'deny' }[];
    /** Push events at the harness as if the runtime had emitted them. */
    emit: (...events: HarnessEvent[]) => void;
}

function fakeRuntime(): Fake {
    const responses: { id: string; decision: 'approve' | 'deny' }[] = [];
    const listeners = new Set<(events: HarnessEvent[]) => void>();

    const runtime: Runtime = {
        async createSession(): Promise<RuntimeSession> {
            return {
                async send() {},
                interrupt() {},
                respondToApproval(id, decision) {
                    responses.push({ id, decision });
                },
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

    return {
        runtime,
        responses,
        emit: (...events) => {
            for (const fn of listeners) fn(events);
        },
    };
}

/** Read-only tools resolve themselves; anything that mutates asks. */
const autoApprove = (name: string) => name === 'read_file';

describe('a read-only tool never stops the turn', () => {
    it('approves itself, and the human never sees it', async () => {
        const fake = fakeRuntime();
        const harness = await createHarness({
            name: 'a',
            cwd: '/repo',
            sessionId: 's1',
            runtime: fake.runtime,
            autoApprove,
        });

        fake.emit({ kind: 'turn-start' }, { kind: 'tool-start', id: 't1', name: 'read_file' });
        fake.emit({ kind: 'approval-required', id: 't1', name: 'read_file', args: {} });

        expect(fake.responses).toEqual([{ id: 't1', decision: 'approve' }]);

        // And it must never have ENTERED the state. A turn that flickers into
        // `awaiting-approval` and out again is one Genie may sample mid-flicker
        // and report as blocked on a human who was never asked.
        expect(harness.state().turn.state).toBe('tool');
        expect(harness.state().approvals).toEqual([]);

        await harness.dispose();
    });
});

describe('a mutating tool stops and asks', () => {
    it('parks the turn until a human answers', async () => {
        const fake = fakeRuntime();
        const harness = await createHarness({
            name: 'a',
            cwd: '/repo',
            sessionId: 's1',
            runtime: fake.runtime,
            autoApprove,
        });

        fake.emit({ kind: 'turn-start' }, { kind: 'tool-start', id: 't2', name: 'write_file' });
        fake.emit({
            kind: 'approval-required',
            id: 't2',
            name: 'write_file',
            args: { path: 'x.ts' },
        });

        expect(fake.responses, 'nothing was decided on the human’s behalf').toEqual([]);
        expect(harness.state().turn.state).toBe('awaiting-approval');
        expect(harness.state().approvals).toEqual([
            { id: 't2', name: 'write_file', args: { path: 'x.ts' } },
        ]);

        await harness.dispose();
    });

    it('releases the run when the human approves', async () => {
        const fake = fakeRuntime();
        const harness = await createHarness({
            name: 'a',
            cwd: '/repo',
            sessionId: 's1',
            runtime: fake.runtime,
            autoApprove,
        });

        fake.emit({ kind: 'turn-start' }, { kind: 'tool-start', id: 't3', name: 'write_file' });
        fake.emit({ kind: 'approval-required', id: 't3', name: 'write_file', args: {} });

        harness.actions.approve('t3');

        expect(fake.responses).toEqual([{ id: 't3', decision: 'approve' }]);
        // Back to `tool`: the call is running again, not waiting on anyone.
        expect(harness.state().turn.state).toBe('tool');
        expect(harness.state().approvals).toEqual([]);

        await harness.dispose();
    });

    it('declines when the human declines', async () => {
        const fake = fakeRuntime();
        const harness = await createHarness({
            name: 'a',
            cwd: '/repo',
            sessionId: 's1',
            runtime: fake.runtime,
            autoApprove,
        });

        fake.emit({ kind: 'turn-start' }, { kind: 'tool-start', id: 't4', name: 'write_file' });
        fake.emit({ kind: 'approval-required', id: 't4', name: 'write_file', args: {} });

        harness.actions.deny('t4');

        expect(fake.responses).toEqual([{ id: 't4', decision: 'deny' }]);
        expect(harness.state().approvals).toEqual([]);

        await harness.dispose();
    });

    /**
     * Answering a question nobody asked must not release a DIFFERENT gate. The
     * id is the whole identity of an approval, and a harness that ignored it
     * would approve whatever happened to be parked next.
     */
    it('ignores a decision for an approval that is not pending', async () => {
        const fake = fakeRuntime();
        const harness = await createHarness({
            name: 'a',
            cwd: '/repo',
            sessionId: 's1',
            runtime: fake.runtime,
            autoApprove,
        });

        harness.actions.approve('never-asked');

        expect(fake.responses).toEqual([]);

        await harness.dispose();
    });
});

describe('with no policy given, nothing is auto-approved', () => {
    /**
     * The safe default, and the positive control for the auto-approval test:
     * the same `read_file` event that resolves itself above must PARK when no
     * policy says it may proceed. Without this, "it auto-approved" and "the
     * harness approves everything" look identical.
     */
    it('parks even a read-only tool when no policy is configured', async () => {
        const fake = fakeRuntime();
        const harness = await createHarness({
            name: 'a',
            cwd: '/repo',
            sessionId: 's1',
            runtime: fake.runtime,
        });

        fake.emit({ kind: 'turn-start' }, { kind: 'tool-start', id: 't5', name: 'read_file' });
        fake.emit({ kind: 'approval-required', id: 't5', name: 'read_file', args: {} });

        expect(fake.responses).toEqual([]);
        expect(harness.state().turn.state).toBe('awaiting-approval');

        await harness.dispose();
    });
});
