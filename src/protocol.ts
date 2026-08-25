/**
 * The harness protocol — the facts Genie currently INFERS from pty bytes,
 * stated instead.
 *
 * Genie models a foreign TUI's input box by folding the keystrokes it forwards
 * (`main/agentinbox/draft.ts`), and decides whether an agent is mid-turn by
 * measuring output silence (`main/agentinbox/wake.ts`, `WAKE_QUIET_MS = 15s`).
 * Both are inferences about somebody else's interface, and both have failed
 * silently in production — genie#218 (a notice read as a paste, so its newline
 * never submitted) and genie#257 (Kitty `CSI 13 u` Enter destroying draft
 * confidence on every Codex submit).
 *
 * This module is the alternative: a small, closed set of events a cooperating
 * harness emits, and the state they fold into. Nothing here imports Mastra, Ink
 * or Genie — the adapters do that, and this stays testable without a terminal
 * or a model.
 */

/** Provider id this harness registers under in Genie's agent model. */
export const PROVIDER = 'genie' as const;

/**
 * What the agent is doing, stated rather than sniffed.
 *
 * `tool` is deliberately distinct from `thinking`: a build or a test suite can
 * run silently for minutes, which is precisely the case output-silence
 * heuristics get wrong.
 */
export type TurnState = 'idle' | 'thinking' | 'tool' | 'awaiting-approval' | 'awaiting-input';

export type MessageRole = 'user' | 'agent' | 'tool' | 'error' | 'system';

export interface Message {
    id: string;
    role: MessageRole;
    content: string;
}

export interface ToolCall {
    id: string;
    name: string;
    status: 'pending' | 'success' | 'failure';
}

export interface PendingApproval {
    id: string;
    name: string;
    args: unknown;
}

/**
 * The input box, as fact rather than reconstruction.
 *
 * `busy` is what lets a delivery be QUEUED instead of typed: Genie's current
 * nudge has to cut the line, paste a notice, send a bare CR 60ms later, then
 * restore what it cut (`buildNudgeSequence`). A harness that owns its own
 * composer just takes the message.
 */
export interface ComposerState {
    text: string;
    cursor: number;
    busy: boolean;
}

export interface SessionState {
    provider: typeof PROVIDER;
    name: string;
    cwd: string;
    /** Genie's `{provider}:{name}:{chat-id}` chat-id. Bound at launch. */
    sessionId: string | null;
    /** Mastra thread id. Same value as `sessionId` — one id, two vocabularies. */
    threadId: string | null;
}

export interface HarnessState {
    session: SessionState;
    turn: { state: TurnState; since: number };
    composer: ComposerState;
    /** Committed messages. Rendered through Ink `Static`, so they never repaint. */
    transcript: Message[];
    /** The in-flight message, if any. Lives in `LiveRegion`, below the static region. */
    live: Message | null;
    tools: ToolCall[];
    approvals: PendingApproval[];
    error: string | null;
}

/**
 * Everything that can change the state.
 *
 * Kept deliberately small and vendor-neutral: Mastra's `AgentControllerEvent`
 * has ~50 members (observational-memory cycles, subagent lifecycles, workspace
 * status). Normalising to this union is what keeps a churning upstream — core
 * is at 1.61.0 and has already renamed `stream`/`streamVNext` once — confined
 * to one adapter file.
 */
export type HarnessEvent =
    | { kind: 'session-ready'; sessionId: string; threadId: string }
    | { kind: 'turn-start' }
    | { kind: 'turn-end'; reason: 'complete' | 'aborted' | 'error' | 'suspended' }
    | { kind: 'message'; id: string; role: MessageRole; content: string; done: boolean }
    | { kind: 'tool-start'; id: string; name: string }
    | { kind: 'tool-end'; id: string; isError: boolean }
    | { kind: 'approval-required'; id: string; name: string; args: unknown }
    | { kind: 'approval-resolved'; id: string }
    | { kind: 'composer-change'; text: string; cursor: number }
    | { kind: 'composer-submit'; text: string }
    | { kind: 'error'; message: string }
    /** No-op. Exists so a caller can advance the clock without asserting a fact. */
    | { kind: 'tick' };
