import { describe, expect, it } from 'vitest';

import { initialState, reduce } from '../reduce.js';
import type { HarnessEvent, HarnessState } from '../protocol.js';

/**
 * The reducer is the whole point of the harness boundary: every fact Genie
 * currently INFERS from pty bytes is derived here, from declared events, with
 * no terminal and no model in the loop. If it can be computed in a unit test it
 * can be reported over the bridge.
 */

const boot = (): HarnessState => initialState({ name: 'skeleton', cwd: '/repo' });

/** Fold a list of events at successive timestamps. */
function play(state: HarnessState, events: HarnessEvent[], from = 1_000): HarnessState {
    return events.reduce((s, e, i) => reduce(s, e, from + i), state);
}

describe('turn state', () => {
    it('starts idle', () => {
        expect(boot().turn.state).toBe('idle');
    });

    it('is thinking between turn-start and turn-end', () => {
        const s = play(boot(), [{ kind: 'turn-start' }]);
        expect(s.turn.state).toBe('thinking');
    });

    it('returns to idle on turn-end', () => {
        const s = play(boot(), [{ kind: 'turn-start' }, { kind: 'turn-end', reason: 'complete' }]);
        expect(s.turn.state).toBe('idle');
    });

    /**
     * The Genie failure this whole design exists to remove. `wake.ts` decides an
     * agent is busy by MEASURING OUTPUT SILENCE (WAKE_QUIET_MS = 15s), because a
     * working TUI repaints its spinner continuously. A tool that runs quietly for
     * a minute — a build, a test suite, a network call — emits nothing, so that
     * heuristic reads it as idle and injects a notice mid-turn.
     *
     * Declared state has no such failure: silence is not a signal.
     */
    it('stays busy across a long, silent tool call', () => {
        const s = play(boot(), [
            { kind: 'turn-start' },
            { kind: 'tool-start', id: 't1', name: 'run_tests' },
        ]);
        // Ten minutes later, with not one byte emitted.
        const later = reduce(s, { kind: 'tick' }, 1_000 + 600_000);
        expect(later.turn.state).toBe('tool');
        expect(later.turn.state).not.toBe('idle');
    });

    it('reports awaiting-approval distinctly from thinking', () => {
        const s = play(boot(), [
            { kind: 'turn-start' },
            { kind: 'approval-required', id: 'a1', name: 'delete_branch', args: { branch: 'main' } },
        ]);
        expect(s.turn.state).toBe('awaiting-approval');
        expect(s.approvals).toEqual([{ id: 'a1', name: 'delete_branch', args: { branch: 'main' } }]);
    });

    it('leaves awaiting-approval once the approval resolves', () => {
        const s = play(boot(), [
            { kind: 'turn-start' },
            { kind: 'approval-required', id: 'a1', name: 'delete_branch', args: {} },
            { kind: 'approval-resolved', id: 'a1' },
        ]);
        expect(s.approvals).toEqual([]);
        expect(s.turn.state).toBe('thinking');
    });

    it('stamps `since` from the event clock, not wall time', () => {
        const s = reduce(boot(), { kind: 'turn-start' }, 4_242);
        expect(s.turn.since).toBe(4_242);
    });
});

describe('composer', () => {
    /**
     * The genie#257 shape. Codex enables the Kitty keyboard protocol, so a plain
     * Enter arrives as `CSI 13 u` rather than CR. Genie's keystroke model could
     * not interpret it, so `Draft.confident` went false on EVERY Codex submit and
     * every nudge silently degraded to append-only for a whole release cycle.
     *
     * A first-party composer is controlled React state. There is no encoding to
     * misread, so there is no confidence to lose — which is the argument for the
     * whole project, expressed as an assertion.
     */
    it('reports the buffer verbatim regardless of key encoding', () => {
        const s = play(boot(), [{ kind: 'composer-change', text: 'ship it', cursor: 7 }]);
        expect(s.composer).toEqual({ text: 'ship it', cursor: 7, busy: false });
    });

    it('empties on submit and records the submitted text as a user message', () => {
        const s = play(boot(), [
            { kind: 'composer-change', text: 'run the tests', cursor: 13 },
            { kind: 'composer-submit', text: 'run the tests' },
        ]);
        expect(s.composer.text).toBe('');
        expect(s.composer.cursor).toBe(0);
        expect(s.transcript.at(-1)).toMatchObject({ role: 'user', content: 'run the tests' });
    });

    it('is busy while a turn is running, so a delivery can be queued rather than typed', () => {
        const s = play(boot(), [{ kind: 'turn-start' }]);
        expect(s.composer.busy).toBe(true);
    });
});

