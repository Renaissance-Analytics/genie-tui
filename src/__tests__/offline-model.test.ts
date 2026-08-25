import { describe, expect, it } from 'vitest';
import { Agent } from '@mastra/core/agent';

import { createHarness } from '../harness.js';
import { mastraRuntime } from '../runtime/mastra.js';
import { offlineModel } from '../offline-model.js';

/**
 * A model the CLI can actually run without credentials.
 *
 * Mastra ships `createMockModel` at `@mastra/core/test-utils/llm-mock`, but the
 * published file has a bare `import "vitest"` on line 13 — and `vitest` is not a
 * dependency of `@mastra/core`. So that export throws "Vitest failed to access
 * its internal state" in any normal process, which makes it unusable in a CLI.
 * See GAPS.md.
 *
 * This is a ~40-line AI SDK v2 language model instead. It also keeps a test-only
 * dependency out of the shipping path, which is where it belonged anyway.
 */

describe('the offline model', () => {
    it('declares itself as an AI SDK v2 model', () => {
        const m = offlineModel('hi');
        expect(m.specificationVersion).toBe('v2');
        expect(m.modelId).toBe('genie-tui-offline');
    });

    it('drives a real Mastra turn end to end, with no API key', async () => {
        const harness = await createHarness({
            name: 'skeleton',
            cwd: process.cwd(),
            sessionId: 'offline-1',
            runtime: mastraRuntime({
                agent: new Agent({
                    id: 'offline',
                    name: 'Offline',
                    instructions: 'skeleton',
                    model: offlineModel('No API key set.') as never,
                }),
            }),
        });

        await harness.send('anything');

        expect(harness.state().turn.state).toBe('idle');
        expect(harness.state().transcript.some((m) => m.content.includes('No API key set.'))).toBe(
            true,
        );

        await harness.dispose();
    }, 30_000);
});
