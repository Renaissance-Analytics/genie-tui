import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.tsx'],
        // Build before anything runs. `dist.test.ts` and `cli.test.ts` assert on
        // the ARTIFACT, and an artifact left over from an earlier source tree
        // would let them pass against code that no longer exists.
        globalSetup: ['./vitest.global-setup.ts'],
    },
});
