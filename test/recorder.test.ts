import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Recorder, recordStream } from '../src/recorder.js';
import { parseTrace, readTrace, summarize, traceToJsonl } from '../src/trace.js';
import type { Trace } from '../src/types.js';

const dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'streamscope-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function* chunks(...values: string[]): AsyncGenerator<string> {
  for (const value of values) yield value;
}

const SSE_TRACE = [
  'data: {"type":"start","messageId":"m1"}\n\n',
  'data: {"type":"text-delta","id":"m1","delta":"Hel',
  'lo"}\n\n',
  'data: {"type":"tool-input-delta","toolCallId":"c1","inputTextDelta":"{\\"a\\":"}\n\n',
  'data: {"type":"tool-output-available","toolCallId":"c1","output":{"ok":true}}\n\n',
  'data: {"type":"finish","finishReason":"stop"}\n\n',
];

describe('Recorder', () => {
  it('writes meta + frames to .streams/<session>/events.jsonl', async () => {
    const dir = await tmpDir();
    let clock = 1000;
    const trace = await recordStream(chunks(...SSE_TRACE), {
      dir,
      session: 'session-1',
      adapter: { contentType: 'text/event-stream' },
      request: { method: 'POST', url: 'http://app.test/api/chat' },
      now: () => (clock += 5),
    });

    const file = path.join(dir, 'session-1', 'events.jsonl');
    expect(await fs.readFile(file, 'utf8')).toContain('"kind":"meta"');
    expect(trace.frames).toHaveLength(5);
    expect(trace.frames.map((f) => f.event.type)).toEqual([
      'run-start',
      'text-delta',
      'tool-call-delta',
      'tool-result',
      'finish',
    ]);
    const deltas = trace.frames.filter((f) => f.event.type === 'text-delta');
    expect(deltas.map((f) => f.event.delta)).toEqual(['Hello']);

    const reread = await readTrace(file);
    expect(reread.meta.session).toBe('session-1');
    expect(reread.meta.adapter).toBe('ai-sdk');
    expect(reread.meta.framing).toBe('sse');
    expect(reread.meta.request?.url).toBe('http://app.test/api/chat');
    expect(reread.frames).toHaveLength(5);
    expect(reread.frames[1]?.event.delta).toBe('Hello');
  });

  it('never lets t_ms decrease and numbers frames monotonically', async () => {
    const dir = await tmpDir();
    const stamps = [500, 510, 505, 505, 900];
    let i = 0;
    const trace = await recordStream(chunks(...SSE_TRACE), {
      dir,
      adapter: { contentType: 'text/event-stream' },
      now: () => stamps[i++] ?? 900,
    });
    const times = trace.frames.map((f) => f.t_ms);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(trace.frames.map((f) => f.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it('flushes a partial SSE frame at the end', async () => {
    const dir = await tmpDir();
    const trace = await recordStream(chunks('data: {"type":"text-delta","delta":"tail"}'), {
      dir,
      adapter: { contentType: 'text/event-stream' },
    });
    expect(trace.frames).toHaveLength(1);
    expect(trace.frames[0]?.event.delta).toBe('tail');
  });

  it('exposes the recorder API directly', async () => {
    const dir = await tmpDir();
    const recorder = new Recorder({ dir, session: 's2', adapter: { framing: 'ndjson' } });
    await recorder.begin();
    const frames = await recorder.push('0:"a"\n0:"b"\n');
    expect(frames).toHaveLength(2);
    const trace = await recorder.end({ status: 200, contentType: 'application/x-ndjson' });
    expect(trace.meta.adapter).toBe('ai-sdk-data');
    expect(trace.frames).toHaveLength(2);
    expect(trace.meta.response?.status).toBe(200);
  });
});

describe('trace IO', () => {
  it('round-trips a trace through JSONL', () => {
    const trace: Trace = {
      meta: {
        v: 1,
        kind: 'meta',
        session: 's',
        adapter: 'ai-sdk',
        framing: 'sse',
        protocol: 'ai-sdk',
        startedAt: '2026-01-01T00:00:00.000Z',
      },
      frames: [
        { t_ms: 0, seq: 0, raw: 'data: {}\n\n', event: { type: 'text-delta', delta: 'a' } },
        { t_ms: 10, seq: 1, raw: 'data: {}\n\n', event: { type: 'finish' } },
      ],
    };
    const parsed = parseTrace(traceToJsonl(trace));
    expect(parsed.meta).toEqual(trace.meta);
    expect(parsed.frames).toEqual(trace.frames);
  });

  it('ignores a truncated trailing line', () => {
    const text = '{"kind":"meta","session":"s","adapter":"a","framing":"sse","protocol":"generic","startedAt":"x","v":1}\n{"t_ms":0,"seq":0,"raw":"x","event":{"type":"finish"}}\n{"t_ms":1,"seq":1,"ra';
    const parsed = parseTrace(text);
    expect(parsed.frames).toHaveLength(1);
  });

  it('summarizes text, tools, approvals, errors and gaps', () => {
    const trace: Trace = {
      meta: {
        v: 1,
        kind: 'meta',
        session: 's',
        adapter: 'ai-sdk',
        framing: 'sse',
        protocol: 'ai-sdk',
        startedAt: '2026-01-01T00:00:00.000Z',
      },
      frames: [
        { t_ms: 0, seq: 0, raw: '', event: { type: 'text-delta', delta: 'ab' } },
        { t_ms: 10, seq: 1, raw: '', event: { type: 'tool-call-delta', id: 'c1', name: 't', argsDelta: '{"a":' } },
        { t_ms: 3000, seq: 2, raw: '', event: { type: 'tool-call-delta', id: 'c1', argsDelta: '1}' } },
        { t_ms: 3010, seq: 3, raw: '', event: { type: 'tool-result', id: 'c1', result: {} } },
        { t_ms: 3020, seq: 4, raw: '', event: { type: 'approval', id: 'ap', decision: 'requested' } },
        { t_ms: 3030, seq: 5, raw: '', event: { type: 'error', message: 'boom' } },
      ],
    };
    const summary = summarize(trace);
    expect(summary.text).toBe('ab');
    expect(summary.textChars).toBe(2);
    expect(summary.toolCalls).toEqual([{ id: 'c1', name: 't', argsBytes: 7, argsComplete: true, resultSeen: true }]);
    expect(summary.approvals).toBe(1);
    expect(summary.errors).toEqual(['boom']);
    expect(summary.gaps).toEqual([{ afterSeq: 1, ms: 2990 }]);
    expect(summary.terminal).toBe('error');
    expect(summary.durationMs).toBe(3030);
  });
});
