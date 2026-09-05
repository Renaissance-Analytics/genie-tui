import { Agent } from '@mastra/core/agent';
import { AgentController } from '@mastra/core/agent-controller';
import type { AgentControllerEvent, Session } from '@mastra/core/agent-controller';

import { fromMastra } from '../adapter/mastra.js';
import { offlineModel } from '../offline-model.js';
import type { ModelSpec } from '../model.js';
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
/**
 * Either describe the model and let this file build the agent, or hand one over.
 *
 * The `model` form is what the CLI uses, and it is why `cli.tsx` no longer
 * imports Mastra at all: the entry point states WHAT it wants to talk to and
 * this file — the one written to be deleted — decides how.
 *
 * The `agent` form exists for tests that must inject a bespoke language model,
 * which a {@link ModelSpec} deliberately cannot express: `harness.test.ts` drives
 * a real controller with Mastra's own mock, and describing that as data would
 * mean widening the spec to carry a vendor object, which is exactly the leak
 * this seam prevents.
 */
export type MastraRuntimeConfig = { agent: Agent } | { model: ModelSpec; instructions?: string };

const DEFAULT_INSTRUCTIONS =
    'You are Genie TUI, a first-party coding agent running inside Genie. Be concise.';

/**
 * A {@link ModelSpec} into a Mastra `Agent`.
 *
 * The object form `{ id, url }` is the ONLY way to reach a local endpoint:
 * `url` short-circuits Mastra's gateway/auth chain and defaults the API key to
 * empty, so a keyless Ollama or llama.cpp server just works. The string form
 * goes through the router and its auto-detected provider keys.
 *
 * An offline spec becomes a hand-written AI SDK model that answers with the
 * notice, and the agent's NAME says `(offline)` — a skeleton silently posing as
 * a working coding agent is worse than one that admits it cannot answer.
 */
function agentFor(model: ModelSpec, instructions: string): Agent {
    if (model.kind === 'invalid') {
        // Unreachable from the CLI, which reports and exits first. Throwing
        // rather than falling back keeps a misconfiguration from quietly
        // becoming a different, working configuration.
        throw new Error(model.reason);
    }

    if (model.kind === 'offline') {
        return new Agent({
            id: 'genie-tui',
            name: 'genie-tui (offline)',
            instructions: 'Offline skeleton.',
            model: offlineModel(model.notice) as never,
        });
    }

    return new Agent({
        id: 'genie-tui',
        name: 'genie-tui',
        instructions,
        model: (model.url ? { id: model.id, url: model.url } : model.id) as never,
    });
}

export function mastraRuntime(config: MastraRuntimeConfig): Runtime {
    const agent =
        'agent' in config
            ? config.agent
            : agentFor(config.model, config.instructions ?? DEFAULT_INSTRUCTIONS);

    return {
        async createSession(options: RuntimeSessionOptions): Promise<RuntimeSession> {
            const controller = new AgentController({
                id: `genie-tui:${options.name}`,
                agent,
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
