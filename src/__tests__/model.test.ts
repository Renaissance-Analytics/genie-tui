import { describe, expect, it } from 'vitest';

import { resolveModel } from '../model.js';

/**
 * Which model the TUI talks to, decided as a pure function.
 *
 * The product constraint is LOCAL MODELS FIRST, cloud as the fallback, and that
 * has to be visible in the resolution order rather than asserted in a README: a
 * local endpoint wins whenever one is configured, and it never needs a key.
 *
 * Keeping this out of `cli.tsx` is what makes it assertable at all. It used to
 * be four lines inside the entry point, reachable only by launching the process
 * with a doctored environment.
 */

describe('a local endpoint wins, and needs no key', () => {
    it('uses the object form when a base URL is configured', () => {
        const spec = resolveModel({
            model: 'qwen3-coder',
            modelUrl: 'http://127.0.0.1:11434/v1',
            env: {},
        });

        expect(spec).toEqual({
            kind: 'remote',
            id: 'local/qwen3-coder',
            url: 'http://127.0.0.1:11434/v1',
        });
    });

    /**
     * `local/` rather than `lmstudio/` or `ollama/`, and it is load-bearing.
     *
     * Mastra strips `temperature`, `topP` and `topK` for any model absent from
     * its hardcoded per-provider list — and absent means UNLISTED, not
     * unsupported. So a provider id its registry recognises silently loses the
     * user's sampling config, which surfaces as "why is my local model
     * incoherent". An id it does not know keeps them. Same reason
     * `local-endpoint.test.ts` pins `local/test-model`.
     */
    it('prefixes a bare model name so sampling settings survive', () => {
        const spec = resolveModel({ model: 'mistral-7b', modelUrl: 'http://x/v1', env: {} });
        expect(spec).toMatchObject({ id: 'local/mistral-7b' });
    });

    it('leaves an explicitly namespaced id alone', () => {
        const spec = resolveModel({ model: 'ollama/llama3.3', modelUrl: 'http://x/v1', env: {} });
        expect(spec).toMatchObject({ id: 'ollama/llama3.3' });
    });

    it('beats a cloud key that is also present', () => {
        const spec = resolveModel({
            model: 'qwen3-coder',
            modelUrl: 'http://x/v1',
            env: { ANTHROPIC_API_KEY: 'sk-real' },
        });
        expect(spec).toMatchObject({ kind: 'remote', url: 'http://x/v1' });
    });

    /**
     * A URL with no model would reach Ollama or LM Studio as a request naming
     * no model and come back a 404 — a confusing failure a long way from its
     * cause. Refusing up front, naming the flag, is the honest answer.
     */
    it('refuses a base URL with no model rather than 404ing later', () => {
        const spec = resolveModel({ modelUrl: 'http://x/v1', env: {} });
        expect(spec.kind).toBe('invalid');
        expect(spec.kind === 'invalid' && spec.reason).toContain('--model');
    });
});

describe('cloud is the fallback, not the default', () => {
    it('uses a cloud id when a key is present and no local endpoint is set', () => {
        const spec = resolveModel({ model: 'anthropic/claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk' } });
        expect(spec).toEqual({ kind: 'remote', id: 'anthropic/claude-sonnet-4-6' });
    });

    it('reads the model from the environment when no flag is given', () => {
        const spec = resolveModel({ env: { OPENAI_API_KEY: 'sk', GENIE_TUI_MODEL: 'openai/gpt-4.1' } });
        expect(spec).toMatchObject({ id: 'openai/gpt-4.1' });
    });

    it('reads the base URL from the environment too', () => {
        const spec = resolveModel({
            env: { GENIE_TUI_MODEL_URL: 'http://127.0.0.1:8080/v1', GENIE_TUI_MODEL: 'qwen' },
        });
        expect(spec).toMatchObject({ kind: 'remote', url: 'http://127.0.0.1:8080/v1' });
    });
});

describe('with nothing configured it says so instead of pretending', () => {
    /**
     * A walking skeleton that silently posed as a working coding agent would be
     * worse than one that cannot answer — so the offline model announces itself
     * in its own reply.
     */
    it('falls back to the offline model when there is no key and no endpoint', () => {
        const spec = resolveModel({ env: {} });
        expect(spec.kind).toBe('offline');
    });

    /**
     * The offline notice has to name the LOCAL route first. It used to mention
     * only `ANTHROPIC_API_KEY`, which told a local-first product's user that
     * their next step was to buy a cloud key.
     */
    it('points at a local endpoint before it points at a cloud key', () => {
        const spec = resolveModel({ env: {} });
        if (spec.kind !== 'offline') throw new Error('expected the offline spec');

        expect(spec.notice).toContain('--model-url');
        expect(spec.notice.indexOf('--model-url')).toBeLessThan(
            spec.notice.indexOf('ANTHROPIC_API_KEY'),
        );
    });
});
