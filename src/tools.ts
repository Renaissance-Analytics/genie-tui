import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * The tools that make this a coding agent rather than a chat box.
 *
 * ## Vendor-neutral, above the seam
 *
 * A tool here is a name, a description, a zod schema and an async function
 * returning a string. Nothing Mastra-shaped: `runtime/mastra.ts` wraps these
 * into whatever the runtime of the day wants. Tools are the most valuable thing
 * in a coding agent and the least worth rewriting when the runtime is replaced.
 *
 * ## Confinement is the contract, not a hardening pass
 *
 * These run model output against a real filesystem. Every path argument is
 * resolved against the workspace root and checked, INCLUDING through symlinks —
 * a `resolve().startsWith(root)` test passes happily for a link that sits inside
 * the workspace and points at `/etc`. `tools.test.ts` covers the three escapes
 * that actually get used.
 *
 * ## Every failure is a sentence, never a throw
 *
 * A tool that throws gives the model a stack trace; a tool that returns
 * "no such file: x" gives it something to act on, and the difference decides
 * whether the next turn recovers or repeats the same call. Mastra also has no
 * tool-call repair (GAPS M10), so a thrown error is simply an error chunk with
 * no retry — which makes readable failure text the only recovery mechanism
 * these tools have.
 *
 * ## Budgeted for small models
 *
 * The target is local models, where 8k context is common, so every result is
 * capped and says so when it truncates. An unbounded `read_file` is not a
 * convenience, it is a tool call that ends the conversation.
 */

/** One tool, in our vocabulary. */
export interface HarnessTool {
    name: string;
    description: string;
    schema: z.ZodType;
    /** True when the tool changes the workspace. Gated by `allowWrite`. */
    mutates: boolean;
    run(args: Record<string, unknown>): Promise<string>;
}

export interface ToolOptions {
    /** The workspace root. Nothing outside it is reachable. */
    cwd: string;
}

/** Characters of tool output the model is allowed to receive. */
const MAX_OUTPUT = 24_000;
/** Entries in one listing, and matches in one search. */
const MAX_ENTRIES = 200;
/** Directories never worth walking, and never worth the tokens. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

function truncate(text: string, what: string): string {
    if (text.length <= MAX_OUTPUT) return text;
    return `${text.slice(0, MAX_OUTPUT)}\n\n[truncated — ${what} is ${text.length} characters; showing the first ${MAX_OUTPUT}]`;
}

/**
 * Thrown for a path that escapes the workspace, and caught by {@link guard}.
 *
 * A distinct type so a containment refusal can never be mistaken for an
 * ordinary IO failure and reported as one.
 */
class OutsideWorkspace extends Error {
    constructor(given: string) {
        super(`refused: ${given} is outside the workspace`);
    }
}

/**
 * Resolve `given` inside `root`, following symlinks, or refuse.
 *
 * The realpath step is the part that matters. Resolving alone yields a path
 * that LOOKS contained; only asking the filesystem where it actually lands
 * catches a symlink pointing elsewhere. For a path that does not exist yet — a
 * file about to be written — the deepest existing ancestor is realpathed
 * instead, which catches a write through a symlinked directory.
 */
function inside(root: string, given: string): string {
    const target = path.resolve(root, given);

    let probe = target;
    while (!fs.existsSync(probe)) {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
    }

    const realRoot = fs.realpathSync(root);
    const realProbe = fs.existsSync(probe) ? fs.realpathSync(probe) : probe;
    const suffix = path.relative(probe, target);
    const resolved = suffix ? path.join(realProbe, suffix) : realProbe;

    const rel = path.relative(realRoot, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new OutsideWorkspace(given);
    return resolved;
}

/** Turn any throw into a sentence the model can act on. */
async function guard(work: () => Promise<string> | string): Promise<string> {
    try {
        return await work();
    } catch (err: unknown) {
        if (err instanceof OutsideWorkspace) return err.message;
        const code = (err as { code?: string }).code;
        if (code === 'ENOENT') return 'no such file or directory';
        if (code === 'EISDIR') return 'that is a directory, not a file';
        if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
        return `failed: ${err instanceof Error ? err.message : String(err)}`;
    }
}

/** Walk the workspace, skipping the directories nobody wants read. */
function* walk(dir: string, root: string): Generator<string> {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            yield* walk(full, root);
        } else if (entry.isFile()) {
            yield full;
        }
    }
}

