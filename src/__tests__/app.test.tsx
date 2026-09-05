import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';

import { App } from '../ui/App.js';
import { initialState, reduce } from '../reduce.js';
import type { HarnessState } from '../protocol.js';

/**
 * Render assertions for the `fancy-tui` surface.
 *
 * The contract being checked is the one the fancy-ui TUI guidance calls out:
 * completed turns commit through `MessageList` (Ink `Static`, which never
 * repaints, so scrollback survives) while in-flight tokens and tool status live
 * in `LiveRegion` below it. Getting that backwards corrupts scrollback in a way
 * that is invisible in a screenshot and obvious after an hour of use.
 */

const boot = () => initialState({ name: 'skeleton', cwd: '/repo' });
const noop = {
    setText: () => {},
    deliver: () => {},
    submit: () => {},
    clear: () => {},
    interrupt: () => {},
    approve: () => {},
    deny: () => {},
};

function draw(state: HarnessState): string {
    // A fixed width keeps the assertions about content, not about this
    // machine's terminal.
    const { lastFrame } = render(
        <App state={state} actions={noop} onChange={() => {}} onSubmit={() => {}} width={80} height={24} />,
    );
    return lastFrame() ?? '';
}

describe('the app renders', () => {
    it('shows the agent name and cwd in the header', () => {
        const frame = draw(boot());
        expect(frame).toContain('skeleton');
        expect(frame).toContain('/repo');
    });

    it('shows committed messages', () => {
        let s = boot();
        s = reduce(s, { kind: 'composer-submit', text: 'what changed?' }, 1);
        s = reduce(s, { kind: 'message', id: 'm1', role: 'agent', content: 'Two files.', done: true }, 2);
        const frame = draw(s);
        expect(frame).toContain('what changed?');
        expect(frame).toContain('Two files.');
    });

    it('shows in-flight text while a turn runs', () => {
        let s = boot();
        s = reduce(s, { kind: 'turn-start' }, 1);
        s = reduce(s, { kind: 'message', id: 'm1', role: 'agent', content: 'Still going', done: false }, 2);
        expect(draw(s)).toContain('Still going');
    });

    it('shows tool calls with their status', () => {
        let s = boot();
        s = reduce(s, { kind: 'turn-start' }, 1);
        s = reduce(s, { kind: 'tool-start', id: 't1', name: 'run_tests' }, 2);
        expect(draw(s)).toContain('run_tests');
    });

    /**
     * The turn state is on screen because it is a fact the harness holds, not
     * because a spinner is animating. That difference is the entire design:
     * Genie reads the same value over the bridge that the human reads here.
     */
    it('states the turn on the status bar', () => {
        expect(draw(boot())).toContain('idle');

        let s = reduce(boot(), { kind: 'turn-start' }, 1);
        s = reduce(s, { kind: 'tool-start', id: 't1', name: 'x' }, 2);
        expect(draw(s)).toContain('tool');
    });

    it('surfaces a pending approval rather than hiding it behind a spinner', () => {
        let s = reduce(boot(), { kind: 'turn-start' }, 1);
        s = reduce(s, { kind: 'approval-required', id: 'a1', name: 'delete_branch', args: {} }, 2);
        const frame = draw(s);
        expect(frame).toContain('delete_branch');
        expect(frame).toContain('awaiting-approval');
    });

    /**
     * The non-interactive smoke: Genie spawns this in a pty, but CI and
     * `--print` runs have no TTY and must not fail to mount.
     *
     * Asserted on the FRAME, not with `not.toThrow()` — `ink-testing-library`
     * swallows a render error and returns an empty frame, so a throwing
     * component passes `not.toThrow()` happily. That test would have passed on
     * a corpse; this one requires a pulse.
     */
    it('mounts and paints without a TTY', () => {
        const frame = draw(boot());
        expect(frame.trim().length).toBeGreaterThan(0);
        expect(frame).toContain('skeleton');
    });
});
