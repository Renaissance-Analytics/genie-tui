import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

/**
 * The BUILT binary, executed.
 *
 * `dist.test.ts` proves a shippable artifact exists. This proves it WORKS: it
 * boots, it paints, it accepts typing, it runs a turn end to end, and it exits.
 *
 * That distinction is the whole lesson of this repository. A build that exits 0
 * and has never been run is the same assumption — "the artifact must be fine" —
 * that let a `bin` point at a file no script produced, through ten releases and
 * repeated reports that the TUI would not install.
 *
 * Everything here runs `dist/`, never `src/`. A test that imports the source is
 * testing the source.
 */

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const cli = path.join(root, 'dist', 'cli.js');
const shim = path.join(here, 'fixtures', 'tty-shim.mjs');

/**
 * A clean environment.
 *
 * `GENIE_MCP_URL` is removed because a test must never POST to whatever live
 * Genie happens to be running on the machine, and the API keys because their
 * presence would silently swap the offline model for a real, billable, network
 * call — a test that passes differently depending on whose shell it runs in.
 */
function cleanEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of [
        'GENIE_MCP_URL',
        'GENIE_TERMINAL_ID',
        'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY',
        'GOOGLE_GENERATIVE_AI_API_KEY',
    ]) {
        delete env[key];
    }
    return env;
}

/** ANSI out, whitespace collapsed — so a wrapped line still matches. */
const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]/g;
function plain(text: string): string {
    return text.replace(ANSI, '').replace(/\s+/g, ' ').trim();
}

interface Running {
    child: ChildProcessWithoutNullStreams;
    output: () => string;
    /** Resolve once the accumulated frames contain `needle`, else reject. */
    waitFor: (needle: string, ms?: number) => Promise<void>;
    exit: () => Promise<number | null>;
}

function start(args: string[]): Running {
    const child = spawn(process.execPath, [shim, ...args], {
        cwd: root,
        env: cleanEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
    });

    return {
        child,
        output: () => buffer,
        /**
         * Generous on purpose. Each of these spawns a real node process that
         * boots React, Ink and a Mastra `AgentController`, and the suite runs it
         * alongside seventeen other files doing their own work. A tight bound
         * here measures the runner's load, not the binary — it failed once in a
         * full run for exactly that reason while passing alone.
         */
        async waitFor(needle: string, ms = 45_000): Promise<void> {
            const deadline = Date.now() + ms;
            while (Date.now() < deadline) {
                if (plain(buffer).includes(needle)) return;
                if (child.exitCode !== null) break;
                await new Promise((r) => setTimeout(r, 50));
            }
            throw new Error(
                `never saw ${JSON.stringify(needle)} (exit ${child.exitCode}).\n--- output ---\n${plain(buffer)}`,
            );
        },
        exit(): Promise<number | null> {
            if (child.exitCode !== null) return Promise.resolve(child.exitCode);
            return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
        },
    };
}

describe('the built binary answers the questions a person asks first', () => {
    /**
     * "Is it installed, and which one is it?" `--version` is the first thing
     * anyone types, and this package's entire history is somebody being unable
     * to answer that question about it.
     */
    it('reports its version', () => {
        const run = spawnSync(process.execPath, [cli, '--version'], {
            encoding: 'utf8',
            env: cleanEnv(),
        });
        expect(run.status, run.stderr).toBe(0);
        expect(run.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('prints usage that names the binary Genie launches', () => {
        const run = spawnSync(process.execPath, [cli, '--help'], {
            encoding: 'utf8',
            env: cleanEnv(),
        });
        expect(run.status, run.stderr).toBe(0);
        // `genie`, not `genie-tui` — the name mismatch that made the provider
        // unusable is a documentation bug as much as a packaging one.
        expect(run.stdout).toContain('genie ');
        expect(run.stdout).not.toContain('genie-tui ');
        expect(run.stdout).toContain('--print');
    });

    /**
     * Without a TTY, Ink throws from inside a React effect and the user gets
     * twenty lines of react-reconciler stack. That is indistinguishable from a
     * broken install, which is precisely the wrong impression for this binary
     * to give. Requiring a terminal is correct; saying so in one line is the
     * fix, not swallowing the condition.
     */
    it('explains itself when there is no terminal instead of dumping a React stack', async () => {
        const run = spawnSync(process.execPath, [cli, '--name', 'notty'], {
            encoding: 'utf8',
            env: cleanEnv(),
            input: '',
            timeout: 60_000,
        });

        expect(run.status).not.toBe(0);
        const said = `${run.stdout}${run.stderr}`;
        expect(said).toContain('terminal');
        expect(said).toContain('--print');
        expect(said).not.toContain('react-reconciler');
        expect(said).not.toContain('Raw mode is not supported');
    }, 90_000);
});

describe('the built binary runs as a terminal application', () => {
    /**
     * The end-to-end proof, and the one the brief asks for by name: the built
     * file boots, paints a frame, takes typed input, runs a complete turn
     * through the runtime, commits the answer to the transcript, and exits on
     * Ctrl-C.
     *
     * It runs offline — no key, no network — so it proves the plumbing rather
     * than a model, and it proves it identically on every CI runner.
     */
    it('paints, accepts typing, completes a turn and exits', async () => {
        const run = start(['--name', 'e2e']);

        // 1. It painted. The header carries the agent name.
        await run.waitFor('e2e');

        // 1b. It is FOCUSED. This is a real readiness signal, not a pause.
        //
        // The first frame is painted before the composer takes focus, and
        // `MultilineInput` drops every keypress while unfocused
        // (`if (!isFocused) return`). Typing into that window loses the
        // keystrokes silently — which is exactly how this test failed
        // intermittently, on a frame showing an empty but now-focused composer.
        //
        // The `▌` cursor is only rendered once focus lands, so waiting for it
        // waits for the actual precondition instead of guessing at a delay.
        await run.waitFor('▌');

        // 2. It is listening. Typed characters reach the controlled composer
        //    and come back out in the next frame — the composer state Genie is
        //    told about is the same state on screen, which is the entire claim.
        run.child.stdin.write('summarise this repo');
        await run.waitFor('summarise this repo');

        // 3. Enter submits, and the message commits to the transcript.
        run.child.stdin.write('\r');

        // 4. A real turn ran: the offline model's answer came back through the
        //    runtime, the adapter, the reducer, and into the view. Its arrival
        //    in the transcript is also the proof the turn ENDED, because the
        //    reducer commits a message only on `done` or a declared `turn-end`.
        //
        //    There is deliberately no assertion here that the status bar reads
        //    `idle`. Frames accumulate, `idle` is on the bar from the very first
        //    one, and a check that was already true before the turn started
        //    would pass against a harness that never ran anything. The turn
        //    STATE MACHINE is asserted where it can be asserted precisely —
        //    `reduce.test.ts` and `runtime-boundary.test.ts`, against an
        //    injected clock.
        await run.waitFor('offline skeleton');

        // 5. Ctrl-C exits cleanly.
        run.child.stdin.write('\x03');
        expect(await run.exit()).toBe(0);
    }, 120_000);
});
