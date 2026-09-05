/**
 * Run the BUILT `dist/cli.js` down its real interactive path, in a real
 * process, without needing a pty.
 *
 * ## Why a shim rather than a pty
 *
 * Ink refuses to mount `useInput` unless `stdin.isTTY` is set, and the
 * composer — the single most important thing to prove works — is nothing but
 * input handling. So `node dist/cli.js < /dev/null` cannot exercise it, and a
 * real pty means a native module (`node-pty`) with a compiler on every CI
 * runner, for a suite whose whole selling point is that it needs no toolchain.
 *
 * Faking `isTTY` and `setRawMode` on the process's own stdin is enough: Ink
 * asks for exactly those two things, and everything downstream of them — the
 * keypress decoding, the controlled composer state, the reducer, the repaint —
 * is the real code path running against the real built file. The gap is
 * genuine and worth naming: this does not prove terminal MODE handling (kitty
 * keyboard protocol, bracketed paste), only that the app runs and responds.
 *
 * Kept as a fixture rather than a src module because it is a test rig, and
 * `files: ["dist"]` keeps it out of the published package regardless.
 */
import path from 'node:path';
import url from 'node:url';

process.stdin.isTTY = true;
process.stdin.setRawMode = () => process.stdin;

// Ink buffers output and paints only on unmount when stdout is not a TTY (it
// treats that as CI). Live frames are the point here, so say it is one, at a
// fixed width so wrapped assertions are reproducible across machines.
process.stdout.isTTY = true;
process.stdout.columns = 100;
process.stdout.rows = 30;

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..', '..');
await import(url.pathToFileURL(path.join(root, 'dist', 'cli.js')).href);
