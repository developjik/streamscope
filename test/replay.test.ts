import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { frameDelayMs, prepareReplay, startReplayServer, streamReplay } from '../src/replay.js';
import { readTrace } from '../src/trace.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'demo', 'traces', 'chat-ai-sdk.jsonl');

function collect(plan: ReturnType<typeof prepareReplay>): Promise<string[]> {
  return (async () => {
    const out: string[] = [];
    for await (const item of streamReplay(plan, { speed: 0 })) out.push(item.text);
    return out;
  })();
}

describe('replay engine', () => {
  it('prepares an injected plan with effects', async () => {
    const trace = await readTrace(fixture);
    const plan = prepareReplay(trace, { inject: 'drop(3),disconnect_at(0.62)' });
    expect(plan.frames.length).toBeLessThan(trace.frames.length);
    expect(plan.outcome).toBe('disconnect');
    expect(plan.effects.length).toBe(2);
    expect(plan.faults).toHaveLength(2);
  });

  it('streams every frame in order at speed 0', async () => {
    const trace = await readTrace(fixture);
    const plan = prepareReplay(trace);
    const texts = await collect(plan);
    expect(texts).toHaveLength(trace.frames.length);
    expect(texts.join('')).toBe(trace.frames.map((f) => f.raw).join(''));
  });

  it('scales and caps frame delays', async () => {
    const trace = await readTrace(fixture);
    const plan = prepareReplay(trace);
    const slow = prepareReplay(trace, { inject: 'slow(1000)' });
    expect(frameDelayMs(slow, 1, { speed: 1 })).toBeGreaterThan(900);
    expect(frameDelayMs(slow, 1, { speed: 10 })).toBeLessThan(400);
    expect(frameDelayMs(plan, 0, { speed: 0 })).toBe(0);
    expect(frameDelayMs(slow, 1, { speed: 1, maxDelayMs: 500 })).toBe(500);
  });
});

describe('replay server', () => {
  it('serves the recorded stream, the panel and the plan', async () => {
    const trace = await readTrace(fixture);
    const server = await startReplayServer({ trace, speed: 0 });
    try {
      const res = await fetch(server.streamUrl);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(res.headers.get('x-streamscope-outcome')).toBe('complete');
      const body = await res.text();
      expect(body).toBe(trace.frames.map((f) => f.raw).join(''));

      const panel = await fetch(server.url);
      expect(panel.status).toBe(200);
      expect(await panel.text()).toContain('id="scrub"');

      const plan = (await (await fetch(`${server.url}trace.json`)).json()) as { frames: unknown[]; outcome: string };
      expect(plan.frames).toHaveLength(trace.frames.length);
      expect(plan.outcome).toBe('complete');

      const health = (await (await fetch(`${server.url}health`)).json()) as { ok: boolean };
      expect(health.ok).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('serves an injected stream ending in an error frame', async () => {
    const trace = await readTrace(fixture);
    const server = await startReplayServer({ trace, speed: 0, inject: 'error(429)' });
    try {
      const res = await fetch(server.streamUrl);
      expect(res.headers.get('x-streamscope-outcome')).toBe('error');
      const body = await res.text();
      expect(body).toContain('429');
    } finally {
      await server.close();
    }
  });

  it('answers with a plain HTTP error when the first frame is the injected error', async () => {
    const trace = await readTrace(fixture);
    const server = await startReplayServer({ trace, speed: 0, inject: 'error(503,0)' });
    try {
      const res = await fetch(server.streamUrl);
      expect(res.status).toBe(503);
      expect(await res.text()).toContain('503');
    } finally {
      await server.close();
    }
  });

  it('drops the connection for disconnect_at', async () => {
    const trace = await readTrace(fixture);
    const server = await startReplayServer({ trace, speed: 0, inject: 'disconnect_at(0.5)' });
    try {
      const result = await new Promise<{ bytes: number; aborted: boolean }>((resolve) => {
        const request = http.get(server.streamUrl, (res) => {
          let bytes = 0;
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
          });
          res.on('aborted', () => resolve({ bytes, aborted: true }));
          res.on('end', () => resolve({ bytes, aborted: false }));
          res.on('error', () => resolve({ bytes, aborted: true }));
        });
        request.on('error', () => resolve({ bytes: 0, aborted: true }));
      });
      const full = trace.frames.map((f) => f.raw).join('').length;
      expect(result.bytes).toBeLessThan(full);
      expect(result.aborted).toBe(true);
    } finally {
      await server.close();
    }
  });
});
