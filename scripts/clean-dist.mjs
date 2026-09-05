import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

/**
 * Delete `dist/` before a build.
 *
 * Not housekeeping. `tsc` writes files, it does not remove ones whose source
 * has gone, so an incremental build happily leaves a deleted module sitting in
 * `dist/` where an import can still resolve it. The bug that follows is a build
 * that passes and a package that ships code no longer in the repository —
 * exactly the class of "the artifact is not what you think it is" problem this
 * package already shipped once by having no artifact at all.
 */
const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
