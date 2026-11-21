/**
 * Playwright fixture: replay a recorded trace (optionally fault-injected) for
 * a page, deterministically.
 *
 *   import { replayStream } from 'streamscope/playwright';
 *
 *   const stream = await replayStream(page, 'demo/traces/checkout.jsonl', {
 *     url: '**\/api/chat',
 *     inject: ['drop(3)', 'disconnect_at(0.62)'],
 *   });
 *   await page.goto('/');
 *   await page.getByRole('button', { name: 'Send' }).click();
 *   await stream.done;
 *
 * Implementation: a local replay server streams the frames with their recorded
 * timing, and the page's request is rerouted to it at the network layer, so the
 * app still thinks it talks to its own `/api/chat`. Streaming, mid-stream
 * disconnects and error frames therefore behave like the real thing.
 *
 * The page is duck-typed (`route` / `unroute`) so this module has no dependency
 * on Playwright itself.
 */
import { startReplayServer, type ReplayServerHandle } from './replay.js';
import { readTrace } from './trace.js';
import type { Fault } from './faults.js';
import type { ReplayPlan, Trace } from './types.js';

export interface RouteLike {
  continue(options?: { url?: string; headers?: Record<string, string> }): Promise<void> | void;
  fulfill?(options: { status?: number; headers?: Record<string, string>; body?: string | Buffer }): Promise<void> | void;
  abort?(code?: string): Promise<void> | void;
}

export interface PageLike {
  route(
    url: string | RegExp,
    handler: (route: RouteLike, request?: unknown) => unknown,
  ): Promise<void> | void;
  unroute?(url: string | RegExp, handler?: (route: RouteLike) => unknown): Promise<void> | void;
}

export interface ReplayStreamOptions {
  /** DSL string(s) or parsed faults. */
  inject?: string | string[] | Fault[];
  /** URL pattern to intercept. Default `**\/api/**`. */
  url?: string | RegExp;
  /** 1 = recorded timing, 0 = as fast as possible. Default 0. */
  speed?: number;
  /** `continue` (default) streams through the local replay server; `fulfill` sends one body. */
  transport?: 'continue' | 'fulfill';
  /** Response status for `transport: 'fulfill'`. */
  status?: number;
  /** Extra response headers for `transport: 'fulfill'`. */
  headers?: Record<string, string>;
  /** Abort (drop) the response instead of replaying, for a network-level failure test. */
  abort?: boolean;
}

export interface ReplayHandle {
  /** Recorded (injected) plan. */
  plan: ReplayPlan;
  /** Local replay server base URL. */
  url: string;
  streamUrl: string;
  /** Number of requests this fixture intercepted so far. */
  readonly requests: number;
  /** Resolves once the first replay has sent its last frame. */
  done: Promise<void>;
  /** Remove the route and stop the local server. */
  stop: () => Promise<void>;
}

/** Replay a trace into a Playwright page. */
export async function replayStream(
  page: PageLike,
  traceOrPath: string | Trace,
  options: ReplayStreamOptions = {},
): Promise<ReplayHandle> {
  const trace = typeof traceOrPath === 'string' ? await readTrace(traceOrPath) : traceOrPath;
  return replayTrace(page, trace, options);
}

/** Same as `replayStream`, with an in-memory trace. */
export async function replayTrace(
  page: PageLike,
  trace: Trace,
  options: ReplayStreamOptions = {},
): Promise<ReplayHandle> {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  let server: ReplayServerHandle;
  let resolveStarted!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let requestCount = 0;

  server = await startReplayServer({
    trace,
    inject: options.inject,
    speed: options.speed ?? 0,
    html: false,
    onFrame: (frame, index) => {
      if (index === server.plan.frames.length - 1) resolveDone();
    },
  });
  if (server.plan.frames.length === 0) resolveDone();

  const pattern = options.url ?? '**/api/**';
  const handler = async (route: RouteLike): Promise<void> => {
    requestCount += 1;
    resolveStarted();
    if (options.abort) {
      await route.abort?.('failed');
      return;
    }
    if (options.transport === 'fulfill') {
      const body = server.plan.frames.map((frame) => frame.raw).join('');
      await route.fulfill?.({
        status: options.status ?? 200,
        headers: {
          'content-type': trace.meta.response?.contentType ?? 'text/event-stream; charset=utf-8',
          ...options.headers,
        },
        body,
      });
      return;
    }
    await route.continue({ url: server.streamUrl });
  };

  await page.route(pattern, handler);

  const handle: ReplayHandle = {
    plan: server.plan,
    url: server.url,
    streamUrl: server.streamUrl,
    get requests() {
      return requestCount;
    },
    done,
    stop: async () => {
      resolveDone();
      if (page.unroute) await page.unroute(pattern, handler);
      await server.close();
    },
  };
  return handle;
}

/** Wait until the fixture's first request arrives (handy before assertions). */
export async function waitForReplayRequest(handle: ReplayHandle, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (handle.requests === 0) {
    if (Date.now() - started > timeoutMs) throw new Error('streamscope: no intercepted request yet');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
