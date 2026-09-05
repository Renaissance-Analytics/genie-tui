import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createHarness } from '../harness.js';
import { mastraRuntime } from '../runtime/mastra.js';
import type { ModelSpec } from '../model.js';

/**
 * The LOCAL-MODEL path, proved end to end against a real HTTP server.
 *
 * The product constraint is local models first, cloud as the fallback. That is
 * only true if a locally hosted, OpenAI-compatible endpoint — Ollama,
 * llama.cpp, LM Studio, vLLM — actually drives a turn. Asserting it against a
 * mocked provider would prove nothing: the whole question is whether the request
 * leaves the process, reaches an arbitrary base URL, and comes back as a turn.
 *
 * So this stands up a real OpenAI-compatible server on an ephemeral port and
 * points Mastra at it with the object form, which is the ONLY form that carries
 * a URL:
 *
 *     model: { id: 'local/test-model', url: 'http://127.0.0.1:<port>/v1' }
 *
 * No model download, no API key, no network egress — so it runs identically on
 * every OS in CI, which is where this proof belongs.
 *
 * Note the provider id is deliberately `local/`, NOT `lmstudio/`. Mastra strips
 * `temperature`/`topP`/`topK` for any model absent from its hardcoded registry
 * list, and "absent" means unlisted rather than unsupported — so an id its
 * registry does not know is the one that keeps sampling settings intact.
 */

let server: http.Server;
let baseUrl = '';
let seenPaths: string[] = [];
let seenAuth: (string | undefined)[] = [];

/** A minimal OpenAI-compatible `/v1/chat/completions`, answering in one chunk. */
function openAiCompatibleServer(reply: string): http.Server {
    return http.createServer((req, res) => {
        seenPaths.push(req.url ?? '');
        seenAuth.push(req.headers.authorization);

        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            const streaming = body.includes('"stream":true');
            if (!streaming) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        id: 'chatcmpl-1',
                        object: 'chat.completion',
                        created: 0,
                        model: 'test-model',
                        choices: [
                            {
                                index: 0,
                                message: { role: 'assistant', content: reply },
                                finish_reason: 'stop',
                            },
                        ],
                        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                    }),
                );
                return;
            }

            res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
            });
            const chunk = (delta: Record<string, unknown>, finish: string | null) =>
                `data: ${JSON.stringify({
                    id: 'chatcmpl-1',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'test-model',
                    choices: [{ index: 0, delta, finish_reason: finish }],
                })}\n\n`;
            res.write(chunk({ role: 'assistant' }, null));
            res.write(chunk({ content: reply }, null));
            res.write(chunk({}, 'stop'));
            res.write('data: [DONE]\n\n');
            res.end();
        });
    });
}

beforeEach(async () => {
    seenPaths = [];
    seenAuth = [];
    server = openAiCompatibleServer('Answered by the local endpoint.');
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
});

/**
 * The PRODUCTION path, not a hand-built agent.
 *
 * This used to construct the `Agent` here with the object form inline, which
 * proved Mastra could reach a URL but said nothing about whether the TUI's own
 * resolution ever produces one. Going through `ModelSpec` -> `mastraRuntime`
 * means a regression anywhere between `--model-url` and the wire fails here.
 */
function localModel(url: string): ModelSpec {
    // `local/`, not `lmstudio/`: an id Mastra's registry does not recognise is
    // the one that keeps `temperature`/`topP`/`topK` from being silently
    // stripped. See `model.ts`.
    return { kind: 'remote', id: 'local/test-model', url };
}

describe('a locally hosted OpenAI-compatible model', () => {
    it('drives a real turn, with no API key and no cloud call', async () => {
        const harness = await createHarness({
            name: 'local',
            cwd: process.cwd(),
            runtime: mastraRuntime({ model: localModel(baseUrl) }),
            sessionId: 'local-1',
        });

        await harness.send('are you local?');

        const state = harness.state();
        expect(state.turn.state).toBe('idle');
        expect(
            state.transcript.some((m) => m.content.includes('Answered by the local endpoint')),
            'the local endpoint’s answer reached the transcript',
        ).toBe(true);

        // It really went to OUR server, at the base URL we chose.
        expect(seenPaths.some((p) => p.includes('/chat/completions'))).toBe(true);

        await harness.dispose();
    }, 30_000);

    /**
     * A keyless local server must not be sent a credential, and must not be
     * refused for lacking one. Mastra's `url` branch defaults `apiKey` to `''`,
     * which is the behaviour this pins.
     */
    it('sends no bearer credential to a keyless server', async () => {
        const harness = await createHarness({
            name: 'local',
            cwd: process.cwd(),
            runtime: mastraRuntime({ model: localModel(baseUrl) }),
            sessionId: 'local-2',
        });
        await harness.send('hi');

        for (const auth of seenAuth) {
            expect(auth ?? '', 'no real bearer token').not.toMatch(/Bearer\s+\S+/);
        }

        await harness.dispose();
    }, 30_000);

    /**
     * The positive control's negative twin — and the reason the tests above are
     * not vacuous. If the harness were quietly answering from somewhere other
     * than the URL we gave it, pointing at a dead port would still "work". It
     * must not: an unreachable local endpoint has to surface as a failed turn.
     */
    it('fails the turn when the local endpoint is unreachable', async () => {
        const harness = await createHarness({
            name: 'local',
            cwd: process.cwd(),
            // Port 1 is reserved and never listening.
            runtime: mastraRuntime({ model: localModel('http://127.0.0.1:1/v1') }),
            sessionId: 'local-3',
        });

        await harness.send('are you there?');

        const state = harness.state();
        const answered = state.transcript.some((m) =>
            m.content.includes('Answered by the local endpoint'),
        );
        expect(answered, 'must NOT have answered from anywhere else').toBe(false);
        expect(state.error, 'the failure is reported, not swallowed').toBeTruthy();

        await harness.dispose();
    }, 30_000);
});
