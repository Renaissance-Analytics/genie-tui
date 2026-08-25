import { PROVIDER } from '../protocol.js';
import type { HarnessState } from '../protocol.js';

/**
 * The Genie bridge — the harness telling Genie what it is doing.
 *
 * ## Why there is no new transport here
 *
 * Genie already launches every agent terminal with `GENIE_MCP_URL` and
 * `GENIE_TERMINAL_ID` in its environment (`main/terminal/ipc.ts`). That URL is a
 * PER-TERMINAL endpoint minted by `registerTerminalEndpoint`
 * (`main/mcp/server.ts`): an 18-byte hex token that self-identifies the terminal
 * server-side, persisted so it survives a Genie restart. Codex's SessionStart
 * hook already POSTs `agentinbox / registerSession` to exactly this.
 *
 * So the channel is already authenticated, already per-terminal, and already
 * bidirectional (`main/mcp/server-push.ts` pushes `notifications/message` down
 * the GET SSE stream). A first-party TUI needs no socket, no daemon, no Electron
 * IPC — just this.
 *
 * ## What Genie does not have yet
 *
 * The `reportState` action does not exist on Genie's `agentinbox` tool. This
 * emits the frame Genie WOULD need to accept, which makes the payload below the
 * actual proposal rather than a description of one. Until that action lands the
 * call is answered with a JSON-RPC error, which is why every failure here is
 * swallowed: an unreported harness must still be a working coding agent.
 */

export interface GenieBridge {
    /** False when Genie did not launch this process. */
    enabled: boolean;
    report(state: HarnessState): Promise<void>;
    /** Coalescing report — many calls in a burst produce one request. */
    schedule(state: HarnessState): void;
    dispose(): void;
}

export interface HarnessReport {
    ref: string;
    provider: typeof PROVIDER;
    name: string;
    sessionId: string | null;
    composer: { text: string; cursor: number; busy: boolean };
    turn: {
        state: HarnessState['turn']['state'];
        since: number;
        pendingTools: string[];
        approvals: { id: string; name: string }[];
    };
}

/**
 * The payload — every field a value Genie currently INFERS.
 *
 * `composer` replaces `Draft{text, confident, image}`, folded from forwarded
 * keystrokes. There is no `confident` here because nothing was reconstructed:
 * the composer is controlled React state, so the buffer is simply known.
 *
 * `turn` replaces `wake.ts`, which decides busy-ness from fifteen seconds of
 * measured output silence — a rule that reads a long, quiet tool call as idle.
 */
export function harnessReport(state: HarnessState): HarnessReport {
    return {
        ref: state.session.sessionId
            ? `${PROVIDER}:${state.session.name}:${state.session.sessionId}`
            : `${PROVIDER}:${state.session.name}`,
        provider: PROVIDER,
        name: state.session.name,
        sessionId: state.session.sessionId,
        composer: { ...state.composer },
        turn: {
            state: state.turn.state,
            since: state.turn.since,
            pendingTools: state.tools.filter((t) => t.status === 'pending').map((t) => t.name),
            approvals: state.approvals.map((a) => ({ id: a.id, name: a.name })),
        },
    };
}

export function createGenieBridge(opts: {
    url: string | undefined;
    terminalId: string | undefined;
    debounceMs?: number;
}): GenieBridge {
    const enabled = Boolean(opts.url);
    const debounceMs = opts.debounceMs ?? 100;
    let timer: NodeJS.Timeout | null = null;
    let pending: HarnessState | null = null;
    let seq = 0;

    async function report(state: HarnessState): Promise<void> {
        if (!opts.url) return;
        try {
            await fetch(opts.url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream',
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: ++seq,
                    method: 'tools/call',
                    params: {
                        name: 'agentinbox',
                        arguments: {
                            action: 'reportState',
                            // No terminal id: the endpoint token already
                            // identifies the terminal server-side (genie #35).
                            // Sending one would invite Genie to trust a
                            // caller-supplied value.
                            state: harnessReport(state),
                        },
                    },
                }),
                signal: AbortSignal.timeout(5_000),
            });
        } catch {
            // Genie may be closed, restarting, or not the parent at all. A
            // harness that dies because its reporting channel is unavailable is
            // strictly worse than one that runs unreported.
        }
    }

    return {
        enabled,
        report,
        schedule(state) {
            pending = state;
            if (timer) return;
            timer = setTimeout(() => {
                timer = null;
                const next = pending;
                pending = null;
                if (next) void report(next);
            }, debounceMs);
        },
        dispose() {
            if (timer) clearTimeout(timer);
            timer = null;
            pending = null;
        },
    };
}
