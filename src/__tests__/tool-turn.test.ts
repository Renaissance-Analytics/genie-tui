import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { createHarness } from '../harness.js';
import { mastraRuntime } from '../runtime/mastra.js';
import { autoApprovePolicy, harnessTools } from '../tools.js';

/**
 * A model asks for a tool; the tool runs; its output comes back and the answer
 * lands in the transcript.
 *
 * This is the difference between "the agent HAS tools" and "the agent can USE
 * them". `tool-wiring.test.ts` proves the runtime was handed the tools and
 * `tools.test.ts` proves the tools work when called directly — neither says
 * anything about the loop between them, which is where an argument-shape
 * mismatch or a broken result encoding lives. A model that silently never
 * calls a tool looks exactly like a model that chose not to.
 *
 * It runs against a real OpenAI-compatible server on an ephemeral port, driven
 * to emit a tool call on the first turn and an answer on the second. No API
 * key, no model download, no network egress — so the proof is reproducible on
 * every OS in CI rather than dependent on a model deciding to cooperate.
 */

let server: http.Server;
let baseUrl = '';
let workspace = '';
/** Every request body the server saw, so the SECOND one can be inspected. */
let bodies: string[] = [];
/** What the fake model asks for on the first turn. Set per test. */
let call = { name: 'read_file', args: '{"path":"hello.txt"}' };

function sse(res: http.ServerResponse, chunks: unknown[]): void {
    res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
    });
    for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
}

const envelope = (choice: Record<string, unknown>) => ({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, ...choice }],
});

beforeEach(async () => {
    bodies = [];
    call = { name: 'read_file', args: '{"path":"hello.txt"}' };
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'genie-tui-turn-')));
    fs.writeFileSync(path.join(workspace, 'hello.txt'), 'the answer is 42\n');

    server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            bodies.push(body);

            // First turn: ask for the file. Second: answer with what came back.
            // Keyed on whether the conversation already carries a tool result,
            // which is also the thing being asserted.
            const alreadyCalled = body.includes('"tool"');

            if (!alreadyCalled) {
                sse(res, [
                    envelope({
                        delta: {
                            role: 'assistant',
                            tool_calls: [
                                {
                                    index: 0,
                                    id: 'call_1',
                                    type: 'function',
                                    function: { name: call.name, arguments: '' },
                                },
                            ],
                        },
                        finish_reason: null,
                    }),
                    envelope({
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    function: { arguments: call.args },
                                },
                            ],
                        },
                        finish_reason: null,
                    }),
                    envelope({ delta: {}, finish_reason: 'tool_calls' }),
                ]);
                return;
            }

            sse(res, [
                envelope({ delta: { role: 'assistant', content: 'The file says 42.' }, finish_reason: null }),
                envelope({ delta: {}, finish_reason: 'stop' }),
            ]);
        });
    });

    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterEach(async () => {
    fs.rmSync(workspace, { recursive: true, force: true });
    await new Promise<void>((r) => server.close(() => r()));
});

describe('the agent can actually use a tool', () => {
    it('calls read_file, feeds the result back, and answers from it', async () => {
        const harness = await createHarness({
            name: 'tooluse',
            cwd: workspace,
            sessionId: 'tool-1',
            runtime: mastraRuntime({
                model: { kind: 'remote', id: 'local/test-model', url: baseUrl },
                tools: harnessTools({ cwd: workspace }),
            }),
            autoApprove: autoApprovePolicy(harnessTools({ cwd: workspace })),
        });

        await harness.send('what does hello.txt say?');

        const state = harness.state();

        // The tool ran, and the harness recorded it as a completed call — which
        // is also what `turn.state` derives `tool` from, and what Genie reads
        // over the bridge instead of inferring from output silence.
        expect(state.tools).toEqual([{ id: expect.any(String), name: 'read_file', status: 'success' }]);

        // The model's second-turn answer reached the transcript.
        expect(state.transcript.some((m) => m.content.includes('The file says 42.'))).toBe(true);

        /**
         * The assertion that makes the rest non-vacuous.
         *
         * Everything above would also hold if the tool had "run" and returned
         * nothing: the call would still be recorded and the canned answer would
         * still arrive, because the SERVER decides what to say. So check what
         * the server was actually SENT — the second request must carry the real
         * contents of the file, which can only have come from the tool touching
         * the disk.
         */
        const second = bodies[1] ?? '';
        expect(second, 'the tool result was sent back to the model').toContain(
            'the answer is 42',
        );

        await harness.dispose();
    }, 45_000);

    /**
     * The gate, against a real model asking for a real write.
     *
     * This is the case that used to hang the process forever, and it is the
     * reason the whole approval path exists: `AgentController` parks the run on
     * a promise, and before `respondToApproval` there was nothing on the other
     * end of it. The first tool call of the first real turn never returned.
     *
     * `send()` is deliberately NOT awaited. A parked approval is genuinely
     * mid-turn, so awaiting it here would hang the test for the same reason the
     * product hung — which is exactly how GAPS H1 was found.
     */
    it('parks a write on the human, then writes when approved', async () => {
        call = { name: 'write_file', args: '{"path":"made.txt","content":"by the agent"}' };

        const tools = harnessTools({ cwd: workspace });
        const harness = await createHarness({
            name: 'tooluse',
            cwd: workspace,
            sessionId: 'tool-2',
            runtime: mastraRuntime({
                model: { kind: 'remote', id: 'local/test-model', url: baseUrl },
                tools,
            }),
            autoApprove: autoApprovePolicy(tools),
        });

        const parked = new Promise<string>((resolve) => {
            const off = harness.subscribe((s) => {
                const pending = s.approvals[0];
                if (pending) {
                    off();
                    resolve(pending.id);
                }
            });
        });

        void harness.send('create made.txt');
        const id = await parked;

        // Parked, and nothing written yet — the human has not answered.
        expect(harness.state().turn.state).toBe('awaiting-approval');
        expect(fs.existsSync(path.join(workspace, 'made.txt')), 'not written yet').toBe(false);

        harness.actions.approve(id);

        // Now it runs. Polled rather than awaited on a fixed delay, so this
        // fails as a timeout with a message instead of flaking on a slow runner.
        const deadline = Date.now() + 20_000;
        while (!fs.existsSync(path.join(workspace, 'made.txt')) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
        }

        expect(
            fs.readFileSync(path.join(workspace, 'made.txt'), 'utf8'),
            'the approved write actually happened',
        ).toBe('by the agent');

        await harness.dispose();
    }, 45_000);

    /**
     * The control for the test above. `write_file` must be OFFERED to the model
     * — the gate is the approval, not a hidden toolset. If the tool were simply
     * withheld, "nothing was written" would pass for entirely the wrong reason.
     */
    it('offers the mutating tool to the model rather than hiding it', async () => {
        const tools = harnessTools({ cwd: workspace });
        const harness = await createHarness({
            name: 'tooluse',
            cwd: workspace,
            sessionId: 'tool-3',
            runtime: mastraRuntime({
                model: { kind: 'remote', id: 'local/test-model', url: baseUrl },
                tools,
            }),
            autoApprove: autoApprovePolicy(tools),
        });

        await harness.send('anything');

        const offered = bodies[0] ?? '';
        expect(offered).toContain('read_file');
        expect(offered).toContain('write_file');

        await harness.dispose();
    }, 45_000);
});
