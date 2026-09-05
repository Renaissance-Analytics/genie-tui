import { describe, expect, it } from 'vitest';

import { agentFor } from '../runtime/mastra.js';
import { harnessTools } from '../tools.js';

/**
 * The tools reach the agent.
 *
 * `tools.test.ts` proves the tools DO the right thing when called; this proves
 * the runtime is actually given them. Both halves are needed, and the second is
 * the one that rots silently — a translation layer that quietly produces an
 * empty object leaves every tool test green and every turn tool-less, which
 * looks exactly like a model that "chose not to" use them.
 *
 * `agent.listTools()` is Mastra's own accessor, so this asks the vendor what it
 * received rather than asserting on what we passed.
 */

describe('the harness tools are wired into the runtime', () => {
    /**
     * Every tool reaches the model, including the mutating one. Hiding
     * `write_file` would be a permission model the human never participates in:
     * a model that cannot see the tool cannot ask, so the agent simply appears
     * unable rather than asking to be allowed. The gate is the approval, and it
     * lives in the harness.
     */
    it('gives the agent every tool, mutating ones included', async () => {
        const agent = agentFor(
            { kind: 'offline', notice: 'offline' },
            'instructions',
            harnessTools({ cwd: process.cwd() }),
        );

        expect(Object.keys(await agent.listTools()).sort()).toEqual([
            'list_dir',
            'read_file',
            'search_files',
            'write_file',
        ]);
    });

    /**
     * The control for the assertion above.
     *
     * A translation layer that silently produced an empty object would fail the
     * test above — but only because it lists names. Pinning the empty case as
     * well is what shows the check distinguishes "these tools" from "whatever
     * happened to be there", and it caught a real bug: `agentFor`'s OFFLINE
     * branch was built without tools at all, so the agent's capabilities
     * changed with its model.
     */
    it('has no tools when it is given none', async () => {
        const agent = agentFor({ kind: 'offline', notice: 'offline' }, 'instructions');
        expect(Object.keys(await agent.listTools())).toHaveLength(0);
    });

    /**
     * The description text is what a model reads to decide whether to call a
     * tool, so an empty or missing one is a tool that never gets used. Cheap to
     * assert, and invisible until someone wonders why the agent never reads a
     * file.
     */
    it('passes a usable description through to each tool', async () => {
        const agent = agentFor(
            { kind: 'offline', notice: 'offline' },
            'instructions',
            harnessTools({ cwd: process.cwd() }),
        );

        for (const [name, tool] of Object.entries(await agent.listTools())) {
            const description = (tool as { description?: string }).description ?? '';
            expect(description.length, `${name} has no description`).toBeGreaterThan(20);
        }
    });
});
