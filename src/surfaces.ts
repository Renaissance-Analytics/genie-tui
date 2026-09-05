import type { TuiSurfaceDescriptor } from '@particle-academy/fancy-tui';

import { PROVIDER } from './protocol.js';
import type { HarnessState } from './protocol.js';

/**
 * The harness as `fancy-tui` Human+ surfaces.
 *
 * This is the integration contract, and the choice worth defending: rather than
 * invent a Genie-specific reporting protocol, the TUI models itself as surfaces
 * with `read()` and `commands`, which is `fancy-tui`'s own agent-driveable
 * shape. Genie's bridge is then a thin adapter over the registry — and every
 * other Human+ MCP client gets the same access for free.
 *
 * Each surface answers a question Genie currently has to guess at:
 *
 *  - `composer` — what is in the input box, and put this message in it.
 *    Replaces `main/agentinbox/draft.ts` (a keystroke-folded model of somebody
 *    else's input box) and `buildNudgeSequence` (Ctrl-A/Ctrl-K/paste/delayed CR).
 *  - `turn` — is the agent working, and stop.
 *    Replaces `main/agentinbox/wake.ts`, which infers busy-ness from 15 seconds
 *    of measured output silence.
 *  - `session` — who this agent is, in Genie's `{provider}:{name}:{chat-id}` form.
 */

/**
 * Every surface id in one place, because two of them nearly collided fatally.
 *
 * `fancy-tui` components register their OWN surfaces through `useTuiSurface`,
 * keyed on the `id` prop the consumer passes — `<Composer id="composer">`
 * publishes `kind: 'multiline-input'` under `composer`. The registry throws on a
 * duplicate id, so when the harness also registered its `composer` surface the
 * app died on mount, in every terminal, having painted exactly one frame.
 *
 * The fix is not to rename one of them arbitrarily. They are genuinely two
 * different things and the ids now say so:
 *
 *  - `composer` — the AGENT-FACING contract. Text, cursor and `busy`, plus
 *    `deliver`, which appends without disturbing a half-typed line. This is
 *    what replaces Genie's keystroke-folded draft model, and `busy` is the fact
 *    that lets a delivery be queued rather than typed at a running agent.
 *  - `composer.input` — the WIDGET underneath. Raw buffer, cursor and selection.
 *    It knows about text and nothing about turns.
 *
 * The dotted id states the containment rather than hiding the relationship
 * behind an unrelated name.
 */
export const SURFACE_IDS = {
    composer: 'composer',
    composerInput: 'composer.input',
    turn: 'turn',
    session: 'session',
} as const;

export interface HarnessActions {
    /** Replace the composer buffer. The human typing, or a programmatic edit. */
    setText: (text: string, cursor?: number) => void;
    /**
     * Queue an EXTERNAL message into the composer — an AgentInbox DM, a Genie
     * notice. Distinct from `setText` because it must APPEND to whatever the
     * human has half-typed rather than replace it, which is the whole failure
     * mode `buildNudgeSequence` works around by cutting and restoring the line.
     */
    deliver: (text: string) => void;
    submit: () => void;
    clear: () => void;
    /** Abort the in-flight turn. */
    interrupt: () => void;
    /** Let a parked tool call proceed. */
    approve: (id: string) => void;
    /** Refuse a parked tool call. The turn continues; the tool does not. */
    deny: (id: string) => void;
}

/**
 * Genie's agent ref, composed the same way `main/agents/identity.ts` composes it:
 * `{provider}:{name}` until a chat-id exists, `{provider}:{name}:{chat-id}` after.
 *
 * A missing chat-id is a correct state, not a failure — it is simply the window
 * before binding. Human-facing surfaces show the provider logo and the name; the
 * ref is for machines.
 */
function agentRef(state: HarnessState): string {
    const key = `${state.session.provider}:${state.session.name}`;
    return state.session.sessionId ? `${key}:${state.session.sessionId}` : key;
}

export function harnessSurfaces(
    read: () => HarnessState,
    actions: HarnessActions,
): TuiSurfaceDescriptor[] {
    return [
        {
            id: SURFACE_IDS.composer,
            kind: 'input',
            label: 'Prompt',
            // Deliberately the whole composer state and nothing more. No
            // `confident` field: there is no reconstruction here to be
            // unconfident about.
            read: () => ({ ...read().composer }),
            commands: [
                {
                    name: 'deliver',
                    description:
                        'Queue a message into the composer without disturbing what the human is typing.',
                    policy: 'execute',
                    inputSchema: {
                        type: 'object',
                        properties: { text: { type: 'string' } },
                        required: ['text'],
                    },
                    invoke: (input) => {
                        const text = typeof input?.['text'] === 'string' ? input['text'] : '';
                        actions.deliver(text);
                    },
                },
                {
                    name: 'submit',
                    description: 'Start a turn with the composer contents.',
                    policy: 'execute',
                    invoke: () => actions.submit(),
                },
                {
                    name: 'clear',
                    description: 'Empty the composer.',
                    policy: 'confirm',
                    invoke: () => actions.clear(),
                },
            ],
        },
        {
            id: SURFACE_IDS.turn,
            kind: 'status',
            label: 'Turn',
            read: () => {
                const s = read();
                return {
                    state: s.turn.state,
                    since: s.turn.since,
                    pendingTools: s.tools.filter((t) => t.status === 'pending').map((t) => t.name),
                    approvals: s.approvals.map((a) => ({ id: a.id, name: a.name })),
                };
            },
            commands: [
                {
                    name: 'interrupt',
                    description: 'Abort the in-flight turn.',
                    policy: 'confirm',
                    invoke: () => actions.interrupt(),
                },
            ],
        },
        {
            id: SURFACE_IDS.session,
            kind: 'identity',
            label: 'Session',
            read: () => {
                const s = read();
                return {
                    ref: agentRef(s),
                    provider: PROVIDER,
                    name: s.session.name,
                    cwd: s.session.cwd,
                    sessionId: s.session.sessionId,
                    threadId: s.session.threadId,
                };
            },
        },
    ];
}
