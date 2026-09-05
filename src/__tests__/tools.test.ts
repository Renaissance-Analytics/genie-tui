import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { autoApprovePolicy, harnessTools, toolNames } from '../tools.js';
import type { HarnessTool } from '../tools.js';

/**
 * The tools that make this a coding agent rather than a chat box.
 *
 * Two things are being asserted, and the second matters more than the first.
 *
 * 1. They work: reading, listing and searching a real directory on disk.
 * 2. They CANNOT leave the workspace. A coding agent is a program that runs
 *    model output against a filesystem, so path confinement is not a hardening
 *    pass to do later — it is the tool's contract, and every escape route needs
 *    a test that fails when it opens.
 *
 * The escapes covered are the three that actually get used: a `..` traversal,
 * an absolute path elsewhere, and a symlink whose TARGET is outside while its
 * path looks fine. The last is the one a naive `resolve().startsWith()` check
 * misses completely.
 */

let root = '';
let outside = '';

function tool(tools: HarnessTool[], name: string): HarnessTool {
    const found = tools.find((t) => t.name === name);
    if (!found) throw new Error(`no such tool: ${name}`);
    return found;
}

beforeEach(() => {
    // `realpathSync` because macOS resolves `/var` to `/private/var`, and a root
    // that is itself a symlink would make every containment check fail on CI
    // for a reason that has nothing to do with the code under test.
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'genie-tui-tools-')));
    root = path.join(base, 'workspace');
    outside = path.join(base, 'outside');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });

    fs.writeFileSync(path.join(root, 'hello.txt'), 'hello from the workspace\n');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const answer = 42;\n');
    fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export const other = 7;\n');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'not yours\n');
});

