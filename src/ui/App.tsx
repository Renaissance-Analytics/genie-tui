import React from 'react';
import { useInput } from 'ink';
import {
    Badge,
    Composer,
    FancyTuiProvider,
    Header,
    KeyHint,
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
import type { HarnessState, PendingApproval } from '../protocol.js';
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

/** How much of a tool's arguments to show. A `write_file` carries a whole file. */
const MAX_ARGS = 240;

/**
 * What the agent is asking permission to do, in one line.
 *
 * The arguments matter more than the tool name. "May I write a file?" is not a
 * question anyone can answer responsibly; "may I write src/x.ts?" is.
 */
function describeArgs(args: unknown): string {
    if (args === undefined || args === null) return '';
    const text = typeof args === 'string' ? args : JSON.stringify(args);
    if (!text) return '';
    return text.length > MAX_ARGS ? `${text.slice(0, MAX_ARGS)}…` : text;
}

/**
 * The one screen where the human is the blocking dependency.
 *
 * It REPLACES the composer rather than sitting alongside it. Ink delivers every
 * keypress to every mounted `useInput`, so with the composer still on screen a
 * `y` would approve the tool and type a `y` at the same time. Exclusivity is
 * the reason for the swap, not tidiness.
 */
function ApprovalPrompt({
    approval,
    onApprove,
    onDeny,
}: {
    approval: PendingApproval;
    onApprove: (id: string) => void;
    onDeny: (id: string) => void;
}): React.JSX.Element {
    useInput((input) => {
        const key = input.toLowerCase();
        if (key === 'y') onApprove(approval.id);
        if (key === 'n') onDeny(approval.id);
    });

    const args = describeArgs(approval.args);

    return (
        <Panel tone="warning" title="Approval required">
            <Stack gap="xs">
                <Text>{approval.name}</Text>
                {args ? <Text tone="muted">{args}</Text> : null}
                <KeyHint keys={['y', 'n']} label="y approve · n deny" />
            </Stack>
        </Panel>
    );
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
    actions,
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

                    </Stack>
                </LiveRegion>

                {/*
                 * One or the other, never both — see `ApprovalPrompt`: two
                 * mounted input handlers would both receive every keypress.
                 *
                 * The composer's id is `composer.input`, NOT `composer`. This
                 * component registers a Human+ surface under whatever `id` it is
                 * given, and the harness publishes its own `composer` surface —
                 * the one carrying `busy` and `deliver`. Both under one id is a
                 * duplicate, the registry throws on duplicates, and the app died
                 * on mount after painting a single frame. See SURFACE_IDS.
                 */}
                {approvals[0] ? (
                    <ApprovalPrompt
                        approval={approvals[0]}
                        onApprove={actions.approve}
                        onDeny={actions.deny}
                    />
                ) : (
                    <Composer
                        id={SURFACE_IDS.composerInput}
                        value={composer.text}
                        onChange={onChange}
                        onSubmit={onSubmit}
                        placeholder={
                            composer.busy ? 'Working — your message will be queued' : 'Ask anything'
                        }
                    />
                )}

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
