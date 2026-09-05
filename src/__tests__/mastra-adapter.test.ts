import { describe, expect, it } from 'vitest';
import type { AgentControllerEvent } from '@mastra/core/agent-controller';

import { fromMastra } from '../adapter/mastra.js';

/**
 * Mastra's `AgentControllerEvent` has ~50 members — observational-memory cycles,
 * subagent lifecycles, workspace status, goal evaluation. The harness needs
 * eleven facts. This adapter is the only file in the project that knows Mastra's
 * vocabulary, which is what keeps a fast-moving upstream (core is at 1.61.0 and
 * has already renamed `stream`/`streamVNext` once) out of the reducer and the
 * view.
 *
 * The events below are typed as `AgentControllerEvent`, so if Mastra changes a
 * payload shape this file stops compiling — which is the point of having it.
 */

const at = (e: AgentControllerEvent) => fromMastra(e);

describe('turn boundaries', () => {
    it('maps agent_start to turn-start', () => {
        expect(at({ type: 'agent_start' })).toEqual([{ kind: 'turn-start' }]);
    });

    it('maps agent_end to turn-end, carrying the reason through', () => {
        expect(at({ type: 'agent_end', reason: 'aborted' })).toEqual([
            { kind: 'turn-end', reason: 'aborted' },
        ]);
    });

    it('defaults a reasonless agent_end to complete', () => {
        expect(at({ type: 'agent_end' })).toEqual([{ kind: 'turn-end', reason: 'complete' }]);
    });
});

describe('messages', () => {
    const message = (id: string, text: string) =>
        ({
            id,
            role: 'assistant',
            content: { format: 2, parts: [{ type: 'text', text }] },
        }) as unknown as Extract<AgentControllerEvent, { type: 'message_update' }>['message'];

    it('maps message_update to an in-flight message', () => {
        expect(at({ type: 'message_update', message: message('m1', 'Looking') })).toEqual([
            { kind: 'message', id: 'm1', role: 'agent', content: 'Looking', done: false },
        ]);
    });

    it('maps message_end to a completed message', () => {
        expect(at({ type: 'message_end', message: message('m1', 'Done.') })).toEqual([
            { kind: 'message', id: 'm1', role: 'agent', content: 'Done.', done: true },
        ]);
    });

    it('joins multiple text parts rather than dropping all but the first', () => {
        const multi = {
            id: 'm1',
            role: 'assistant',
            content: {
                format: 2,
                parts: [
                    { type: 'text', text: 'one' },
                    { type: 'reasoning', text: 'ignored' },
                    { type: 'text', text: ' two' },
                ],
            },
        } as unknown as Extract<AgentControllerEvent, { type: 'message_end' }>['message'];
        expect(at({ type: 'message_end', message: multi })).toEqual([
            { kind: 'message', id: 'm1', role: 'agent', content: 'one two', done: true },
        ]);
    });

    it('maps a user message to the user role', () => {
        const user = {
            id: 'u1',
            role: 'user',
            content: { format: 2, parts: [{ type: 'text', text: 'hi' }] },
        } as unknown as Extract<AgentControllerEvent, { type: 'message_end' }>['message'];
        expect(at({ type: 'message_end', message: user })).toEqual([
            { kind: 'message', id: 'u1', role: 'user', content: 'hi', done: true },
        ]);
    });
});

describe('tools', () => {
    it('maps tool_start', () => {
        expect(at({ type: 'tool_start', toolCallId: 't1', toolName: 'read_file', args: {} })).toEqual([
            { kind: 'tool-start', id: 't1', name: 'read_file' },
        ]);
    });

    it('maps tool_end, preserving the error flag', () => {
        expect(at({ type: 'tool_end', toolCallId: 't1', result: null, isError: true })).toEqual([
            { kind: 'tool-end', id: 't1', isError: true },
        ]);
    });

    it('maps tool_approval_required', () => {
        expect(
            at({
                type: 'tool_approval_required',
                toolCallId: 'a1',
                toolName: 'delete_branch',
                args: { branch: 'main' },
            }),
        ).toEqual([
            { kind: 'approval-required', id: 'a1', name: 'delete_branch', args: { branch: 'main' } },
        ]);
    });
});

describe('errors', () => {
    it('maps error to an error event with the message', () => {
        expect(at({ type: 'error', error: new Error('rate limited') })).toEqual([
            { kind: 'error', message: 'rate limited' },
        ]);
    });
});

describe('what it deliberately ignores', () => {
    /**
     * A negative test that would pass on a corpse, so it carries a positive
     * control: the same adapter must still map a real event in the same breath.
     * Otherwise "returns nothing" would also pass if `fromMastra` were `() => []`.
     */
    it('drops observational-memory and subagent noise, while still mapping real events', () => {
        const noise: AgentControllerEvent[] = [
            { type: 'om_model_changed', role: 'observer', modelId: 'x' },
            { type: 'usage_update', usage: {} as never },
            { type: 'subagent_text_delta', toolCallId: 's1', agentType: 'explore', textDelta: 'x' },
            { type: 'workspace_ready', workspaceId: 'w', workspaceName: 'w' },
        ];
        expect(noise.flatMap(at)).toEqual([]);

        // Positive control — the adapter is alive.
        expect(at({ type: 'agent_start' })).toEqual([{ kind: 'turn-start' }]);
    });
});

describe('messages that carry no text', () => {
    /**
     * Mastra emits a `message_end` for the assistant message that HOLDS a tool
     * invocation. Its content is a `tool-invocation` part and nothing else, so
     * flattening it to text gives an empty string — and committing that painted
     * a blank agent bubble in the transcript for every single tool call.
     *
     * Measured against a real controller, not imagined: a one-tool turn produced
     * a transcript of `["what does hello.txt say?", "", ""]`. The tool call is
     * already represented by its own tool card, so the right answer is to emit
     * nothing at all.
     */
    it('drops an assistant message that is only a tool invocation', () => {
        expect(
            at({
                type: 'message_end',
                message: {
                    id: 'm1',
                    role: 'assistant',
                    content: {
                        format: 2,
                        parts: [
                            {
                                type: 'tool-invocation',
                                toolInvocation: {
                                    state: 'call',
                                    toolCallId: 'call_1',
                                    toolName: 'read_file',
                                    args: {},
                                },
                            },
                        ],
                    },
                } as never,
            }),
        ).toEqual([]);
    });

    /**
     * Mastra wraps the USER's own message in a `signal` role with a
     * `data-user-message` part. The harness already committed that text when the
     * composer submitted it, so echoing it back — as an `agent` message, because
     * `signal` is not a role the protocol has — is both a duplicate and wrongly
     * attributed.
     */
    it('drops the signal envelope Mastra wraps the user message in', () => {
        expect(
            at({
                type: 'message_end',
                message: {
                    id: 'm2',
                    role: 'signal',
                    content: {
                        format: 2,
                        parts: [{ type: 'data-user-message', data: { contents: 'hello' } }],
                    },
                } as never,
            }),
        ).toEqual([]);
    });

    /**
     * The positive control. "Emits nothing" is also what a completely broken
     * adapter does, so a message that DOES carry text must still come through.
     */
    it('still emits a message that has text', () => {
        expect(
            at({
                type: 'message_end',
                message: {
                    id: 'm3',
                    role: 'assistant',
                    content: { format: 2, parts: [{ type: 'text', text: 'The file says 42.' }] },
                } as never,
            }),
        ).toEqual([
            { kind: 'message', id: 'm3', role: 'agent', content: 'The file says 42.', done: true },
        ]);
    });
});
