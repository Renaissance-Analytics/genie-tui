import { AgentController } from '@mastra/core/agent-controller';
import type { Agent } from '@mastra/core/agent';
import type { AgentControllerEvent, Session } from '@mastra/core/agent-controller';

import { fromMastra } from './adapter/mastra.js';
import { initialState, reduce } from './reduce.js';
import type { HarnessEvent, HarnessState } from './protocol.js';
import type { HarnessActions } from './surfaces.js';

/**
 * The harness: Mastra's `AgentController` on one side, the pure reducer on the
 * other, and nothing else allowed across the seam.
 *
 * `AgentController` is Mastra's own name for this concept and is documented as
 * an "in-process, collaborative session" rather than a stateless endpoint —
 * which is why the TUI embeds it directly instead of running `mastra dev` and
 * talking to a local server.
 *
 * Everything the view and the Genie bridge read comes from `state()`. Neither
 * imports Mastra.
 */

export interface HarnessOptions {
    name: string;
    cwd: string;
    agent: Agent;
    /** Genie's chat-id, minted at launch. Adopted verbatim as Mastra's thread id. */
    sessionId: string;
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

    const controller = new AgentController({
        id: `genie-tui:${opts.name}`,
        agent: opts.agent,
        modes: [{ id: 'build', name: 'Build', metadata: { default: true } }],
    });
    await controller.init();

    // Genie's chat-id IS the Mastra thread id. One identifier, two vocabularies.
    const session: Session = await controller.createSession({
        resourceId: opts.cwd,
        scope: 'genie-tui',
        threadId: opts.sessionId,
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

    const unsubscribe = session.subscribe((event: AgentControllerEvent) => {
        apply(fromMastra(event));
    });

    function subscribe(fn: (s: HarnessState) => void): () => void {
        listeners.add(fn);
        return () => {
            listeners.delete(fn);
        };
    }

    /**
     * Resolve when the turn actually ends.
     *
     * `sendMessage` returning is not the same as the turn being over — the
     * controller streams events after it resolves. Waiting on the declared
     * `agent_end` is the whole point of having a turn boundary rather than
     * inferring one; deriving it here from a timer would reintroduce exactly the
     * guess this project exists to remove.
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
         * Queue a message into the composer rather than typing bytes at a
         * running agent. This is the call that replaces Genie's
         * `buildNudgeSequence` — Ctrl-A, Ctrl-K, a bracketed paste, and a bare
         * CR that has to be its own write 60ms later.
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
        interrupt: () => session.abort(),
    };

    async function send(text: string): Promise<void> {
        if (!text.trim()) return;
        apply([{ kind: 'composer-submit', text }]);
        const settled = turnSettled();
        await session.sendMessage({ content: text });
        await settled;
    }

    return {
        state: () => state,
        subscribe,
        send,
        actions,
        dispose: async () => {
            unsubscribe();
            listeners.clear();
        },
    };
}
