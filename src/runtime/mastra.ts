import { Agent } from '@mastra/core/agent';
import { AgentController } from '@mastra/core/agent-controller';
import { createTool } from '@mastra/core/tools';
import { LibSQLStore } from '@mastra/libsql';
import type { AgentControllerEvent, Session } from '@mastra/core/agent-controller';

import { fromMastra } from '../adapter/mastra.js';
import { offlineModel } from '../offline-model.js';
import type { ModelSpec } from '../model.js';
import type { Runtime, RuntimeSession, RuntimeSessionOptions } from '../runtime.js';
import type { HarnessTool } from '../tools.js';

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
export type MastraRuntimeConfig = ({ agent: Agent } | { model: ModelSpec; instructions?: string; tools?: HarnessTool[] }) & {
    /**
     * Where the controller keeps its run snapshots. Defaults to in-memory.
     *
     * NOT optional in practice, which is why there is no way to turn it off.
     * `AgentController` gates every tool call by SUSPENDING the run, and
     * resuming reads a snapshot back out of storage — so with no storage
     * configured, `respondToToolApproval` produces
     * `AGENT_RESUME_NO_SNAPSHOT_FOUND`, the turn ends `reason: 'error'`, and
     * the tool never runs. Every tool call failed that way, and the failure
     * looked like a model that answered nothing.
     *
     * A file path here makes threads survive the process, which is what a
     * cross-run `--resume` would need. In-memory is the default because
     * inventing a data directory in someone's home is a decision for the
     * owner, not a side effect of fixing approvals.
     */
    dbUrl?: string;
};

/**
 * Our tools in Mastra's shape.
 *
 * The translation is the whole reason `tools.ts` is vendor-neutral: the tools
 * are the most valuable thing in a coding agent and the least worth rewriting
 * when the runtime is replaced, so they are defined against our own type and
 * adapted here, below the seam, in eight lines.
 *
 * `execute` takes the parsed input directly in Mastra v1 — not the older
 * `{ context }` wrapper — and our `run` already returns a string for both
 * success and failure, so there is nothing to catch here.
 */
function mastraTools(tools: HarnessTool[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const tool of tools) {
        out[tool.name] = createTool({
            id: tool.name,
            description: tool.description,
            inputSchema: tool.schema,
            execute: async (input: unknown) => tool.run((input ?? {}) as Record<string, unknown>),
        });
    }
    return out;
}

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
export function agentFor(model: ModelSpec, instructions: string, tools: HarnessTool[] = []): Agent {
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
            // Tools regardless of which model is chosen. The model decides
            // whether to CALL a tool; it must not decide which tools exist, or
            // the agent's capabilities silently change with its configuration
            // and every tool test still passes.
            tools: mastraTools(tools) as never,
        });
    }

    return new Agent({
        id: 'genie-tui',
        name: 'genie-tui',
        instructions,
        model: (model.url ? { id: model.id, url: model.url } : model.id) as never,
        tools: mastraTools(tools) as never,
    });
}

export function mastraRuntime(config: MastraRuntimeConfig): Runtime {
    const agent =
        'agent' in config
            ? config.agent
            : agentFor(config.model, config.instructions ?? DEFAULT_INSTRUCTIONS, config.tools);

    return {
        async createSession(options: RuntimeSessionOptions): Promise<RuntimeSession> {
            const controller = new AgentController({
                id: `genie-tui:${options.name}`,
                agent,
                // See `dbUrl` above: without storage the approval gate cannot
                // be released and every tool call dies on resume.
                storage: new LibSQLStore({
                    id: 'genie-tui',
                    url: config.dbUrl ?? ':memory:',
                }) as never,
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
                /**
                 * `AgentController` parks the run on a promise when a tool is
                 * gated and releases it here. Mastra calls the negative case
                 * `decline`; the protocol calls it `deny`, and this is the one
                 * place the two vocabularies meet.
                 */
                respondToApproval(id, decision) {
                    session.respondToToolApproval({
                        decision: decision === 'approve' ? 'approve' : 'decline',
                        toolCallId: id,
                    });
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