afterEach(() => {
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

describe('the read-only tools', () => {
    it('reads a file', async () => {
        const tools = harnessTools({ cwd: root });
        await expect(tool(tools, 'read_file').run({ path: 'hello.txt' })).resolves.toContain(
            'hello from the workspace',
        );
    });

    it('lists a directory, marking which entries are directories', async () => {
        const tools = harnessTools({ cwd: root });
        const listing = await tool(tools, 'list_dir').run({ path: '.' });

        expect(listing).toContain('hello.txt');
        expect(listing).toContain('src/');
    });

    it('searches file contents and reports where the match was', async () => {
        const tools = harnessTools({ cwd: root });
        const hits = await tool(tools, 'search_files').run({ pattern: 'answer' });

        expect(hits).toContain('a.ts');
        expect(hits).toContain('42');
        // The other file has no match and must not be reported as one.
        expect(hits).not.toContain('b.ts');
    });

    /**
     * A model that asks for a file that is not there gets a sentence it can act
     * on, not a Node `ENOENT` with a stack. The difference decides whether the
     * next turn recovers or repeats the same call.
     */
    it('explains a missing file instead of throwing a stack at the model', async () => {
        const tools = harnessTools({ cwd: root });
        const answer = await tool(tools, 'read_file').run({ path: 'nope.txt' });

        expect(answer.toLowerCase()).toContain('no such file');
        expect(answer).not.toContain('ENOENT');
    });
});

describe('nothing reaches outside the workspace', () => {
    it('refuses a `..` traversal', async () => {
        const tools = harnessTools({ cwd: root });
        const answer = await tool(tools, 'read_file').run({ path: '../outside/secret.txt' });

        expect(answer).not.toContain('not yours');
        expect(answer.toLowerCase()).toContain('outside the workspace');
    });

    it('refuses an absolute path elsewhere on the machine', async () => {
        const tools = harnessTools({ cwd: root });
        const answer = await tool(tools, 'read_file').run({
            path: path.join(outside, 'secret.txt'),
        });

        expect(answer).not.toContain('not yours');
        expect(answer.toLowerCase()).toContain('outside the workspace');
    });

    /**
     * The escape a prefix check cannot see: the path is inside the workspace,
     * every segment of it is inside the workspace, and the file it names is not.
     *
     * Skipped where symlinks need privileges (Windows without developer mode)
     * rather than asserted falsely — a test that cannot create the condition it
     * tests must say so, not pass.
     */
    it('refuses a symlink whose target is outside', async (ctx) => {
        const link = path.join(root, 'escape.txt');
        try {
            fs.symlinkSync(path.join(outside, 'secret.txt'), link, 'file');
        } catch {
            // SKIP, loudly. Returning quietly would report a security
            // assertion as passing on a machine where the condition it tests
            // could not even be created.
            ctx.skip('symlink creation is not permitted here');
            return;
        }

        const tools = harnessTools({ cwd: root });
        const answer = await tool(tools, 'read_file').run({ path: 'escape.txt' });

        expect(answer).not.toContain('not yours');
        expect(answer.toLowerCase()).toContain('outside the workspace');
    });

    it('refuses to WRITE outside the workspace', async () => {
        const tools = harnessTools({ cwd: root });
        const target = path.join(outside, 'planted.txt');

        const answer = await tool(tools, 'write_file').run({ path: target, content: 'x' });

        expect(answer.toLowerCase()).toContain('outside the workspace');
        expect(fs.existsSync(target), 'nothing was written outside').toBe(false);
    });
});

describe('reading is free; changing the workspace asks first', () => {
    /**
     * Every tool is OFFERED, always. The control is the approval gate, not a
     * hidden toolset — a model that cannot SEE `write_file` cannot ask to use
     * it, so the human never gets the choice and the agent just seems unable.
     *
     * This replaced an `--allow-write` switch that existed only because the
     * gate could not be answered at all. Once it could, the switch was a
     * second, coarser permission system sitting beside a working one.
     */
    it('offers the write tool alongside the read-only ones', () => {
        expect(toolNames(harnessTools({ cwd: root }))).toEqual([
            'read_file',
            'list_dir',
            'search_files',
            'write_file',
        ]);
    });

    /**
     * The policy is DERIVED from `mutates`, so a new mutating tool is gated the
     * moment it is added rather than when someone remembers to list it.
     */
    it('marks exactly the workspace-changing tools as needing a human', () => {
        const mayProceed = autoApprovePolicy(harnessTools({ cwd: root }));

        expect(mayProceed('read_file')).toBe(true);
        expect(mayProceed('list_dir')).toBe(true);
        expect(mayProceed('search_files')).toBe(true);
        expect(mayProceed('write_file'), 'a write must ask').toBe(false);
    });

    it('writes the file once it is allowed to run', async () => {
        const tools = harnessTools({ cwd: root });

        await tool(tools, 'write_file').run({ path: 'src/new.ts', content: 'export const x = 1;\n' });

        expect(fs.readFileSync(path.join(root, 'src', 'new.ts'), 'utf8')).toBe(
            'export const x = 1;\n',
        );
    });

    it('creates missing parent directories rather than failing on them', async () => {
        const tools = harnessTools({ cwd: root });
        await tool(tools, 'write_file').run({ path: 'deep/deeper/x.txt', content: 'ok' });

        expect(fs.readFileSync(path.join(root, 'deep', 'deeper', 'x.txt'), 'utf8')).toBe('ok');
    });
});

describe('the output a small model has to cope with', () => {
    /**
     * Local models are the target and 8k context is common, so an unbounded
     * `read_file` is not a convenience — it is a tool call that ends the
     * conversation. The cap is part of the contract, and it has to SAY it
     * truncated or the model will reason confidently about a file it only half
     * received.
     */
    it('truncates a large file and says that it did', async () => {
        fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(200_000));
        const tools = harnessTools({ cwd: root });

        const answer = await tool(tools, 'read_file').run({ path: 'big.txt' });

        expect(answer.length).toBeLessThan(100_000);
        expect(answer.toLowerCase()).toContain('truncated');
    });
});
