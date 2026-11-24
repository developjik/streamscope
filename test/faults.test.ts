import { describe, expect, it } from 'vitest';
import {
  FaultSyntaxError,
  applyFaults,
  defaultEncoder,
  formatScenario,
  parseScenario,
  truncateUtf8,
} from '../src/faults.js';
import { createAdapter } from '../src/adapters/index.js';
import type { TraceFrame } from '../src/types.js';

const meta = { framing: 'sse' as const, protocol: 'ai-sdk' as const };

function frames(count = 8): TraceFrame[] {
  const out: TraceFrame[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      t_ms: i * 10,
      seq: i,
      raw: `data: {"type":"text-delta","delta":"${i}"}\n\n`,
      event: { type: 'text-delta', delta: String(i) },
    });
  }
  return out;
}

function toolFrames(): TraceFrame[] {
  return [
    { t_ms: 0, seq: 0, raw: '', event: { type: 'tool-call-delta', id: 'c1', name: 'save', argsDelta: '{"title":"x","n":1}' } },
    { t_ms: 10, seq: 1, raw: '', event: { type: 'finish' } },
  ];
}

describe('fault DSL parsing', () => {
  it('parses every supported fault', () => {
    const faults = parseScenario(
      'drop(3), drop(2..5), dup(7), truncate_tool_args(12), truncate_tool_args(12,4), disconnect_at(0.62), error(429), error(429,5), slow(800), slow(800,3), reorder(2,5)',
    );
    expect(faults).toEqual([
      { kind: 'drop', index: 3 },
      { kind: 'drop', from: 2, to: 5 },
      { kind: 'dup', index: 7 },
      { kind: 'truncate_tool_args', atByte: 12 },
      { kind: 'truncate_tool_args', atByte: 12, index: 4 },
      { kind: 'disconnect_at', ratio: 0.62 },
      { kind: 'error', status: 429 },
      { kind: 'error', status: 429, index: 5 },
      { kind: 'slow', ms: 800 },
      { kind: 'slow', ms: 800, index: 3 },
      { kind: 'reorder', a: 2, b: 5 },
    ]);
  });

  it('accepts semicolons and arrays', () => {
    expect(parseScenario(['drop(1);dup(2)', 'slow(5)'])).toHaveLength(3);
  });

  it('formats back to a canonical string', () => {
    const text = 'drop(2..5), dup(7), truncate_tool_args(12,4), disconnect_at(0.62), error(429,5), slow(800,3), reorder(2,5)';
    expect(formatScenario(parseScenario(text))).toBe(text);
  });

  it('rejects bad input with a clear error', () => {
    expect(() => parseScenario('explode(3)')).toThrow(FaultSyntaxError);
    expect(() => parseScenario('drop(-1)')).toThrow(/non-negative/);
    expect(() => parseScenario('drop(1,2)')).toThrow(/takes 1 argument/);
    expect(() => parseScenario('disconnect_at(1)')).toThrow(/between 0 and 1/);
    expect(() => parseScenario('reorder(1)')).toThrow(/takes 2 argument/);
    expect(() => parseScenario('drop')).toThrow(/takes 1 argument/);
  });
});

