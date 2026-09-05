import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createGenieBridge, harnessReport } from '../bridge/genie.js';
import { initialState, reduce } from '../reduce.js';
import type { HarnessState } from '../protocol.js';

/**
 * The bridge is tested OVER REAL HTTP against a stub endpoint, not with a mocked
 * fetch. The whole claim of the design is that Genie's existing per-terminal MCP
 * endpoint is already a usable bidirectional channel, so the JSON-RPC frame this
 * produces is the deliverable — it is the exact request Genie would have to
 * accept. A mock would let a wrong frame pass.
 */

let server: http.Server;
let received: unknown[] = [];
let url = '';

beforeEach(async () => {
    received = [];
    server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            received.push(JSON.parse(body));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }));
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/deadbeef`;
});

afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
});

function busyState(): HarnessState {
    let s = initialState({ name: 'skeleton', cwd: '/repo' });
    s = reduce(s, { kind: 'session-ready', sessionId: 'abc-123', threadId: 'abc-123' }, 1);
    s = reduce(s, { kind: 'composer-change', text: 'half-typed', cursor: 10 }, 2);
    s = reduce(s, { kind: 'turn-start' }, 3);
    s = reduce(s, { kind: 'tool-start', id: 't1', name: 'run_tests' }, 4);
    return s;
}

describe('the report payload', () => {
    /**
     * Everything in this payload is a value Genie currently computes by
     * inference: `composer` replaces the keystroke-folded `Draft`, and `turn`
     * replaces fifteen seconds of measured output silence.
     */
    it('carries the composer buffer and the turn state', () => {
        expect(harnessReport(busyState())).toEqual({
            ref: 'genie:skeleton:abc-123',
            provider: 'genie',
            name: 'skeleton',
            sessionId: 'abc-123',
            composer: { text: 'half-typed', cursor: 10, busy: true },
            turn: { state: 'tool', since: 4, pendingTools: ['run_tests'], approvals: [] },
        });
    });

    it('carries no confidence field, because nothing was reconstructed', () => {
        expect(harnessReport(busyState()).composer).not.toHaveProperty('confident');
    });
});

describe('speaking to the per-terminal endpoint', () => {
    it('posts a well-formed JSON-RPC tools/call frame', async () => {
        const bridge = createGenieBridge({ url, terminalId: 'term-1' });
        await bridge.report(busyState());

        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
                name: 'agentinbox',
                arguments: {
                    action: 'reportState',
                    state: { turn: { state: 'tool' } },
                },
            },
        });
    });

    /**
     * The endpoint token self-identifies the terminal server-side
     * (`registerTerminalEndpoint`, genie #35), which is why the Codex
     * SessionStart hook never passes a terminal id either. Sending one anyway
     * would invite Genie to trust a caller-supplied id.
     */
    it('does not send a terminal id — the endpoint token already identifies it', async () => {
        const bridge = createGenieBridge({ url, terminalId: 'term-1' });
        await bridge.report(busyState());
        expect(JSON.stringify(received[0])).not.toContain('term-1');
    });

    /**
     * The contract is "one request, not five". It used to be asserted by
     * sleeping 60ms and counting — which measures the machine as much as the
     * code: on a loaded runner the debounce fires but the HTTP round trip has
     * not finished, `received` is empty, and the test fails having proved
     * nothing about coalescing. It flaked exactly that way in a full run.
     *
     * So: wait for the FIRST report to actually arrive, then hold still long
     * enough that a second one would have landed if the burst had not been
     * coalesced. Both halves are needed — waiting only for the first would pass
     * against a bridge that sends five.
     */
    it('coalesces bursts into one report rather than one per keystroke', async () => {
        const bridge = createGenieBridge({ url, terminalId: 'term-1', debounceMs: 20 });
        let s = initialState({ name: 'skeleton', cwd: '/repo' });
        for (const ch of 'hello') {
            s = reduce(s, { kind: 'composer-change', text: ch, cursor: 1 }, 1);
            bridge.schedule(s);
        }

        const deadline = Date.now() + 10_000;
        while (received.length === 0 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 10));
        }
        expect(received, 'the coalesced report arrived').toHaveLength(1);

        await new Promise((r) => setTimeout(r, 100));
        expect(received, 'and the other four keystrokes sent nothing').toHaveLength(1);
    });

    /**
     * Genie may be closed, restarting, or simply not the parent. A harness that
     * dies because its reporting channel is unavailable would be strictly worse
     * than one that runs unreported — the TUI's job is to be a coding agent
     * first.
     */
    it('survives an unreachable Genie', async () => {
        const bridge = createGenieBridge({ url: 'http://127.0.0.1:1/mcp/nope', terminalId: 't' });
        await expect(bridge.report(busyState())).resolves.toBeUndefined();
    });

    it('is inert when Genie did not launch it', async () => {
        const bridge = createGenieBridge({ url: undefined, terminalId: undefined });
        await bridge.report(busyState());
        expect(received).toHaveLength(0);
        expect(bridge.enabled).toBe(false);
    });
});
