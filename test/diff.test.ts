import { describe, expect, it } from 'vitest';
import { diffTraces, diffViolations, parseDiffGates, renderDiffHtml } from '../src/diff.js';
import type { Trace } from '../src/types.js';
const trace = (items: Array<{ id?: string; t?: number; delta?: string }>, adapter = 'ai-sdk'): Trace => ({
  meta: {
    v: 1,
    kind: 'meta',
    session: 'x',
    adapter,
    framing: 'sse',
    protocol: 'ai-sdk',
    startedAt: '2026-01-01',
  },
  frames: items.map((x, seq) => ({
    seq,
    t_ms: x.t ?? seq,
    raw: '',
    event: {
      type: 'text-delta',
      ...(x.id ? { id: x.id } : {}),
      delta: x.delta ?? 'x',
    },
  })),
});
describe('trace diff', () => {
  it('reports identical traces and key-order-insensitive payloads', () => {
    const a = trace([{ id: 'a' }]);
    expect(diffTraces(a, a).noDifferences).toBe(true);
  });
  it('separates added removed payload order and elapsed latency', () => {
    const d = diffTraces(
      trace([{ id: 'a' }, { id: 'b' }, { id: 'c' }]),
      trace([
        { id: 'c', t: 202 },
        { id: 'a', t: 201, delta: 'changed' },
        { id: 'd', t: 203 },
      ]),
    );
    expect(d.added).toHaveLength(1);
    expect(d.removed).toHaveLength(1);
    expect(d.matched.every((x) => x.reordered)).toBe(true);
    expect(d.matched[0]?.payload[0]?.path).toBe('/delta');
    expect(diffViolations(d, parseDiffGates('added,removed,payload,latency>200ms,count'))).toEqual([
      'added',
      'removed',
      'payload',
      'latency>200ms',
    ]);
  });
  it('does not call an insertion a reorder for identified events', () => {
    const d = diffTraces(trace([{ id: 'a' }, { id: 'b' }]), trace([{ id: 'new' }, { id: 'a' }, { id: 'b' }]));
    expect(d.matched.some((x) => x.reordered)).toBe(false);
  });
  it('matches repeated deltas by id and occurrence, documenting anonymous ordinal fallback', () => {
    const d = diffTraces(trace([{ id: 'a' }, { id: 'a' }]), trace([{ id: 'a' }, { id: 'a', delta: 'new' }]));
    expect(d.matched).toHaveLength(2);
    expect(d.matched[1]?.payload).toHaveLength(1);
    expect(diffTraces(trace([{}]), trace([{ delta: 'x' }, {}])).added).toHaveLength(1);
  });
  it('refuses adapter, protocol and framing mismatches', () => {
    const a = trace([]),
      b = trace([], 'ndjson');
    expect(() => diffTraces(a, b)).toThrow('incompatible');
    b.meta.adapter = a.meta.adapter;
    b.meta.framing = 'raw';
    expect(() => diffTraces(a, b)).toThrow('incompatible');
  });
  it('rejects malformed gates and timestamps and uses positive strict latency thresholds', () => {
    for (const g of ['', 'reorder', 'latency>NaNms', 'latency>-1ms']) expect(() => parseDiffGates(g)).toThrow();
    expect(() => diffTraces(trace([{ t: NaN }]), trace([]))).toThrow();
    const d = diffTraces(trace([{ id: 'a', t: 200 }]), trace([{ id: 'a', t: 400 }]));
    expect(diffViolations(d, parseDiffGates('latency>200ms'))).toEqual([]);
  });
  it('escapes text and reuses sandboxed before/after timeline panels', () => {
    const a = trace([{ id: '</pre><script>alert(1)</script>' }]);
    const html = renderDiffHtml(diffTraces(a, trace([])), a, trace([]));
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('title="Before trace" sandbox="allow-scripts"');
  });
});

describe('tool-call acceptance and structural keys', () => {
  it('distinguishes a removed tool, an added tool, and exactly +200ms', () => {
    const before = trace([
      { id: 'call-keep', t: 0 },
      { id: 'call-old', t: 20 },
    ]);
    const after = trace([
      { id: 'call-keep', t: 200 },
      { id: 'call-new', t: 220 },
    ]);
    for (const t of [before, after]) for (const f of t.frames) f.event.type = 'tool-call-delta';
    const d = diffTraces(before, after);
    expect(d.removed[0]?.key).toContain('call-old');
    expect(d.added[0]?.key).toContain('call-new');
    expect(d.matched[0]?.latencyDeltaMs).toBe(200);
    expect(diffViolations(d, parseDiffGates('latency>199ms'))).toEqual(['latency>199ms']);
    expect(diffViolations(d, parseDiffGates('latency>200ms'))).toEqual([]);
  });
  it('ignores object key ordering, reports escaped JSON pointers, and matches native input indices', () => {
    const a = trace([{}, {}]),
      b = trace([{}, {}]);
    a.frames[0]!.event.data = { inputIndex: 0, value: { b: 2, a: 1 } };
    a.frames[1]!.event.data = { inputIndex: 1, 'a/b~': { ok: true } };
    b.frames[0]!.event.data = { inputIndex: 1, 'a/b~': { ok: false } };
    b.frames[1]!.event.data = { value: { a: 1, b: 2 }, inputIndex: 0 };
    const d = diffTraces(a, b);
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
    expect(d.matched[0]?.payload).toHaveLength(0);
    expect(d.matched[1]?.payload[0]?.path).toBe('/data/a~1b~0/ok');
    expect(d.matched.every((x) => x.reordered)).toBe(true);
  });
});

describe('provider identities and completed JSON args', () => {
  it('aligns OpenAI nested tool indices instead of absolute ordinals', () => {
    const a = trace([{}, {}]),
      b = trace([{}]);
    for (const [i, f] of a.frames.entries()) {
      f.event.type = 'tool-call-delta';
      f.event.data = { id: 'step', delta: { step_details: { tool_calls: [{ index: i }] } } };
    }
    b.frames[0]!.event = structuredClone(a.frames[1]!.event);
    const d = diffTraces(a, b);
    expect(d.removed).toHaveLength(1);
    expect(d.added).toHaveLength(0);
    expect(d.matched[0]?.beforeIndex).toBe(1);
  });
  it('aligns LangGraph nested tool chunk index within message', () => {
    const a = trace([{}, {}]),
      b = trace([{}]);
    for (const [i, f] of a.frames.entries()) {
      f.event.type = 'tool-call-delta';
      f.event.data = [{ id: 'message', tool_call_chunks: [{ index: i }] }];
    }
    b.frames[0]!.event = structuredClone(a.frames[1]!.event);
    expect(diffTraces(a, b).matched[0]?.beforeIndex).toBe(1);
  });
  it('treats valid completed JSON args structurally but not incomplete fragments', () => {
    const a = trace([{ id: 'tool' }]),
      b = trace([{ id: 'tool' }]);
    for (const t of [a, b]) {
      t.frames[0]!.event.type = 'tool-call-delta';
      t.frames[0]!.event.complete = true;
    }
    a.frames[0]!.event.argsDelta = '{"a":1,"b":2}';
    b.frames[0]!.event.argsDelta = '{"b":2,"a":1}';
    expect(diffTraces(a, b).noDifferences).toBe(true);
    b.frames[0]!.event.complete = false;
    expect(diffTraces(a, b).matched[0]?.payload.length).toBeGreaterThan(0);
  });
});
