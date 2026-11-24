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
