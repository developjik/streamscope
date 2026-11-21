import { describe, expect, it } from 'vitest';
import { classifyPayload, encodeEvent } from '../src/adapters/protocols.js';
import { createAdapter } from '../src/adapters/index.js';

describe('protocol classification', () => {
  it('maps AI SDK UI message chunks', () => {
    expect(classifyPayload('{"type":"text-delta","id":"m1","delta":"Hi"}')).toMatchObject({
      protocol: 'ai-sdk',
      events: [{ type: 'text-delta', id: 'm1', delta: 'Hi' }],
    });
    expect(classifyPayload('{"type":"tool-input-delta","toolCallId":"c1","inputTextDelta":"{\\"ord"}')).toMatchObject({
      protocol: 'ai-sdk',
      events: [{ type: 'tool-call-delta', id: 'c1', argsDelta: '{"ord' }],
    });
    expect(classifyPayload('{"type":"tool-input-available","toolCallId":"c1","toolName":"t","input":{"a":1}}')).toMatchObject({
      events: [{ type: 'tool-call-delta', complete: true, name: 't' }],
    });
    expect(classifyPayload('{"type":"tool-output-available","toolCallId":"c1","output":{"ok":true}}')).toMatchObject({
      events: [{ type: 'tool-result', id: 'c1', result: { ok: true } }],
    });
    expect(classifyPayload('{"type":"error","errorText":"boom"}')).toMatchObject({
      events: [{ type: 'error', message: 'boom' }],
    });
    expect(classifyPayload('{"type":"finish","finishReason":"length"}')).toMatchObject({
      events: [{ type: 'finish', reason: 'length' }],
    });
  });

  it('maps AG-UI events', () => {
    expect(classifyPayload('{"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"yo"}')).toMatchObject({
      protocol: 'ag-ui',
      events: [{ type: 'text-delta', id: 'm1', delta: 'yo' }],
    });
    expect(classifyPayload('{"type":"TOOL_CALL_START","toolCallId":"tc1","toolCallName":"track"}')).toMatchObject({
      events: [{ type: 'tool-call-delta', id: 'tc1', name: 'track', argsDelta: '' }],
    });
    expect(classifyPayload('{"type":"TOOL_CALL_ARGS","toolCallId":"tc1","delta":"{\\"a\\":1}"}')).toMatchObject({
      events: [{ type: 'tool-call-delta', argsDelta: '{"a":1}' }],
    });
    expect(classifyPayload('{"type":"TOOL_CALL_RESULT","toolCallId":"tc1","content":"{\\"ok\\":true}"}')).toMatchObject({
      events: [{ type: 'tool-result', result: { ok: true } }],
    });
    expect(classifyPayload('{"type":"RUN_ERROR","message":"nope"}')).toMatchObject({
      events: [{ type: 'error', message: 'nope' }],
    });
    expect(classifyPayload('{"type":"RUN_FINISHED"}')).toMatchObject({ events: [{ type: 'finish' }] });
  });

  it('maps the legacy AI SDK data stream', () => {
    expect(classifyPayload('0:"hello"')).toMatchObject({
      protocol: 'ai-sdk-data',
      events: [{ type: 'text-delta', delta: 'hello' }],
    });
    expect(classifyPayload('9:{"toolCallId":"c1","toolName":"t","args":{"a":1}}')).toMatchObject({
      events: [{ type: 'tool-call-delta', complete: true, argsDelta: '{"a":1}' }],
    });
    expect(classifyPayload('a:{"toolCallId":"c1","result":{"ok":1}}')).toMatchObject({
      events: [{ type: 'tool-result', result: { ok: 1 } }],
    });
    expect(classifyPayload('3:"rate limited"')).toMatchObject({ events: [{ type: 'error', message: 'rate limited' }] });
    expect(classifyPayload('d:{"finishReason":"stop"}')).toMatchObject({ events: [{ type: 'finish', reason: 'stop' }] });
  });

  it('falls back to generic JSON and plain text', () => {
    expect(classifyPayload('{"delta":"x","id":"a"}')).toMatchObject({
      protocol: 'generic',
      events: [{ type: 'text-delta', delta: 'x' }],
    });
    expect(classifyPayload('{"error":"bad"}')).toMatchObject({ events: [{ type: 'error', message: 'bad' }] });
    expect(classifyPayload('plain words')).toMatchObject({ events: [{ type: 'text-delta', delta: 'plain words' }] });
    expect(classifyPayload('   ')).toMatchObject({ events: [] });
  });

  it('round-trips normalized events through encodeEvent', () => {
    const cases: Array<[string, Parameters<typeof encodeEvent>[1]]> = [
      ['{"type":"text-delta","id":"m","delta":"a"}', 'ai-sdk'],
      ['{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"a"}', 'ag-ui'],
      ['0:"a"', 'ai-sdk-data'],
      ['{"delta":"a"}', 'generic'],
    ];
    for (const [payload, protocol] of cases) {
      const event = classifyPayload(payload).events[0]!;
      const encoded = encodeEvent(event, protocol);
      const again = classifyPayload(encoded).events[0]!;
      expect(again.type).toBe('text-delta');
      expect(again.delta).toBe('a');
    }
  });
});

describe('createAdapter', () => {
  it('detects SSE framing and the AI SDK protocol from the content type', () => {
    const adapter = createAdapter({ contentType: 'text/event-stream; charset=utf-8' });
    const frames = adapter.feed('data: {"type":"text-delta","delta":"a"}\n\ndata: {"type":"finish"}\n\n');
    expect(frames).toHaveLength(2);
    expect(adapter.framing).toBe('sse');
    expect(adapter.protocol).toBe('ai-sdk');
    expect(adapter.label).toBe('ai-sdk');
  });

  it('detects NDJSON framing when no content type is known', () => {
    const adapter = createAdapter();
    const frames = adapter.feed('0:"a"\n0:"b"\n');
    expect(frames.map((f) => f.event.delta)).toEqual(['a', 'b']);
    expect(adapter.framing).toBe('ndjson');
    expect(adapter.protocol).toBe('ai-sdk-data');
  });

  it('treats a plain text stream as raw text deltas', () => {
    const adapter = createAdapter();
    const frames = adapter.feed('hello ');
    expect(frames[0]?.event).toMatchObject({ type: 'text-delta', delta: 'hello ' });
    expect(adapter.framing).toBe('raw');
  });

  it('encodes frames in the detected framing', () => {
    const adapter = createAdapter({ contentType: 'text/event-stream' });
    adapter.feed('data: {"type":"text-delta","delta":"a"}\n\n');
    expect(adapter.encode({ type: 'text-delta', delta: 'b' })).toBe('data: {"type":"text-delta","id":"text-0","delta":"b"}\n\n');
    expect(adapter.encodeError(429)).toContain('"statusCode":429');
  });
});