describe('applyFaults', () => {
  it('returns the trace untouched without faults', () => {
    const input = frames(3);
    const result = applyFaults(input, [], { meta });
    expect(result.frames).toHaveLength(3);
    expect(result.outcome).toBe('complete');
    expect(result.effects).toEqual([]);
  });

  it('drops a single frame and a range', () => {
    const dropped = applyFaults(frames(5), parseScenario('drop(1)'), { meta });
    expect(dropped.frames.map((f) => f.event.delta)).toEqual(['0', '2', '3', '4']);
    const range = applyFaults(frames(5), parseScenario('drop(1..3)'), { meta });
    expect(range.frames.map((f) => f.event.delta)).toEqual(['0', '4']);
  });

  it.each([
    'drop(1),drop(3)',
    'drop(3),drop(1)',
    'drop(1..1),drop(3..3)',
    'drop(3..3),drop(1..1)',
  ])('resolves multiple drops against original indices: %s', (scenario) => {
    const result = applyFaults(frames(6), parseScenario(scenario), { meta });
    expect(result.frames.map((frame) => frame.event.delta)).toEqual(['0', '2', '4', '5']);
    expect(result.effects.every((effect) => effect.endsWith('removed 1 frame(s)'))).toBe(true);
  });

  it('treats repeated and overlapping drops as a union without shifting later ranges', () => {
    const result = applyFaults(frames(8), parseScenario('drop(1..3),drop(2..4),drop(1)'), { meta });
    expect(result.frames.map((frame) => frame.event.delta)).toEqual(['0', '5', '6', '7']);
    expect(result.effects).toEqual([
      'drop(1..3): removed 3 frame(s)',
      'drop(2..4): removed 1 frame(s)',
      'drop(1): removed 0 frame(s)',
    ]);
  });

  it('uses recorded positions even when frame sequence numbers are not contiguous', () => {
    const input = frames(6).map((frame, index) => ({ ...frame, seq: 100 + index * 7 }));
    const result = applyFaults(input, parseScenario('drop(1),drop(3)'), { meta });
    expect(result.frames.map((frame) => frame.event.delta)).toEqual(['0', '2', '4', '5']);
    expect(input.map((frame) => frame.seq)).toEqual([100, 107, 114, 121, 128, 135]);
  });

  it('does not resurrect a dropped frame when dup targets the same recorded frame', () => {
    for (const scenario of ['drop(1),dup(1)', 'dup(1),drop(1)']) {
      const result = applyFaults(frames(4), parseScenario(scenario), { meta });
      expect(result.frames.map((frame) => frame.event.delta)).toEqual(['0', '2', '3']);
      expect(result.effects).toContain('dup(1): skipped dropped frame #1');
    }
  });

  it('preserves original targets across drop, dup, reorder, and slow', () => {
    const a = applyFaults(frames(6), parseScenario('drop(1),drop(3),dup(4),reorder(2,5),slow(10,2)'), { meta });
    const b = applyFaults(frames(6), parseScenario('slow(10,2),reorder(2,5),dup(4),drop(3),drop(1)'), { meta });
    expect(a.frames.map((frame) => frame.event.delta)).toEqual(['0', '5', '4', '4', '2']);
    expect(b.frames).toEqual(a.frames);
    expect(a.frames.at(-1)?.delay_ms).toBe(10);
  });

  it('duplicates already truncated tool arguments without restoring the original data', () => {
    const input = toolFrames();
    const result = applyFaults(input, parseScenario('truncate_tool_args(6,0),dup(0)'), { meta });
    expect(result.frames.slice(0, 2).map((frame) => frame.event.argsDelta)).toEqual(['{"titl', '{"titl']);
    expect(result.frames[0]?.raw).toBe(result.frames[1]?.raw);
    expect(input[0]?.event.argsDelta).toBe('{"title":"x","n":1}');
  });

  it('duplicates a frame right after the original', () => {
    const result = applyFaults(frames(3), parseScenario('dup(1)'), { meta });
    expect(result.frames.map((f) => f.event.delta)).toEqual(['0', '1', '1', '2']);
    expect(result.frames.map((f) => f.seq)).toEqual([0, 1, 2, 3]);
  });

  it('reorders two frames', () => {
    const result = applyFaults(frames(4), parseScenario('reorder(1,3)'), { meta });
    expect(result.frames.map((f) => f.event.delta)).toEqual(['0', '3', '2', '1']);
  });

  it('truncates tool arguments and re-encodes the wire frame', () => {
    const result = applyFaults(toolFrames(), parseScenario('truncate_tool_args(6)'), { meta });
    const event = result.frames[0]?.event;
    expect(event?.argsDelta).toBe('{"titl');
    expect(event?.complete).toBe(false);
    expect(result.frames[0]?.raw).toContain('tool-input-delta');
    expect(result.effects[0]).toContain('cut 1 tool-argument');
  });

  it('only truncates the requested frame when an index is given', () => {
    const input = toolFrames();
    input[1] = { t_ms: 10, seq: 1, raw: '', event: { type: 'tool-call-delta', id: 'c2', argsDelta: '{"b":2}' } };
    const result = applyFaults(input, parseScenario('truncate_tool_args(3,1)'), { meta });
    expect(result.frames[0]?.event.argsDelta).toBe('{"title":"x","n":1}');
    expect(result.frames[1]?.event.argsDelta).toBe('{"b');
  });

  it('disconnects after a ratio of the frames', () => {
    const result = applyFaults(frames(10), parseScenario('disconnect_at(0.62)'), { meta });
    expect(result.frames).toHaveLength(6);
    expect(result.outcome).toBe('disconnect');
    expect(result.effects.join()).toContain('kept 6/10');
  });

  it('appends an error frame and reports the status', () => {
    const result = applyFaults(frames(3), parseScenario('error(429)'), { meta });
    expect(result.outcome).toBe('error');
    expect(result.status).toBe(429);
    expect(result.frames).toHaveLength(4);
    expect(result.frames[3]).toMatchObject({ injected: true, event: { type: 'error', status: 429 } });
    expect(result.frames[3]?.raw).toContain('"statusCode":429');
  });

  it('cuts the stream at an error index', () => {
    const result = applyFaults(frames(5), parseScenario('error(500,2)'), { meta });
    expect(result.frames.map((f) => f.event.type)).toEqual(['text-delta', 'text-delta', 'error']);
  });

  it('adds per-frame delays for slow()', () => {
    const all = applyFaults(frames(3), parseScenario('slow(100)'), { meta });
    expect(all.frames.map((f) => f.delay_ms)).toEqual([100, 100, 100]);
    const one = applyFaults(frames(3), parseScenario('slow(100,1)'), { meta });
    expect(one.frames.map((f) => f.delay_ms ?? 0)).toEqual([0, 100, 0]);
  });

  it('is independent of the order faults are written in', () => {
    const a = applyFaults(frames(8), parseScenario('drop(1),dup(5),slow(10,2)'), { meta });
    const b = applyFaults(frames(8), parseScenario('slow(10,2),dup(5),drop(1)'), { meta });
    expect(b.frames.map((f) => f.event.delta)).toEqual(a.frames.map((f) => f.event.delta));
    expect(b.frames.map((f) => f.delay_ms ?? 0)).toEqual(a.frames.map((f) => f.delay_ms ?? 0));
  });

  it('throws a range error for an index that does not exist', () => {
    expect(() => applyFaults(frames(3), parseScenario('drop(9)'), { meta })).toThrow(/out of range/);
  });

  it('keeps an encoder for NDJSON traces', () => {
    const input: TraceFrame[] = [
      { t_ms: 0, seq: 0, raw: '9:{"toolCallId":"c","toolName":"t","args":{"a":1}}', event: { type: 'tool-call-delta', id: 'c', name: 't', argsDelta: '{"a":1}', complete: true } },
      { t_ms: 1, seq: 1, raw: 'd:{"finishReason":"stop"}', event: { type: 'finish' } },
    ];
    const result = applyFaults(input, parseScenario('truncate_tool_args(3)'), {
      meta: { framing: 'ndjson', protocol: 'ai-sdk-data' },
      encode: defaultEncoder({ framing: 'ndjson', protocol: 'ai-sdk-data' }),
    });
    expect(result.frames[0]?.raw.startsWith('9:')).toBe(true);
    expect(result.frames[0]?.raw.endsWith('\n')).toBe(true);
  });
});

describe('truncateUtf8', () => {
  it('does not split a multibyte character', () => {
    expect(truncateUtf8('한글', 1)).toBe('');
    expect(truncateUtf8('한글', 3)).toBe('한');
    expect(truncateUtf8('한글', 4)).toBe('한');
    expect(truncateUtf8('abc', 10)).toBe('abc');
    expect(truncateUtf8('abc', 0)).toBe('');
  });

  it('works with the adapter framing', () => {
    const adapter = createAdapter({ contentType: 'text/event-stream' });
    expect(adapter.framing).toBe('sse');
  });
});
