import { describe, expect, it } from 'vitest';
import { SseParser, formatSseMessage } from '../src/adapters/sse.js';

describe('SseParser', () => {
  it('parses one message split across arbitrary chunk boundaries', () => {
    const parser = new SseParser();
    const messages = [
      ...parser.push('da'),
      ...parser.push('ta: {"type":"text-del'),
      ...parser.push('ta","delta":"hi"}\n'),
      ...parser.push('\n'),
    ];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.data).toBe('{"type":"text-delta","delta":"hi"}');
    expect(messages[0]?.raw).toBe('data: {"type":"text-delta","delta":"hi"}\n\n');
  });

  it('handles CRLF and lone CR line endings', () => {
    const parser = new SseParser();
    expect(parser.push('data: a\r\n\r\n')).toHaveLength(1);
    // A trailing lone CR could be the start of CRLF, so it waits for more input.
    expect(parser.push('data: b\r\r')).toHaveLength(0);
    expect(parser.flush()).toHaveLength(1);
  });

  it('keeps a trailing CR for the next chunk', () => {
    const parser = new SseParser();
    expect(parser.push('data: x\r')).toEqual([]);
    const messages = parser.push('\n\n');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.data).toBe('x');
  });

  it('joins multi-line data fields with newlines', () => {
    const parser = new SseParser();
    const messages = parser.push('data: line1\ndata: line2\n\n');
    expect(messages[0]?.data).toBe('line1\nline2');
  });

  it('ignores comments and unknown fields', () => {
    const parser = new SseParser();
    const messages = parser.push(': heartbeat\nfoo: bar\ndata: hello\n\n');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.data).toBe('hello');
  });

  it('reads event, id and retry fields', () => {
    const parser = new SseParser();
    const messages = parser.push('id: 7\nevent: text-delta\nretry: 500\ndata: {}\n\n');
    expect(messages[0]).toMatchObject({ id: '7', event: 'text-delta', retry: 500, data: '{}' });
  });

  it('flushes a message that lacks the final blank line', () => {
    const parser = new SseParser();
    expect(parser.push('data: tail')).toEqual([]);
    const flushed = parser.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.data).toBe('tail');
  });

  it('round-trips through formatSseMessage', () => {
    const raw = formatSseMessage({ event: 'x', data: 'a\nb' });
    expect(raw).toBe('event: x\ndata: a\ndata: b\n\n');
    const parser = new SseParser();
    const messages = parser.push(raw);
    expect(messages[0]?.data).toBe('a\nb');
    expect(messages[0]?.event).toBe('x');
  });
});
