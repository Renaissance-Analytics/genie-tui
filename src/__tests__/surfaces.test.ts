import { describe, expect, it, vi } from 'vitest';
import { createTuiSurfaceRegistry } from '@particle-academy/fancy-tui/testing';

import { initialState, reduce } from '../reduce.js';
import { harnessSurfaces } from '../surfaces.js';
import type { HarnessState } from '../protocol.js';

/**
 * The surfaces are the whole integration contract. Genie reads them instead of
 * reconstructing a `Draft` from keystrokes, and calls them instead of emitting
 * cut/paste/CR byte sequences — but they are `fancy-tui`'s own Human+ registry
 * shape, not a Genie back door, so any Human+ MCP client gets the same thing.
 */

function stateWith(text: string): HarnessState {
    return reduce(initialState({ name: 'skeleton', cwd: '/repo' }), {
        kind: 'composer-change',
        text,
        cursor: text.length,
    }, 1_000);
}

const noopActions = {
    setText: vi.fn(),
    deliver: vi.fn(),
    submit: vi.fn(),
    clear: vi.fn(),
    interrupt: vi.fn(),
};

describe('surface registration', () => {
    it('registers composer, turn and session with fancy-tui', () => {
        const registry = createTuiSurfaceRegistry();
        for (const s of harnessSurfaces(() => stateWith(''), noopActions)) registry.register(s);
        expect(registry.list().map((s) => s.id).sort()).toEqual(['composer', 'session', 'turn']);
    });

    it('reads live state, not a snapshot taken at registration time', () => {
        let state = stateWith('');
        const registry = createTuiSurfaceRegistry();
        for (const s of harnessSurfaces(() => state, noopActions)) registry.register(s);

        state = stateWith('typed after registration');
        expect(registry.get('composer')?.read()).toMatchObject({ text: 'typed after registration' });
    });
});

describe('the composer surface', () => {
    /**
     * The genie#257 assertion, at the integration boundary this time.
     *
     * Genie's `Draft` reconstruction sets `confident: false` the moment it meets
     * a key encoding it cannot interpret, and only a submit or an abort restores
     * it. `CSI 13 u` — Codex's Enter under the Kitty protocol — did exactly that
     * on every submit, so every nudge silently degraded to append-only.
     *
     * A surface `read()` has no encoding to misinterpret. There is no confidence
     * field here because there is nothing to be unconfident about.
     */
    it('reports the buffer verbatim, with no confidence caveat', () => {
        const registry = createTuiSurfaceRegistry();
        for (const s of harnessSurfaces(() => stateWith('half-typed thought'), noopActions)) {
            registry.register(s);
        }
        const read = registry.get('composer')?.read() as Record<string, unknown>;
        expect(read).toEqual({ text: 'half-typed thought', cursor: 18, busy: false });
        expect(read).not.toHaveProperty('confident');
    });

    it('exposes deliver, submit and clear as invocable commands', () => {
        const registry = createTuiSurfaceRegistry();
        for (const s of harnessSurfaces(() => stateWith(''), noopActions)) registry.register(s);
        const names = registry.get('composer')?.commands?.map((c) => c.name).sort();
        expect(names).toEqual(['clear', 'deliver', 'submit']);
    });

    /**
     * What replaces `buildNudgeSequence`. Genie's current delivery is Ctrl-A,
     * Ctrl-K, a bracketed paste, and a bare CR that must be its OWN write 60ms
     * later — because a notice arriving as one chunk reads as a paste and its
     * newline becomes a buffer newline instead of a submit (genie#218).
     *
     * Here it is one call, and the human's half-typed text is a value the
     * harness holds rather than something to cut and hope to restore.
     */
    it('delivers a message without disturbing what the human was typing', async () => {
        const deliver = vi.fn();
        const registry = createTuiSurfaceRegistry();
        for (const s of harnessSurfaces(() => stateWith('half-typed thought'), { ...noopActions, deliver })) {
            registry.register(s);
        }
        const cmd = registry.get('composer')?.commands?.find((c) => c.name === 'deliver');
        await cmd?.invoke({ text: 'DM from @main: ship it' });

        expect(deliver).toHaveBeenCalledWith('DM from @main: ship it');
    });
});

describe('the turn surface', () => {
    it('states what the agent is doing and since when', () => {
        let state = initialState({ name: 'skeleton', cwd: '/repo' });
        const registry = createTuiSurfaceRegistry();
        for (const s of harnessSurfaces(() => state, noopActions)) registry.register(s);

        state = reduce(state, { kind: 'turn-start' }, 5_000);
        state = reduce(state, { kind: 'tool-start', id: 't1', name: 'run_tests' }, 5_100);

        expect(registry.get('turn')?.read()).toEqual({
            state: 'tool',
            since: 5_100,
            pendingTools: ['run_tests'],
            approvals: [],
        });
    });

    it('offers interrupt, which is the turn-stop API no foreign TUI exposes', async () => {
        const interrupt = vi.fn();
        const registry = createTuiSurfaceRegistry();
        for (const s of harnessSurfaces(() => stateWith(''), { ...noopActions, interrupt })) {
            registry.register(s);
        }
        const cmd = registry.get('turn')?.commands?.find((c) => c.name === 'interrupt');
        await cmd?.invoke();
        expect(interrupt).toHaveBeenCalled();
    });
});

describe('the session surface', () => {
    it('publishes the Genie agent ref, never a bare chat-id to a human surface', () => {
        let state = initialState({ name: 'skeleton', cwd: '/repo' });
        state = reduce(state, { kind: 'session-ready', sessionId: 'abc-123', threadId: 'abc-123' }, 1);

        const registry = createTuiSurfaceRegistry();
        for (const s of harnessSurfaces(() => state, noopActions)) registry.register(s);

        expect(registry.get('session')?.read()).toMatchObject({
            ref: 'genie:skeleton:abc-123',
            provider: 'genie',
            name: 'skeleton',
        });
    });

    it('degrades the ref to two parts before the chat-id is bound', () => {
        const registry = createTuiSurfaceRegistry();
        for (const s of harnessSurfaces(() => stateWith(''), noopActions)) registry.register(s);
        expect(registry.get('session')?.read()).toMatchObject({ ref: 'genie:skeleton' });
    });
});
