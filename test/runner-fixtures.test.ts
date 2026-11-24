import { describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createTraceFetch, toMatchTrace } from '../src/vitest.js';
import { interceptTrace } from '../src/cypress.js';
import { parseTrace } from '../src/trace.js';
import { createAdapter } from '../src/adapters/index.js';
expect.extend({ toMatchTrace });
const trace = () => parseTrace([
  JSON.stringify({ v: 1, kind: 'meta', session: 'fixture', adapter: 'sse', framing: 'sse', protocol: 'generic', startedAt: '2026-01-01T00:00:00Z', response: { contentType: 'text/event-stream' } }),
  JSON.stringify({ seq: 0, t_ms: 0, raw: 'data: hello\n\n', event: { type: 'text-delta', delta: 'hello' } }),
  JSON.stringify({ seq: 1, t_ms: 2, raw: 'data: world\n\n', event: { type: 'text-delta', delta: 'world' } }),
].join('\n'));

describe('recording-backed runner fixtures', () => {
  test('replays SSE through fetch and identifies the exact mismatching frame', async () => {
    const t = trace();
    const fetch = createTraceFetch(t, { url: '/chat' });
    const response = await fetch('/chat');
    const adapter = createAdapter({ contentType: response.headers.get('content-type')! });
    const reader = response.body!.getReader();
    const events = [];
    while (true) { const chunk = await reader.read(); if (chunk.done) break; events.push(...adapter.feed(chunk.value)); }
    events.push(...adapter.flush());
    const replay = events.map((frame, seq) => ({ ...frame, seq, t_ms: 0 }));
    expect(replay).toMatchTrace(t);
    replay[1]!.event.delta = 'broken';
    const mismatch = toMatchTrace(replay, t);
    expect(mismatch.pass).toBe(false);
    expect(mismatch.message()).toContain('frame 1');
    await expect(fetch('/other')).rejects.toThrow('No recorded response');
  });
  test('loads a real recording file, preserves wire bytes and supports fallback', async () => {
    const t = parseTrace(await readFile('demo/traces/chat-ag-ui.jsonl', 'utf8'));
    const fallback = vi.fn(async () => new Response('fallback'));
    const fetch = createTraceFetch(t, { url: /\/chat/g, fallback });
    for (let i = 0; i < 2; i++) expect(await (await fetch('/chat')).text()).toBe(t.frames.map(f => f.raw).join(''));
    expect(await (await fetch('/other')).text()).toBe('fallback');
    expect(fallback).toHaveBeenCalledOnce();
  });
  test('Cypress helper returns the chain and replies with recorded response', () => {
    const t = trace(); let handler: Parameters<Parameters<typeof interceptTrace>[0]['intercept']>[1] | undefined;
    const chain = {};
    const cy = { intercept: vi.fn((_url: string | RegExp, callback: NonNullable<typeof handler>) => { handler = callback; return chain; }) };
    expect(interceptTrace(cy, '/chat', t)).toBe(chain);
    const reply = vi.fn(); handler!({ reply });
    expect(reply).toHaveBeenCalledWith({ statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: 'data: hello\n\ndata: world\n\n' });
  });
  test('supports abort and validates replay timing', async () => {
    const signal = AbortSignal.abort();
    await expect(createTraceFetch(trace())('/chat', { signal })).rejects.toThrow();
    expect(() => createTraceFetch(trace(), { speed: -1 })).toThrow();
  });
});


test('NDJSON fixture restores record separators for fetch and Cypress', async () => {
  const t = parseTrace(await readFile('demo/traces/chat-ndjson.jsonl', 'utf8'));
  const response = await createTraceFetch(t)('/chat');
  const body = await response.text();
  expect(body.trim().split('\n').map(line => JSON.parse(line))).toHaveLength(t.frames.length);
  let actual = ''; const cy = { intercept: (_: string | RegExp, handler: (req: {reply: (response: {body: string}) => void}) => void) => handler({reply: response => {actual = response.body;}}) };
  interceptTrace(cy, '/chat', t); expect(actual).toBe(body);
});
test('null-body statuses return a valid fetch response', async () => {
  const t = trace(); t.meta.response = {status:204};t.frames=[];
  expect((await createTraceFetch(t)('/chat')).body).toBeNull();
});
test('matcher ignores property order but not values', () => {
  const t=trace();const other=structuredClone(t);other.frames[0]!.event={delta:'hello',type:'text-delta'};
  expect(toMatchTrace(other,t).pass).toBe(true);
});
