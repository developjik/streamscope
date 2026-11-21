import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { escapeHtml, renderPanelHtml, safeJson, stateAt } from '../src/ui/panel.js';
import { readTrace } from '../src/trace.js';
import type { Trace } from '../src/types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'demo', 'traces', 'chat-ai-sdk.jsonl');

describe('panel state', () => {
  it('accumulates text, tool arguments and approvals up to a frame', async () => {
    const trace = await readTrace(fixture);
    const mid = stateAt(trace.frames, 6);
    expect(mid.text).toBe('Sure — I checked the order and it shipped yesterday. Want me to reschedule the delivery?');
    const last = stateAt(trace.frames, trace.frames.length - 1);
    expect(last.toolCalls[0]).toMatchObject({ id: 'call_track_1', name: 'track_shipment', argsValid: true });
    expect(last.toolCalls[0]?.args).toBe('{"orderId":"A-1042"}');
    expect(last.toolCalls[0]?.result).toEqual({ status: 'in_transit', eta: '2026-11-23' });
    expect(last.approvals).toEqual([{ id: 'approval_1', decision: 'requested' }]);
    expect(last.sawFinish).toBe(true);
    expect(last.breakIndex).toBeNull();
  });

  it('marks a stream that never finished as broken at its last frame', () => {
    const frames = [
      { event: { type: 'text-delta' as const, delta: 'partial' } },
      { event: { type: 'text-delta' as const, delta: ' text' } },
    ];
    const state = stateAt(frames, 1);
    expect(state.breakIndex).toBe(1);
    expect(state.breakReason).toMatch(/without a finish/);
  });

  it('marks an error frame as the break point', () => {
    const frames = [
      { event: { type: 'text-delta' as const, delta: 'a' } },
      { event: { type: 'error' as const, message: 'HTTP 429' } },
    ];
    const state = stateAt(frames, 1);
    expect(state.breakIndex).toBe(1);
    expect(state.breakReason).toBe('error frame: HTTP 429');
    expect(state.errors).toEqual(['HTTP 429']);
  });
});

describe('renderPanelHtml', () => {
  it('renders a self-contained page with the timeline widgets', async () => {
    const trace = await readTrace(fixture);
    const html = renderPanelHtml(trace);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('id="scrub"');
    expect(html).toContain('id="list"');
    expect(html).toContain('Accumulated text');
    expect(html).toContain('Tool calls (argument assembly)');
    expect(html).toContain('chat-ai-sdk');
    expect(html).not.toContain('src="http'); // no external assets
  });

  it('escapes untrusted trace text so it cannot break out of the script tag', () => {
    const trace: Trace = {
      meta: {
        v: 1,
        kind: 'meta',
        session: 'x',
        adapter: 'ai-sdk',
        framing: 'sse',
        protocol: 'ai-sdk',
        startedAt: '2026-01-01T00:00:00.000Z',
      },
      frames: [
        {
          t_ms: 0,
          seq: 0,
          raw: 'data: x\n\n',
          event: { type: 'text-delta', delta: '</script><script>alert(1)</script>' },
        },
      ],
    };
    const html = renderPanelHtml(trace);
    expect(html.match(/<\/script><script>alert/g)).toBeNull();
    expect(html).toContain('\\u003c/script\\u003e');
    expect(escapeHtml('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;');
    expect(safeJson({ a: '</script>' })).toBe('{"a":"\\u003c/script\\u003e"}');
  });

  it('renders injected frames when given', () => {
    const trace: Trace = {
      meta: {
        v: 1,
        kind: 'meta',
        session: 'x',
        adapter: 'ai-sdk',
        framing: 'sse',
        protocol: 'ai-sdk',
        startedAt: '2026-01-01T00:00:00.000Z',
      },
      frames: [{ t_ms: 0, seq: 0, raw: 'a', event: { type: 'finish' } }],
    };
    const html = renderPanelHtml(trace, {
      frames: [
        { t_ms: 0, seq: 0, raw: 'a', event: { type: 'text-delta', delta: 'only' }, injected: false },
        { t_ms: 1, seq: 1, raw: 'b', event: { type: 'error', status: 429 }, injected: true },
      ],
    });
    expect(html).toContain('injected');
    expect(html).toContain('only');
  });
});
