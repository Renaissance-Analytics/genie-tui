import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * INSTALLING FROM GIT IS A DIFFERENT PATH FROM INSTALLING A TARBALL.
 *
 * `npm install github:owner/repo` clones the repository and runs **`prepare`**.
 * It does not run `build`, and `dist/` is gitignored, so without a `prepare`
 * script the installed package is LICENSE + package.json + README and nothing
 * else -- with `bin` pointing at a `dist/cli.js` that was never produced.
 *
 * That was measured, not assumed: installing from the public repo before this
 * script existed produced exactly those three files. It is the same shape as the
 * three packaging faults this project already fixed -- a bin pointing at a file
 * nothing builds -- arriving one install-method later.
 *
 * `files: ["dist"]` covers the tarball path; `prepare` covers the git path. Both
 * are needed, and neither substitutes for the other.
 */
describe('installable from git', () => {
    const pkg = JSON.parse(
        readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string>; bin?: Record<string, string>; files?: string[] };

    it('runs the build on prepare, which is the hook a git install calls', () => {
        expect(pkg.scripts?.prepare).toBeDefined();
        expect(pkg.scripts?.prepare).toContain('build');
    });

    it('still ships dist in the tarball, which is the other install path', () => {
        expect(pkg.files).toContain('dist');
    });

    it('binds the binary the Genie provider actually launches', () => {
        // The provider's defaultCommand is `genie`. A bin named anything else
        // installs successfully and then cannot be launched -- the original bug.
        expect(Object.keys(pkg.bin ?? {})).toEqual(['genie']);
    });
});
