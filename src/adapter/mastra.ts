import type { AgentControllerEvent } from '@mastra/core/agent-controller';

import type { HarnessEvent, MessageRole } from '../protocol.js';

/**
 * Mastra -> harness protocol. The ONLY file that knows Mastra's vocabulary.
 *
 * `AgentControllerEvent` is a ~50-member union covering observational-memory
 * cycles, subagent lifecycles, workspace status and goal evaluation. The harness
 * needs eleven facts. Normalising here — rather than switching on Mastra event
 * types in the reducer or the view — is what confines an upstream that is
 * plainly still moving (core 1.61.0, with a `stream`/`streamVNext` rename
 * already behind it) to a single, fully-tested boundary.
 *
 * Returns an array because the mapping is not always one-to-one; today every
 * case is 0 or 1, and the shape leaves room for a Mastra event that implies two
 * harness facts without changing every call site.
 */
export function fromMastra(event: AgentControllerEvent): HarnessEvent[] {
    switch (event.type) {
        case 'agent_start':
            return [{ kind: 'turn-start' }];

        case 'agent_end':
            return [{ kind: 'turn-end', reason: event.reason ?? 'complete' }];

        case 'message_update':
            return [message(event.message, false)];

        case 'message_end':
            return [message(event.message, true)];

        case 'tool_start':
            return [{ kind: 'tool-start', id: event.toolCallId, name: event.toolName }];

        case 'tool_end':
            return [{ kind: 'tool-end', id: event.toolCallId, isError: event.isError }];

        case 'tool_approval_required':
            return [
                {
                    kind: 'approval-required',
                    id: event.toolCallId,
                    name: event.toolName,
                    args: event.args,
                },
            ];

        case 'error':
            return [{ kind: 'error', message: event.error.message }];

        default:
            // Everything else is real, and none of it is a fact Genie needs about
            // the input box or the turn. Dropped explicitly rather than by
            // omission, so adding a case is a decision.
            return [];
    }
}

/** Mastra's message roles, in the harness's vocabulary. */
function roleOf(role: unknown): MessageRole {
    if (role === 'user') return 'user';
    if (role === 'system') return 'system';
    if (role === 'tool') return 'tool';
    return 'agent';
}

/**
 * Flatten a Mastra DB message to the text a terminal shows.
 *
 * Mastra carries structured content parts (text, reasoning, tool invocations,
 * files). The transcript wants the text parts joined — taking only the first
 * would silently truncate any answer the model split, which is most of them.
 * Reasoning is excluded on purpose: it belongs in a separate pane, not inline.
 */
function message(raw: unknown, done: boolean): HarnessEvent {
    const m = raw as { id?: string; role?: unknown; content?: unknown };
    const content = m.content as { parts?: unknown[] } | string | undefined;

    let text = '';
    if (typeof content === 'string') {
        text = content;
    } else if (content && Array.isArray(content.parts)) {
        text = content.parts
            .filter(
                (p): p is { type: string; text: string } =>
                    typeof p === 'object' &&
                    p !== null &&
                    (p as { type?: unknown }).type === 'text' &&
                    typeof (p as { text?: unknown }).text === 'string',
            )
            .map((p) => p.text)
            .join('');
    }

    return {
        kind: 'message',
        id: m.id ?? '',
        role: roleOf(m.role),
        content: text,
        done,
    };
}
