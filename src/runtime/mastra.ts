import { AgentController } from '@mastra/core/agent-controller';
import type { Agent } from '@mastra/core/agent';
import type { AgentControllerEvent, Session } from '@mastra/core/agent-controller';

import { fromMastra } from '../adapter/mastra.js';
import type { Runtime, RuntimeSession, RuntimeSessionOptions } from '../runtime.js';

/**
 * The Mastra implementation of {@link Runtime} — and, with
 * `adapter/mastra.ts`, the ONLY part of this project that knows Mastra exists.
 *
 * Mastra is temporary: the first-party harness replaces it when the Prism
 * language-parity packages land. So this file is written to be **deleted**, not
 * extended. Two rules follow from that, and they are the reason it is this
 * small:
 *
 *  - Nothing Mastra-shaped escapes upward. The only thing that crosses the seam
 *    is `HarnessEvent[]`, which we define.
 *  - No deep accommodation for Mastra's quirks. Its string-only model switcher,
 *    the missing `ollama` provider, the silently-stripped sampling params, the
 *    absent schema-compat layer for OpenAI-compatible endpoints — all real (see
 *    GAPS.md), none worth building a subsystem around for a dependency that is
 *    leaving. Adapt minimally; log the rest.
 *
 * `AgentController` is Mastra's own name for the harness concept, documented as
 * an "in-process, collaborative session" rather than a stateless endpoint, which
 * is why the TUI embeds it directly instead of running `mastra dev` and talking
 * to a local server.
 */
export function mastraRuntime(config: { agent: Agent }): Runtime {
    return {
        async createSession(options: RuntimeSessionOptions): Promise<RuntimeSession> {
            const controller = new AgentController({
                id: `genie-tui:${options.name}`,
                agent: config.agent,
                modes: [{ id: 'build', name: 'Build', metadata: { default: true } }],
            });
            await controller.init();

            // Genie's chat-id IS the Mastra thread id. One identifier, two
            // vocabularies — which is what lets a saved agent be reattached
            // rather than re-minted.
            const session: Session = await controller.createSession({
                resourceId: options.cwd,
                scope: 'genie-tui',
                threadId: options.sessionId,
            });

            const listeners = new Set<(events: import('../protocol.js').HarnessEvent[]) => void>();

            const unsubscribe = session.subscribe((event: AgentControllerEvent) => {
                const events = fromMastra(event);
                if (events.length === 0) return;
                for (const fn of listeners) fn(events);
            });

            return {
                async send(text: string) {
                    await session.sendMessage({ content: text });
                },
                interrupt() {
                    session.abort();
                },
                subscribe(fn) {
                    listeners.add(fn);
                    return () => {
                        listeners.delete(fn);
                    };
                },
                async dispose() {
                    unsubscribe();
                    listeners.clear();
                },
            };
        },
    };
}
