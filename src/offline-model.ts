/**
 * A minimal AI SDK v2 language model that answers with a fixed string.
 *
 * ## Why this is hand-written rather than imported
 *
 * Mastra exports `createMockModel` from `@mastra/core/test-utils/llm-mock`, but
 * the PUBLISHED file carries a bare `import "vitest"` on line 13, and `vitest`
 * is not a dependency of `@mastra/core`. Outside a vitest worker that import
 * throws "Vitest failed to access its internal state", so the export is
 * unusable in a CLI — which is the only place a no-credentials fallback is
 * actually needed. Recorded in GAPS.md.
 *
 * Writing it here also keeps a test-only dependency off the shipping path.
 */

interface StreamPart {
    type: string;
    [key: string]: unknown;
}

export function offlineModel(text: string) {
    const id = 'offline-1';

    const parts = (): StreamPart[] => [
        { type: 'stream-start', warnings: [] },
        {
            type: 'response-metadata',
            id,
            modelId: 'genie-tui-offline',
            timestamp: new Date(0),
        },
        { type: 'text-start', id },
        { type: 'text-delta', id, delta: text },
        { type: 'text-end', id },
        {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
    ];

    return {
        specificationVersion: 'v2' as const,
        provider: 'genie-tui',
        modelId: 'genie-tui-offline',
        supportedUrls: {},

        async doGenerate() {
            return {
                content: [{ type: 'text' as const, text }],
                finishReason: 'stop' as const,
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                warnings: [] as never[],
            };
        },

        async doStream() {
            return {
                stream: new ReadableStream<StreamPart>({
                    start(controller) {
                        for (const part of parts()) controller.enqueue(part);
                        controller.close();
                    },
                }),
            };
        },
    };
}
