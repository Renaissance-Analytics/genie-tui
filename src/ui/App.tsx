import React from 'react';
import {
    Badge,
    Composer,
    FancyTuiProvider,
    Header,
    LiveRegion,
    MessageList,
    Panel,
    Screen,
    Stack,
    StatusBar,
    Text,
    ToolCall,
} from '@particle-academy/fancy-tui';

import { SURFACE_IDS } from '../surfaces.js';
import type { HarnessState } from '../protocol.js';
import type { HarnessActions } from '../surfaces.js';

/**
 * The surface, built entirely from `fancy-tui` primitives.
 *
 * The layout rule that matters is not stylistic. Completed turns commit through
 * `MessageList` (Ink `Static`) so they are painted once and never repainted —
 * that is what keeps terminal scrollback intact. Everything mutable — the
 * in-flight answer, tool status, pending approvals — renders in `LiveRegion`
 * BELOW the static region, where repainting is safe.
 *
 * The component is pure: it takes state and callbacks. Nothing here talks to
 * Mastra or Genie, which is what lets it be asserted with `ink-testing-library`
 * at a fixed width instead of against a real terminal.
 */

export interface AppProps {
    state: HarnessState;
    actions: HarnessActions;
    onChange: (text: string) => void;
    onSubmit: (text: string) => void;
    /** Overrides for the render target. Tests pass a fixed grid; the CLI omits both. */
    width?: number;
    height?: number;
}

const TURN_TONE = {
    idle: 'neutral',
    thinking: 'info',
    tool: 'primary',
    'awaiting-approval': 'warning',
    'awaiting-input': 'warning',
} as const;

export function App({
    state,
    onChange,
    onSubmit,
    width,
    height,
}: AppProps): React.JSX.Element {
    const { turn, composer, transcript, live, tools, approvals, session } = state;

    return (
        <FancyTuiProvider width={width} height={height}>
            <Screen>
                <Header
                    title={session.name}
                    subtitle={session.cwd}
                    status={session.sessionId ? 'connected' : 'binding'}
                />

                {/* Committed. Painted once, never repainted. */}
                <MessageList
                    messages={transcript.map((m) => ({
                        id: m.id,
                        role: m.role,
                        content: m.content,
                    }))}
                />

                {/* Mutable. Everything that changes within a turn lives here. */}
                <LiveRegion>
                    <Stack gap="xs">
                        {live ? <Text>{live.content}</Text> : null}

                        {tools.map((t) => (
                            <ToolCall key={t.id} call={{ id: t.id, name: t.name, status: t.status }} />
                        ))}

                        {approvals.length > 0 ? (
                            <Panel tone="warning" title="Approval required">
                                <Stack gap="xs">
                                    {approvals.map((a) => (
                                        <Text key={a.id}>{a.name}</Text>
                                    ))}
                                </Stack>
                            </Panel>
                        ) : null}
                    </Stack>
                </LiveRegion>

                {/*
                 * `composer.input`, NOT `composer`. This component registers a
                 * Human+ surface under whatever `id` it is given, and the
                 * harness publishes its own `composer` surface — the one
                 * carrying `busy` and `deliver`. Both under one id is a
                 * duplicate, and the registry throws on duplicates, so the app
                 * used to die on mount after painting a single frame. See
                 * SURFACE_IDS for why these are two surfaces rather than one.
                 */}
                <Composer
                    id={SURFACE_IDS.composerInput}
                    value={composer.text}
                    onChange={onChange}
                    onSubmit={onSubmit}
                    placeholder={composer.busy ? 'Working — your message will be queued' : 'Ask anything'}
                />

                {/*
                 * The turn state is displayed because the harness HOLDS it, not
                 * because a spinner is animating. Genie reads the same value
                 * over the bridge that the human reads here — one fact, two
                 * consumers, no inference on either side.
                 */}
                <StatusBar
                    left={<Badge tone={TURN_TONE[turn.state]}>{turn.state}</Badge>}
                    right={<Text tone="muted">{session.provider}</Text>}
                />
            </Screen>
        </FancyTuiProvider>
    );
}
