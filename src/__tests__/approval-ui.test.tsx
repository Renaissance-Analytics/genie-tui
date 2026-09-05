import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';

import { App } from '../ui/App.js';
import { initialState, reduce } from '../reduce.js';
import type { HarnessActions } from '../surfaces.js';
import type { HarnessState } from '../protocol.js';

/**
 * The approval prompt — the one screen where the human is the blocking
 * dependency.
 *
 * Rendering the pending tool was never the hard part; ANSWERING it was. The
 * turn parks until somebody says yes or no, so a prompt that shows what is
 * being asked but offers no way to reply is a hang with better typography.
 *
 * The keys have to be exclusive, which is why the composer is not on screen
 * while a decision is outstanding: Ink delivers a keypress to every mounted
 * `useInput`, so a visible composer would take the `y` as text AND approve at
 * the same time.
 */

const boot = () => initialState({ name: 'skeleton', cwd: '/repo' });

function actions(): HarnessActions {
    return {
        setText: vi.fn(),
        deliver: vi.fn(),
        submit: vi.fn(),
        clear: vi.fn(),
        interrupt: vi.fn(),
        approve: vi.fn(),
        deny: vi.fn(),
    };
}

function pending(): HarnessState {
    let s = reduce(boot(), { kind: 'turn-start' }, 1);
    s = reduce(s, { kind: 'tool-start', id: 'a1', name: 'write_file' }, 2);
    return reduce(
        s,
        { kind: 'approval-required', id: 'a1', name: 'write_file', args: { path: 'src/x.ts' } },
        3,
    );
}

function draw(state: HarnessState, acts: HarnessActions) {
    return render(
        <App state={state} actions={acts} onChange={() => {}} onSubmit={() => {}} width={80} height={24} />,
    );
}

describe('a pending approval is answerable', () => {
    it('shows what is being asked, including the arguments', () => {
        const frame = draw(pending(), actions()).lastFrame() ?? '';

        expect(frame).toContain('write_file');
        // The ARGUMENTS, not just the tool name. "May I write a file?" is not a
        // question anyone can answer responsibly; "may I write src/x.ts?" is.
        expect(frame).toContain('src/x.ts');
    });

    it('tells the human which keys answer it', () => {
        const frame = draw(pending(), actions()).lastFrame() ?? '';

        expect(frame.toLowerCase()).toContain('y');
        expect(frame.toLowerCase()).toContain('n');
    });

    it('approves on y', async () => {
        const acts = actions();
        const view = draw(pending(), acts);

        view.stdin.write('y');
        await new Promise((r) => setTimeout(r, 50));

        expect(acts.approve).toHaveBeenCalledWith('a1');
        expect(acts.deny).not.toHaveBeenCalled();
    });

    it('denies on n', async () => {
        const acts = actions();
        const view = draw(pending(), acts);

        view.stdin.write('n');
        await new Promise((r) => setTimeout(r, 50));

        expect(acts.deny).toHaveBeenCalledWith('a1');
        expect(acts.approve).not.toHaveBeenCalled();
    });

    /**
     * Ink delivers every keypress to every mounted `useInput`. With the composer
     * on screen, `y` would approve the tool AND type a `y` into the prompt — so
     * the composer is replaced while a decision is outstanding rather than
     * merely disabled.
     */
    it('takes the composer off screen while a decision is outstanding', () => {
        const idle = draw(boot(), actions()).lastFrame() ?? '';
        expect(idle, 'the composer is there normally').toContain('Ask anything');

        const blocked = draw(pending(), actions()).lastFrame() ?? '';
        expect(blocked, 'and gone while an approval is pending').not.toContain('Ask anything');
        // Both placeholders, or this passes merely because a BUSY composer says
        // something different while still being mounted and still eating keys.
        expect(blocked).not.toContain('will be queued');
    });

    /**
     * The control: with nothing pending, those same keys must be ordinary text.
     * Otherwise "approve on y" would be indistinguishable from a handler that
     * fires on every `y` the user ever types.
     */
    it('does not treat y as an answer when nothing is pending', async () => {
        const acts = actions();
        const view = draw(boot(), acts);

        view.stdin.write('y');
        await new Promise((r) => setTimeout(r, 50));

        expect(acts.approve).not.toHaveBeenCalled();
        expect(acts.deny).not.toHaveBeenCalled();
    });
});
