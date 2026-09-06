import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * WHAT A CONSUMER ACTUALLY RECEIVES.
 *
 * This package is installed by Genie as an agent CLI, and it is installed from a
 * PACKED TARBALL rather than from git. That is not a preference: npm cannot
 * install a git spec globally when the package has a `prepare` that needs its own
 * dependencies. npm prepares a git dep by cloning it and shelling out to a nested
 * `npm install` inside the clone, and that nested process inherits
 * `npm_config_global` and `npm_config_prefix` from the outer `-g` — so the
 * clone's dependencies land in the global prefix, the clone gets no
 * `node_modules/.bin`, and `prepare` runs a `tsc` that is not there. (genie#469
 * has the full trace.)
 *
 * A tarball has no such problem, because npm never runs `prepare` on one — the
 * build has already happened. Which makes the tarball's CONTENTS the whole
 * contract: if `dist/` is missing from it, the install "succeeds" and leaves a
 * `bin` pointing at nothing. That is the failure this file exists to prevent,
 * and it is the exact shape of the bug that made the Genie TUI uninstallable for
 * ten releases — a button that always failed.
 */

const ROOT = path.resolve(__dirname, '..', '..');

interface PackEntry {
    path: string;
}
interface PackResult {
    files: PackEntry[];
    name: string;
}

/**
 * What `npm pack` WOULD ship, measured WITHOUT running lifecycle scripts.
 *
 * `--ignore-scripts` is load-bearing, not tidiness. A plain `npm pack` runs
 * `prepare` → `prebuild`, and `prebuild` DELETES `dist/`. Vitest runs files in
 * parallel, and `cli.test.ts` spawns the built `dist/cli.js` — so packing
 * normally here pulls the binary out from under a sibling suite mid-run. It did
 * exactly that: four green tests in `cli.test.ts` went red, for a reason that had
 * nothing to do with them.
 *
 * Skipping the build costs nothing, because both sides of the comparison read the
 * same `dist/`: this asks whether `files` SHIPS what was built, not whether the
 * build is current. `npm ci` runs `prepare`, so `dist/` is there in CI and for
 * anyone who installed.
 */
function packedFiles(): string[] {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: ROOT,
        encoding: 'utf8',
        shell: process.platform === 'win32',
    });
    const parsed = JSON.parse(out) as PackResult[];
    const first = parsed[0];
    if (!first) throw new Error('npm pack --json returned no package');
    // npm emits POSIX paths in --json on every platform, so no normalisation.
    return first.files.map((f) => f.path);
}

/** Every compiled `.js` under `dist/`, POSIX-relative to the package root. */
function builtModules(): string[] {
    const out: string[] = [];
    const walk = (dir: string, prefix: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
            else if (entry.name.endsWith('.js')) out.push(`dist/${rel}`);
        }
    };
    const dist = path.join(ROOT, 'dist');
    if (!existsSync(dist)) {
        throw new Error(
            `no dist/ to compare against at ${dist} — run \`npm run build\` (or \`npm ci\`, ` +
                'which runs it via prepare) before this suite',
        );
    }
    walk(dist, '');
    return out.sort();
}

describe('the packed tarball is installable without a build', () => {
    const files = packedFiles();

    /**
     * THE ASSERTION THAT MATTERS, and the one an obvious version of this test
     * gets wrong.
     *
     * Checking that the tarball contains the `bin` target proves nothing: npm
     * FORCE-INCLUDES `package.json`, the README, the LICENSE and whatever `bin`
     * and `main` point at, whatever `files` says. Setting `files` to
     * `["README.md"]` still ships `dist/cli.js` — and none of the modules it
     * imports. The install succeeds, the binary exists, and it dies on its first
     * import. Measured, not reasoned: that exact probe left a four-entry tarball
     * and a green test, which is why this asserts the WHOLE compiled program.
     */
    it('ships every compiled module, not just the entry point npm force-includes', () => {
        const built = builtModules();

        // POSITIVE CONTROL: there is a real, multi-module build to compare
        // against. Against an empty `dist/` the subset check below is vacuously
        // true, and against a single-file one it cannot tell force-inclusion
        // from a correct `files`.
        expect(built.length).toBeGreaterThan(1);
        expect(built).toContain('dist/cli.js');

        expect(files).toEqual(expect.arrayContaining(built));
    });

    it('ships compiled JavaScript, never TypeScript source', () => {
        // A consumer's npm runs no build, so a `.ts` in the tarball is a file
        // nothing will ever compile.
        expect(files.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))).toEqual([]);
    });

    it('ships no tests', () => {
        expect(files.filter((f) => f.includes('__tests__'))).toEqual([]);
    });
});
