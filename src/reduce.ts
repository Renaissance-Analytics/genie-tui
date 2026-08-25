import { PROVIDER } from './protocol.js';
import type { HarnessEvent, HarnessState, TurnState } from './protocol.js';

/**
 * The pure core. `reduce(state, event, now) -> state`, no Mastra, no Ink, no
 * clock of its own — so every fact Genie needs reported can be asserted in a
 * unit test rather than observed through a terminal.
 *
 * The clock is a parameter, not `Date.now()`, for the same reason the rest of
 * this is pure: a timestamp read inside the reducer is a hidden input, and
 * `turn.since` is one of the values that goes over the bridge.
 */

export function initialState(opts: { name: string; cwd: string }): HarnessState {
    return {
        session: {
            provider: PROVIDER,
            name: opts.name,
            cwd: opts.cwd,
            sessionId: null,
            threadId: null,
        },
        turn: { state: 'idle', since: 0 },
        composer: { text: '', cursor: 0, busy: false },
        transcript: [],
        live: null,
        tools: [],
        approvals: [],
        error: null,
    };
}

/**
 * Turn state is DERIVED from what is outstanding, never from elapsed time.
 *
 * The ordering is the contract: an approval outranks a running tool, because a
 * tool waiting on a human is not work in progress. A silent tool call stays
 * `tool` indefinitely — which is the case `wake.ts` gets wrong by construction,
 * since it reads "no bytes for 15s" as "idle".
 */
function deriveTurn(state: HarnessState, running: boolean): TurnState {
    if (!running) return 'idle';
    if (state.approvals.length > 0) return 'awaiting-approval';
    if (state.tools.some((t) => t.status === 'pending')) return 'tool';
    return 'thinking';
}

/** Re-derive turn state, preserving `since` when the state has not changed. */
function withTurn(state: HarnessState, running: boolean, now: number): HarnessState {
    const next = deriveTurn(state, running);
    if (next === state.turn.state) return state;
    return { ...state, turn: { state: next, since: now } };
}

/** Is a turn currently open? Read off the derived state rather than tracked twice. */
function isRunning(state: HarnessState): boolean {
    return state.turn.state !== 'idle';
}

/**
 * `composer.busy` is the turn state seen from the input box's point of view. It
 * is re-derived on every fold rather than tracked, because the bridge reports
 * `state.composer` straight to Genie: a `busy` that could lag `turn.state` is a
 * delivery typed into a running agent's prompt.
 */
function normalize(state: HarnessState): HarnessState {
    const busy = state.turn.state !== 'idle';
    if (state.composer.busy === busy) return state;
    return { ...state, composer: { ...state.composer, busy } };
}

export function reduce(state: HarnessState, event: HarnessEvent, now: number): HarnessState {
    return normalize(fold(state, event, now));
}

function fold(state: HarnessState, event: HarnessEvent, now: number): HarnessState {
    switch (event.kind) {
        case 'tick':
            return state;

        case 'session-ready':
            return {
                ...state,
                session: {
                    ...state.session,
                    sessionId: event.sessionId,
                    threadId: event.threadId,
                },
            };

        case 'turn-start': {
            // A new turn clears the previous turn's tool cards; the transcript
            // keeps the history.
            const cleared: HarnessState = { ...state, tools: [], error: null };
            return withTurn(cleared, true, now);
        }

        case 'turn-end': {
            // An in-flight message that never completed still gets committed —
            // losing a partial answer because the turn aborted would be worse
            // than showing it.
            const committed = state.live ? commit(state, state.live) : state;
            const ended: HarnessState = { ...committed, live: null, approvals: [] };
            return withTurn(ended, false, now);
        }

        case 'message': {
            if (!event.done) {
                return {
                    ...state,
                    live: { id: event.id, role: event.role, content: event.content },
                };
            }
            const next = commit(
                { ...state, live: null },
                { id: event.id, role: event.role, content: event.content },
            );
            return next;
        }

        case 'tool-start': {
            const withTool: HarnessState = {
                ...state,
                tools: [...state.tools, { id: event.id, name: event.name, status: 'pending' }],
            };
            return withTurn(withTool, isRunning(state), now);
        }

        case 'tool-end': {
            const tools = state.tools.map((t) =>
                t.id === event.id
                    ? { ...t, status: event.isError ? ('failure' as const) : ('success' as const) }
                    : t,
            );
            return withTurn({ ...state, tools }, isRunning(state), now);
        }

        case 'approval-required': {
            const withApproval: HarnessState = {
                ...state,
                approvals: [
                    ...state.approvals,
                    { id: event.id, name: event.name, args: event.args },
                ],
            };
            return withTurn(withApproval, isRunning(state), now);
        }

        case 'approval-resolved': {
            const approvals = state.approvals.filter((a) => a.id !== event.id);
            return withTurn({ ...state, approvals }, isRunning(state), now);
        }

        case 'composer-change':
            return {
                ...state,
                composer: { ...state.composer, text: event.text, cursor: event.cursor },
            };

        case 'composer-submit': {
            const cleared: HarnessState = {
                ...state,
                composer: { ...state.composer, text: '', cursor: 0 },
            };
            return commit(cleared, {
                id: `user-${now}`,
                role: 'user',
                content: event.text,
            });
        }

        case 'error':
            return { ...state, error: event.message };
    }
}

/**
 * Append to the committed transcript, once.
 *
 * Committed messages render through Ink's `Static`, which is what keeps
 * scrollback intact — but `Static` also means a re-commit would print a
 * duplicate rather than replace. The guard belongs here, not in the view.
 */
function commit(state: HarnessState, message: HarnessState['transcript'][number]): HarnessState {
    if (state.transcript.some((m) => m.id === message.id)) return state;
    return { ...state, transcript: [...state.transcript, message] };
}
