import { spawnSync } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

/**
 * Build before the suite runs, always.
 *
 * The artifact is a PRECONDITION of these tests, not the concern of one file:
 * `dist.test.ts` asserts the package is installable and `cli.test.ts` executes
 * the built binary, and both have to be looking at output produced from the
 * source in the working tree. Testing a `dist/` somebody left behind is how a
 * suite goes green against code that no longer exists — a slower-acting version
 * of the failure this package already shipped, which was 72 green tests and no
 * artifact at all.
 *
 * There is deliberately no skip flag. An opt-out here would be used, and then
 * "npm test passed" would stop meaning "a working binary comes out of this".
 */
export default function setup(): void {
    const root = path.dirname(url.fileURLToPath(import.meta.url));
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

    const built = spawnSync(npm, ['run', 'build'], {
        cwd: root,
        encoding: 'utf8',
        shell: process.platform === 'win32',
    });

    if (built.status !== 0) {
        throw new Error(`build failed before the suite:\n${built.stdout ?? ''}\n${built.stderr ?? ''}`);
    }
}