export function harnessTools(opts: ToolOptions): HarnessTool[] {
    const root = opts.cwd;

    const readFile: HarnessTool = {
        name: 'read_file',
        description:
            'Read a UTF-8 text file from the workspace. Paths are relative to the workspace root.',
        mutates: false,
        schema: z.object({ path: z.string().describe('Path relative to the workspace root.') }),
        run: (args) =>
            guard(() => {
                const target = inside(root, String(args['path'] ?? ''));
                const body = fs.readFileSync(target, 'utf8');
                return truncate(body, 'the file');
            }),
    };

    const listDir: HarnessTool = {
        name: 'list_dir',
        description:
            'List the entries of a directory in the workspace. Directories are shown with a trailing slash.',
        mutates: false,
        schema: z.object({
            path: z.string().default('.').describe('Directory, relative to the workspace root.'),
        }),
        run: (args) =>
            guard(() => {
                const target = inside(root, String(args['path'] ?? '.'));
                const entries = fs
                    .readdirSync(target, { withFileTypes: true })
                    .filter((e) => !SKIP_DIRS.has(e.name))
                    .slice(0, MAX_ENTRIES)
                    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
                    .sort();
                return entries.length ? entries.join('\n') : '(empty)';
            }),
    };

    const searchFiles: HarnessTool = {
        name: 'search_files',
        description:
            'Search file contents in the workspace for a regular expression. Returns file:line: matches.',
        mutates: false,
        schema: z.object({
            pattern: z.string().describe('A JavaScript regular expression.'),
            path: z.string().default('.').describe('Directory to search, relative to the root.'),
        }),
        run: (args) =>
            guard(() => {
                const target = inside(root, String(args['path'] ?? '.'));
                let re: RegExp;
                try {
                    re = new RegExp(String(args['pattern'] ?? ''));
                } catch (err: unknown) {
                    // A bad regex is the model's mistake to fix, so name it
                    // rather than reporting a generic failure.
                    return `not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`;
                }

                const hits: string[] = [];
                for (const file of walk(target, root)) {
                    if (hits.length >= MAX_ENTRIES) break;
                    let body: string;
                    try {
                        body = fs.readFileSync(file, 'utf8');
                    } catch {
                        continue; // binary, unreadable, or vanished mid-walk
                    }
                    body.split('\n').forEach((line, i) => {
                        if (hits.length < MAX_ENTRIES && re.test(line)) {
                            hits.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`);
                        }
                    });
                }
                return hits.length ? truncate(hits.join('\n'), 'the result') : 'no matches';
            }),
    };

    const writeFile: HarnessTool = {
        name: 'write_file',
        description:
            'Write a UTF-8 text file in the workspace, creating parent directories as needed. Replaces the whole file.',
        mutates: true,
        schema: z.object({
            path: z.string().describe('Path relative to the workspace root.'),
            content: z.string().describe('The complete new contents of the file.'),
        }),
        run: (args) =>
            guard(() => {
                const target = inside(root, String(args['path'] ?? ''));
                fs.mkdirSync(path.dirname(target), { recursive: true });
                const content = String(args['content'] ?? '');
                fs.writeFileSync(target, content, 'utf8');
                return `wrote ${path.relative(root, target)} (${content.length} characters)`;
            }),
    };

    return [readFile, listDir, searchFiles, writeFile];
}

export function toolNames(tools: HarnessTool[]): string[] {
    return tools.map((t) => t.name);
}

/**
 * The approval policy these tools imply: read freely, ask before changing.
 *
 * This replaced an `--allow-write` switch, and the switch is worth explaining
 * because it looked reasonable. It existed only because the approval gate could
 * not be answered, so a blanket, operator-set permission was the honest
 * stand-in for a per-call decision. Once the gate became resolvable the switch
 * was a SECOND, coarser permission system sitting beside a working one — two
 * mechanisms, one of which silently overrode the other's intent.
 *
 * Deriving the policy from `mutates` also means a new mutating tool is gated the
 * moment it is added, rather than when someone remembers to list it.
 */
export function autoApprovePolicy(tools: HarnessTool[]): (toolName: string) => boolean {
    const readOnly = new Set(tools.filter((t) => !t.mutates).map((t) => t.name));
    return (toolName) => readOnly.has(toolName);
}
