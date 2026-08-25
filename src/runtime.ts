/**
 * PURE. The agent-runtime seam — OUR interface, not a vendor's.
 *
 * ## Why this exists
 *
 * Mastra is a **temporary dependency with a planned exit**: the first-party
 * harness lands when the Prism language-parity packages do. So the runtime is
 * not the architecture, it is an implementation detail behind this interface,
 * and the interface is deliberately ours.
 *
 * That is also the generic recommendation from the agent-resources research this
 * project's stack came from — *"a thin, stable plugin ABI owned by you, with
 * external projects adapted behind capability-oriented interfaces … Mastra,
 * LangChain, OpenAI Agents should be plugins behind your interfaces, not your
 * interfaces themselves."* Here it is not a principle, it is a scheduled event.
 *
 * ## What that buys, concretely
 *
 * Everything above this line — `protocol`, `reduce`, `harness`, `surfaces`,
 * `bridge/genie`, `ui/App` — is written against `HarnessEvent`, which no vendor
 * defines. Swapping the runtime is then one new file implementing `Runtime`,
 * not a rewrite. `__tests__/runtime-boundary.test.ts` holds that invariant two
 * ways: it runs the whole harness on a hand-written runtime, and it checks the
 * files above the seam, AS SOURCE, for any Mastra import — because a seam that
 * is only asserted rots the first time someone adds one convenient
 * `import type`, with every test still green.
 *
 * ## Deliberately small
 *
 * Four methods. Anything a specific runtime is good at that this cannot express
 * — Mastra's workflows, its observational memory, its subagents — is reachable
 * by its own implementation, but must not leak upward. Widening this interface
 * to fit one vendor is how the exit gets expensive.
 */

import type { HarnessEvent } from './protocol.js';

/** One live conversation. Created by a {@link Runtime}, driven by the harness. */
export interface RuntimeSession {
    /**
     * Dispatch a user message. Resolves when the runtime has ACCEPTED it, not
     * when the turn is over — the harness decides the turn is over by watching
     * for a declared `turn-end`, which is the whole point of the protocol.
     */
    send(text: string): Promise<void>;

    /** Abort the in-flight turn. */
    interrupt(): void;

    /**
     * Subscribe to harness events. Batched, because one runtime event can imply
     * several harness facts and the reducer should see them together.
     */
    subscribe(fn: (events: HarnessEvent[]) => void): () => void;

    dispose(): Promise<void>;
}

export interface RuntimeSessionOptions {
    /** Genie's chat-id, minted at launch. The runtime's thread id, if it has one. */
    sessionId: string;
    cwd: string;
    name: string;
}

/** A source of sessions. One implementation per agent runtime. */
export interface Runtime {
    createSession(options: RuntimeSessionOptions): Promise<RuntimeSession>;
}
