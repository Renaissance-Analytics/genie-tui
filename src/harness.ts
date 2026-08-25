import { initialState, reduce } from './reduce.js';
import type { HarnessEvent, HarnessState } from './protocol.js';
import type { Runtime, RuntimeSession } from './runtime.js';
import type { HarnessActions } from './surfaces.js';

/**
 * The harness: a {@link Runtime} on one side, the pure reducer on the other.
 *
 * **This file must never import a vendor.** It is written against
 * `HarnessEvent`, which we define, so the agent runtime underneath is
 * replaceable — which matters because Mastra is temporary and the first-party
 * harness is scheduled. `__tests__/runtime-boundary.test.ts` checks that as
 * source, not just as behaviour.
 *
 * Everything the view and the Genie bridge read comes from `state()`.
 */

export interface HarnessOptions {
    name: string;
    cwd: string;
    /** Genie's chat-id, minted at launch. */
    sessionId: string;
    runtime: Runtime;
    /** Injected in tests so `turn.since` is deterministic. */
    now?: () => number;
}

export interface Harness {
    state(): HarnessState;
    subscribe(fn: (state: HarnessState) => void): () => void;
    /** Submit a message and resolve when the turn is over. */
    send(text: string): Promise<void>;
    actions: HarnessActions;
    dispose(): Promise<void>;
}

export async function createHarness(opts: HarnessOptions): Promise<Harness> {
    const now = opts.now ?? (() => Date.now());

    const session: RuntimeSession = await opts.runtime.createSession({
        sessionId: opts.sessionId,
        cwd: opts.cwd,
        name: opts.name,
    });

    let state = initialState({ name: opts.name, cwd: opts.cwd });
    const listeners = new Set<(s: HarnessState) => void>();

    const apply = (events: HarnessEvent[]) => {
        if (events.length === 0) return;
        const before = state;
        for (const e of events) state = reduce(state, e, now());
        if (state !== before) for (const fn of listeners) fn(state);
    };

    apply([{ kind: 'session-ready', sessionId: opts.sessionId, threadId: opts.sessionId }]);

    const unsubscribe = session.subscribe(apply);

    function subscribe(fn: (s: HarnessState) => void): () => void {
        listeners.add(fn);
        return () => {
            listeners.delete(fn);
        };
    }

    /**
     * Resolve when the turn actually ends.
     *
     * The runtime accepting a message is not the same as the turn being over.
     * Waiting on the DECLARED `turn-end` is the whole point of having a turn
     * boundary rather than inferring one — deriving it from a timer here would
     * reintroduce exactly the guess this project exists to remove.
     */
    const turnSettled = (): Promise<void> =>
        new Promise((resolve) => {
            let sawStart = false;
            const off = subscribe((s) => {
                if (s.turn.state !== 'idle') sawStart = true;
                if (sawStart && s.turn.state === 'idle') {
                    off();
                    resolve();
                }
            });
        });

    const actions: HarnessActions = {
        setText: (text: string, cursor?: number) =>
            apply([{ kind: 'composer-change', text, cursor: cursor ?? text.length }]),
        /**
         * Queue an EXTERNAL message into the composer rather than typing bytes
         * at a running agent. This is what replaces Genie's `buildNudgeSequence`
         * — Ctrl-A, Ctrl-K, a bracketed paste, and a bare CR that has to be its
         * own write 60ms later.
         */
        deliver: (text: string) => {
            const current = state.composer.text;
            const merged = current ? `${current}\n${text}` : text;
            apply([{ kind: 'composer-change', text: merged, cursor: merged.length }]);
        },
        submit: () => {
            void send(state.composer.text);
        },
        clear: () => apply([{ kind: 'composer-change', text: '', cursor: 0 }]),
        interrupt: () => session.interrupt(),
    };

    async function send(text: string): Promise<void> {
        if (!text.trim()) return;
        apply([{ kind: 'composer-submit', text }]);
        const settled = turnSettled();
        await session.send(text);
        await settled;
    }

    return {
        state: () => state,
        subscribe,
        send,
        actions,
        dispose: async () => {
            await session.dispose();
            listeners.clear();
        },
    };
}
