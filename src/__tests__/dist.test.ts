import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

/**
 * The test that was missing, and whose absence is the whole reason this
 * repository shipped nothing for ten releases.
 *
 * The owner reported "the TUI isn't installing" repeatedly. Every investigation
 * looked at the INSTALL PATH. Nobody checked whether there was an artifact to
 * install: `bin` pointed at `./dist/cli.js`, no script produced `dist/`, and no
 * test ever asked. A green suite of 72 unit tests proved the source worked and
 * said nothing at all about whether anything shippable came out of it.
 *
 * So these assertions are deliberately about the ARTIFACT, not the source:
 *
 *  1. a build exists and produces the file `bin` names;
 *  2. the bin is called `genie`, which is what Genie's launcher runs;
 *  3. `npm pack` actually CONTAINS that file — a separate failure mode, because
 *     `dist/` is gitignored and npm falls back to `.gitignore` when there is no
 *     `.npmignore`, so a perfectly good build can still be packed away to
 *     nothing;
 *  4. the built file RUNS, as a real spawned process, and answers.
 *
 * Every one of those can fail independently while `npm test` is green, which is
 * exactly what happened.
 */

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

/** npm is a `.cmd` shim on Windows, which `spawn` cannot exec without a shell. */
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmOpts = { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' } as const;

interface PackageJson {
    bin?: Record<string, string>;
    files?: string[];
    scripts?: Record<string, string>;
}

function readPackageJson(): PackageJson {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as PackageJson;
}

/**
 * The one entry in `bin`.
 *
 * A CLI with two names is a CLI whose name is ambiguous at the call site, and
 * the call site here is Genie's `TUI_REGISTRY.genie.defaultCommand`. Asserting
 * "exactly one" is what makes the name assertion below meaningful.
 */
function soleBin(pkg: PackageJson): { name: string; target: string } {
    const entries = Object.entries(pkg.bin ?? {});
    expect(entries).toHaveLength(1);
    const [name, target] = entries[0] as [string, string];
    return { name, target };
}

describe('the package produces an installable binary', () => {
    // The build itself runs in `vitest.global-setup.ts`, once for the whole
    // suite, and fails it loudly if the build fails. Everything below asserts on
    // what that build produced.

    it('declares a build script', () => {
        expect(readPackageJson().scripts?.['build']).toBeTruthy();
    });

    /**
     * Genie launches this provider by running `genie` —
     * `main/agents/registry.ts`, `TUI_REGISTRY.genie.defaultCommand`. The bin
     * used to be `genie-tui`, which is the exact name Genie already had to fix
     * on its own side after it produced `bash: genie-tui: command not found`.
     * Installing this package as it stood would have put the wrong name back on
     * PATH and reproduced that bug one layer later.
     */
    it('names its binary `genie`, the command Genie launches', () => {
        expect(soleBin(readPackageJson()).name).toBe('genie');
    });

    it('builds the file `bin` points at', () => {
        const { target } = soleBin(readPackageJson());
        const built = path.join(root, target);
        expect(fs.existsSync(built), `${target} was not produced by the build`).toBe(true);
    });

    /**
     * A `#!` line is what makes the file executable once npm links it onto
     * PATH. TypeScript preserves a leading shebang, but "the compiler probably
     * keeps it" is precisely the assumption this file exists to stop making.
     */
    it('keeps the shebang on the built entry point', () => {
        const { target } = soleBin(readPackageJson());
        const source = fs.readFileSync(path.join(root, target), 'utf8');
        expect(source.startsWith('#!/usr/bin/env node')).toBe(true);
    });

    /**
     * The second, independent reason an install could fail.
     *
     * `dist/` is in `.gitignore`, and npm uses `.gitignore` as the pack
     * ignore-list when there is no `.npmignore` and no `files` array. So a
     * correct build can still produce a tarball with no `dist/` in it — an
     * install that succeeds, links `genie` onto PATH, and then cannot find its
     * own entry point. Only `npm pack` can see this; no unit test can.
     */
    it('includes the built entry point in the published tarball', () => {
        const { target } = soleBin(readPackageJson());
        const packed = spawnSync(npm, ['pack', '--dry-run', '--json'], npmOpts);
        expect(packed.status, packed.stderr).toBe(0);

        const manifest = JSON.parse(packed.stdout) as { files: { path: string }[] }[];
        const files = (manifest[0]?.files ?? []).map((f) => f.path.replace(/\\/g, '/'));
        const wanted = target.replace(/^\.\//, '');

        expect(files, `npm pack shipped ${files.length} files, none of them ${wanted}`).toContain(
            wanted,
        );
        // `npm pack` spawns npm, which on Windows means a `.cmd` shim through a
        // shell and several seconds of work — well past vitest's 5s default,
        // and more when seventeen other files are running beside it.
    }, 120_000);

    /**
     * The assertion the whole file is for: the built artifact is EXECUTED, in a
     * separate process, and observed to answer. `--print` mounts the harness,
     * registers the Human+ surfaces and reads them back without needing a TTY.
     *
     * `GENIE_MCP_URL` is stripped deliberately — this must not POST to whatever
     * live Genie happens to be running on the machine testing it.
     */
    it('runs, as a built file, and reports its surfaces', () => {
        const { target } = soleBin(readPackageJson());
        const env = { ...process.env };
        delete env['GENIE_MCP_URL'];
        delete env['GENIE_TERMINAL_ID'];

        const run = spawnSync(process.execPath, [path.join(root, target), '--print', '--name', 'dist-smoke'], {
            cwd: root,
            encoding: 'utf8',
            env,
            timeout: 120_000,
        });

        expect(run.status, `built cli exited ${run.status}\n${run.stderr}`).toBe(0);

        const out = JSON.parse(run.stdout) as {
            surfaces: string[];
            session: { ref: string; provider: string };
            bridge: boolean;
        };
        expect(out.surfaces).toEqual(['composer', 'turn', 'session']);
        expect(out.session.provider).toBe('genie');
        expect(out.session.ref).toContain('genie:dist-smoke:');
        // No GENIE_MCP_URL in the environment, so the bridge must report itself
        // as off rather than quietly pretending it is wired.
        expect(out.bridge).toBe(false);
    }, 150_000);
});
