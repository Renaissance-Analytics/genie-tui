import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { TuiSurfaceProvider, createTuiSurfaceRegistry } from '@particle-academy/fancy-tui';

import { App } from '../ui/App.js';
import { harnessSurfaces, SURFACE_IDS } from '../surfaces.js';
import { initialState } from '../reduce.js';
import type { HarnessActions } from '../surfaces.js';

/**
 * The composition the CLI actually mounts — App INSIDE a `TuiSurfaceProvider`
 * whose registry already holds the harness surfaces.
 *
 * This is the test that was missing, and its absence is why a crash-on-launch
 * survived a green suite. `app.test.tsx` renders `App` on its own, with no
 * provider, so `useTuiSurface` finds a null registry and quietly does nothing.
 * Every `fancy-tui` component that registers a surface — `Composer`, `Modal`,
 * `Drawer`, `DocumentViewer`, the choice lists — is therefore INERT in that
 * test, and any id collision between a component and a surface the harness
 * registers is invisible until the real CLI runs.
 *
 * It was not hypothetical. `<Composer id="composer">` registers
 * `kind: 'multiline-input'` under `composer`, `cli.tsx` registered the harness's
 * own `composer` surface under the same id, and `registry.register` THROWS on a
 * duplicate. The TUI painted one frame and died on mount, in every terminal,
 * every time.
 *
 * The rule this file encodes: a component test that omits the provider is
 * testing a different program from the one that ships.
 */

const noopActions: HarnessActions = {
    setText: () => {},
    deliver: () => {},
    submit: () => {},
    clear: () => {},
    interrupt: () => {},
};

function mount() {
    const state = initialState({ name: 'compose', cwd: '/repo' });
    const registry = createTuiSurfaceRegistry();
    for (const surface of harnessSurfaces(() => state, noopActions)) registry.register(surface);

    const view = render(
        <TuiSurfaceProvider registry={registry}>
            <App state={state} actions={noopActions} onChange={() => {}} onSubmit={() => {}} width={80} height={24} />
        </TuiSurfaceProvider>,
    );

    return { registry, view };
}

describe('the real composition mounts', () => {
    /**
     * `ink-testing-library`'s `render` swallows a render error and returns an
     * empty frame, so `not.toThrow()` here would be vacuous (GAPS I1). The
     * assertion has to be on what was PAINTED.
     */
    it('paints a frame rather than a duplicate-surface error', () => {
        const { view } = mount();

        const frame = view.lastFrame() ?? '';
        expect(frame).not.toContain('Duplicate');
        expect(frame).toContain('compose');
    });

    /**
     * The collision, stated as an invariant rather than left to be rediscovered.
     *
     * Every surface in the registry has a distinct id by construction — the
     * registry throws otherwise — so the real assertion is that the harness's
     * semantic `composer` surface and the input WIDGET's surface both survived,
     * under different ids. If someone gives the `<Composer>` the harness's id
     * again, the count drops and this fails.
     */
    it('keeps the harness composer surface and the input widget surface apart', () => {
        const { registry } = mount();
        const ids = registry.list().map((s) => s.id);

        expect(ids).toContain(SURFACE_IDS.composer);
        expect(ids).toContain(SURFACE_IDS.composerInput);
        expect(SURFACE_IDS.composer).not.toBe(SURFACE_IDS.composerInput);

        // The harness surface is the one carrying `busy` — the fact that lets a
        // delivery be queued instead of typed at a running agent. The widget's
        // surface reports the raw buffer and knows nothing about turns.
        const composer = registry.get(SURFACE_IDS.composer);
        expect(composer?.read()).toMatchObject({ text: '', cursor: 0, busy: false });
    });
});
