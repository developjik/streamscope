import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMiddleware, startRecordingProxy } from '../src/proxy.js';
import { readTrace } from '../src/trace.js';
import type { Trace } from '../src/types.js';

const closers: Array<() => Promise<void> | void> = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'streamscope-proxy-'));
  dirs.push(dir);
  return dir;
}

/** A tiny upstream app: SSE chat + a PNG asset. */
async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/chat')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const frames = [
        { type: 'start', messageId: 'm1' },
        { type: 'text-delta', id: 'm1', delta: 'Hello ' },
        { type: 'text-delta', id: 'm1', delta: 'world' },
        { type: 'finish', finishReason: 'stop' },
      ];
      let i = 0;
      const timer = setInterval(() => {
        if (i >= frames.length) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify(frames[i])}\n\n`);
        i += 1;
      }, 5);
      return;
    }
    if (req.url === '/logo.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

describe('recording proxy', () => {
  it('passes the response through unchanged and records the stream', async () => {
    const upstream = await startUpstream();
    closers.push(upstream.close);
    const dir = await tmpDir();
    let session: Trace | undefined;

    const proxy = await startRecordingProxy({
      target: upstream.url,
      port: 0,
      outDir: dir,
      onSession: (trace) => {
        session = trace;
      },
    });
    closers.push(proxy.close);

    const response = await fetch(`${proxy.url}/api/chat`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"Hello "');
    expect(body.trim().split('\n\n')).toHaveLength(4);

    const started = Date.now();
    while (!session && Date.now() - started < 3000) await new Promise((r) => setTimeout(r, 20));
    expect(session).toBeDefined();
    const trace = await readTrace(session!.path!);
    expect(trace.meta.adapter).toBe('ai-sdk');
    expect(trace.meta.request?.url).toContain('/api/chat');
    expect(trace.frames.map((f) => f.event.type)).toEqual(['run-start', 'text-delta', 'text-delta', 'finish']);
    expect(trace.frames[1]?.event.delta).toBe('Hello ');
    expect(trace.meta.response?.status).toBe(200);
  });

  it('does not record static assets', async () => {
    const upstream = await startUpstream();
    closers.push(upstream.close);
    const dir = await tmpDir();
    const sessions: Trace[] = [];
    const proxy = await startRecordingProxy({
      target: upstream.url,
      port: 0,
      outDir: dir,
      onSession: (trace) => sessions.push(trace),
    });
    closers.push(proxy.close);

    const response = await fetch(`${proxy.url}/logo.png`);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect((await response.arrayBuffer()).byteLength).toBe(4);
    await new Promise((r) => setTimeout(r, 200));
    expect(sessions).toHaveLength(0);
  });

  it('returns 502 when the target is unreachable', async () => {
    const dir = await tmpDir();
    const proxy = await startRecordingProxy({ target: 'http://127.0.0.1:1', port: 0, outDir: dir });
    closers.push(proxy.close);
    const response = await fetch(`${proxy.url}/api/chat`);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('could not reach target');
  });

  it('works as an Express-style middleware', async () => {
    const upstream = await startUpstream();
    closers.push(upstream.close);
    const dir = await tmpDir();
    const middleware = createMiddleware({ target: upstream.url, outDir: dir });
    const server = http.createServer((req, res) => middleware(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    );
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('world');
  });
});
