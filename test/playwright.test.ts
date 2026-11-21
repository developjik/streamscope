import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { replayStream, waitForReplayRequest, type PageLike, type RouteLike } from '../src/playwright.js';
import { readTrace } from '../src/trace.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'demo', 'traces', 'chat-ai-sdk.jsonl');

interface FakePage extends PageLike {
  routes: Array<{ pattern: string | RegExp; handler: (route: RouteLike) => unknown }>;
  unrouted: number;
}

function fakePage(): FakePage {
  const page: FakePage = {
    routes: [],
    unrouted: 0,
    route(pattern, handler) {
      page.routes.push({ pattern, handler });
    },
    unroute() {
      page.unrouted += 1;
    },
  };
  return page;
}

describe('replayStream (Playwright fixture)', () => {
  it('reroutes the request to a local streaming replay server', async () => {
    const page = fakePage();
    const handle = await replayStream(page, fixture, { url: '**/api/chat', inject: 'drop(3)' });
    expect(page.routes).toHaveLength(1);
    expect(page.routes[0]?.pattern).toBe('**/api/chat');

    const calls: Array<{ url?: string }> = [];
    await page.routes[0]?.handler({
      continue: async (options) => {
        calls.push(options ?? {});
      },
    });
    expect(handle.requests).toBe(1);
    expect(calls[0]?.url).toBe(handle.streamUrl);

    const response = await fetch(handle.streamUrl);
    const body = await response.text();
    const trace = await readTrace(fixture);
    expect(body.length).toBeLessThan(trace.frames.map((f) => f.raw).join('').length);
    expect(handle.plan.effects[0]).toContain('drop(3)');
    await handle.stop();
    expect(page.unrouted).toBe(1);
  });

  it('can fulfill with a single body instead of streaming', async () => {
    const page = fakePage();
    const handle = await replayStream(page, fixture, {
      url: '**/api/chat',
      transport: 'fulfill',
      inject: ['disconnect_at(0.5)'],
    });
    const fulfilled: Array<{ status?: number; body?: string; headers?: Record<string, string> }> = [];
    await page.routes[0]?.handler({
      continue: async () => undefined,
      fulfill: async (options) => {
        fulfilled.push(options as { status?: number; body?: string });
      },
    });
    const full = (await readTrace(fixture)).frames.map((f) => f.raw).join('');
    expect(fulfilled[0]?.status).toBe(200);
    expect(fulfilled[0]?.body?.length).toBeLessThan(full.length);
    await handle.stop();
  });

  it('can abort the request to simulate a network failure', async () => {
    const page = fakePage();
    const handle = await replayStream(page, fixture, { url: '**/api/chat', abort: true });
    const aborts: string[] = [];
    await page.routes[0]?.handler({
      continue: async () => undefined,
      abort: async (code) => {
        aborts.push(code ?? '');
      },
    });
    expect(aborts).toEqual(['failed']);
    await handle.stop();
  });

  it('resolves done once the injected error frame is sent', async () => {
    const page = fakePage();
    const handle = await replayStream(page, fixture, { url: '**/api/chat', inject: 'error(429)' });
    const request = page.routes[0]?.handler({ continue: async () => undefined });
    await request;
    await waitForReplayRequest(handle);
    await fetch(handle.streamUrl).then((r) => r.text());
    await handle.done;
    expect(handle.plan.outcome).toBe('error');
    await handle.stop();
  });

  it('defaults to **/api/** and instant playback', async () => {
    const page = fakePage();
    const handle = await replayStream(page, fixture);
    expect(page.routes[0]?.pattern).toBe('**/api/**');
    expect(handle.plan.frames).toHaveLength((await readTrace(fixture)).frames.length);
    await handle.stop();
  });
});
