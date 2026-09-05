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
    /**
     * Which tool calls may proceed without asking a person.
     *
     * The runtime gates tool calls; this decides which of those gates the
     * harness closes itself. Read-only tools say yes — reading the workspace is
     * what the agent is FOR, and stopping for each one would make it unusable —
     * and anything that changes the workspace says no.
     *
     * That split is what keeps `awaiting-approval` meaningful. It has one
     * meaning, "a person has to act", which is the only reason it is worth
     * reporting to Genie: Genie's alternative is to infer busy-ness from
     * fifteen seconds of output silence, and an agent waiting on a human looks
     * exactly like an agent that has finished.
     *
     * Defaults to approving NOTHING. A missing policy must not become blanket
     * consent.
     */
    autoApprove?: (toolName: string) => boolean;
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

    const autoApprove = opts.autoApprove ?? (() => false);

    const apply = (events: HarnessEvent[]) => {
        if (events.length === 0) return;
        const before = state;
        for (const e of events) state = reduce(state, e, now());
        if (state !== before) for (const fn of listeners) fn(state);
    };

    /**
     * Settle the gates the policy already answers, BEFORE the reducer sees them.
     *
     * Dropping the event rather than folding it and resolving afterwards is
     * deliberate. Folding first would flick `turn.state` through
     * `awaiting-approval` and straight back out, and the bridge reports that
     * state to Genie — a sample taken mid-flicker says a human is blocking a
     * turn nobody was ever asked about.
     */
    const settleAutoApprovals = (events: HarnessEvent[]): HarnessEvent[] =>
        events.filter((event) => {
            if (event.kind !== 'approval-required') return true;
            if (!autoApprove(event.name)) return true;
            session.respondToApproval(event.id, 'approve');
            return false;
        });

    apply([{ kind: 'session-ready', sessionId: opts.sessionId, threadId: opts.sessionId }]);

    const unsubscribe = session.subscribe((events) => apply(settleAutoApprovals(events)));

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
        approve: (id: string) => decide(id, 'approve'),
        deny: (id: string) => decide(id, 'deny'),
    };

    /**
     * Answer a pending approval, and only a pending one.
     *
     * The id is the whole identity of an approval. Passing an unknown one
     * through to the runtime would release whatever gate happened to be parked,
     * so an unrecognised id is ignored rather than forwarded — a stale
     * keystroke must not approve the next question.
     */
    function decide(id: string, decision: 'approve' | 'deny'): void {
        if (!state.approvals.some((a) => a.id === id)) return;
        session.respondToApproval(id, decision);
        apply([{ kind: 'approval-resolved', id }]);
    }

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