describe('transcript and live text', () => {
    it('keeps in-flight assistant text OUT of the committed transcript', () => {
        const s = play(boot(), [
            { kind: 'turn-start' },
            { kind: 'message', id: 'm1', role: 'agent', content: 'Look', done: false },
            { kind: 'message', id: 'm1', role: 'agent', content: 'Looking at it', done: false },
        ]);
        // Committed output must never repaint — that is what protects scrollback.
        expect(s.transcript).toEqual([]);
        expect(s.live).toEqual({ id: 'm1', role: 'agent', content: 'Looking at it' });
    });

    it('commits the message and clears the live region when it completes', () => {
        const s = play(boot(), [
            { kind: 'turn-start' },
            { kind: 'message', id: 'm1', role: 'agent', content: 'Looking at it', done: false },
            { kind: 'message', id: 'm1', role: 'agent', content: 'Looking at it. Done.', done: true },
        ]);
        expect(s.live).toBeNull();
        expect(s.transcript).toEqual([
            { id: 'm1', role: 'agent', content: 'Looking at it. Done.' },
        ]);
    });

    it('never commits the same message id twice', () => {
        const s = play(boot(), [
            { kind: 'message', id: 'm1', role: 'agent', content: 'once', done: true },
            { kind: 'message', id: 'm1', role: 'agent', content: 'once', done: true },
        ]);
        expect(s.transcript).toHaveLength(1);
    });
});

describe('tool calls', () => {
    it('tracks a call from pending to success', () => {
        const s = play(boot(), [
            { kind: 'turn-start' },
            { kind: 'tool-start', id: 't1', name: 'read_file' },
        ]);
        expect(s.tools).toEqual([{ id: 't1', name: 'read_file', status: 'pending' }]);

        const done = reduce(s, { kind: 'tool-end', id: 't1', isError: false }, 2_000);
        expect(done.tools).toEqual([{ id: 't1', name: 'read_file', status: 'success' }]);
        expect(done.turn.state).toBe('thinking');
    });

    it('marks a failed call as failure without ending the turn', () => {
        const s = play(boot(), [
            { kind: 'turn-start' },
            { kind: 'tool-start', id: 't1', name: 'run_tests' },
            { kind: 'tool-end', id: 't1', isError: true },
        ]);
        expect(s.tools.at(0)?.status).toBe('failure');
        expect(s.turn.state).toBe('thinking');
    });

    it('stays in tool state while any call is still pending', () => {
        const s = play(boot(), [
            { kind: 'turn-start' },
            { kind: 'tool-start', id: 't1', name: 'a' },
            { kind: 'tool-start', id: 't2', name: 'b' },
            { kind: 'tool-end', id: 't1', isError: false },
        ]);
        expect(s.turn.state).toBe('tool');
    });
});

describe('session', () => {
    it('records the chat id the harness was launched with', () => {
        const s = play(boot(), [
            { kind: 'session-ready', sessionId: 'abc-123', threadId: 'abc-123' },
        ]);
        expect(s.session.sessionId).toBe('abc-123');
        expect(s.session.provider).toBe('genie');
    });
});

describe('purity', () => {
    it('does not mutate the state it is given', () => {
        const before = boot();
        const snapshot = JSON.stringify(before);
        reduce(before, { kind: 'composer-change', text: 'x', cursor: 1 }, 1);
        expect(JSON.stringify(before)).toBe(snapshot);
    });
});
