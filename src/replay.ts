/** Replay engine and replay HTTP server. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { applyFaults, defaultEncoder, parseScenario, type Fault } from './faults.js';
import { readTrace } from './trace.js';
import type { InjectedFrame, ReplayPlan, Trace } from './types.js';

export interface ReplayOptions {
  /** DSL string, list of DSL strings, or parsed faults. */
  inject?: string | string[] | Fault[];
  /** 1 = real time, 10 = 10x, 0 = no waiting at all. Default 1. */
  speed?: number;
  /** Upper bound for a single inter-frame wait. Default 10s. */
  maxDelayMs?: number;
  onFrame?: (frame: InjectedFrame, index: number) => void | Promise<void>;
  signal?: AbortSignal;
}

function resolveFaults(inject: ReplayOptions['inject']): Fault[] {
  if (!inject) return [];
  if (Array.isArray(inject)) {
    return inject.flatMap((item) => (typeof item === 'string' ? parseScenario(item) : [item]));
  }
  return parseScenario(inject);
}

/** Validate a trace + scenario and produce a concrete replay plan. */
export function prepareReplay(trace: Trace, options: ReplayOptions = {}): ReplayPlan {
  const faults = resolveFaults(options.inject);
  const result = applyFaults(trace.frames, faults, {
    meta: { framing: trace.meta.framing, protocol: trace.meta.protocol },
    encode: defaultEncoder(trace.meta),
  });
  const plan: ReplayPlan = {
    meta: trace.meta,
    frames: result.frames,
    outcome: result.outcome,
    effects: result.effects,
    faults,
  };
  if (result.status !== undefined) plan.status = result.status;
  return plan;
}

/** Inter-frame wait for a frame, in ms, honouring `speed`. */
export function frameDelayMs(plan: ReplayPlan, index: number, options: ReplayOptions = {}): number {
  const speed = options.speed ?? 1;
  if (speed <= 0) return 0;
  const frame = plan.frames[index];
  if (!frame) return 0;
  const previous = index > 0 ? plan.frames[index - 1] : undefined;
  const base = index === 0 ? frame.t_ms : Math.max(0, frame.t_ms - (previous?.t_ms ?? 0));
  const total = (base + (frame.delay_ms ?? 0)) / speed;
  const cap = options.maxDelayMs ?? 10_000;
  return Math.min(cap, Math.max(0, Math.round(total)));
}

/** Yield replay frames with their wire text, sleeping between them. */
export async function* streamReplay(
  plan: ReplayPlan,
  options: ReplayOptions = {},
): AsyncGenerator<{ frame: InjectedFrame; text: string; index: number }> {
  for (let index = 0; index < plan.frames.length; index += 1) {
    if (options.signal?.aborted) return;
    const delay = frameDelayMs(plan, index, options);
    if (delay > 0) await sleep(delay, options.signal);
    if (options.signal?.aborted) return;
    const frame = plan.frames[index]!;
    await options.onFrame?.(frame, index);
    yield { frame, text: frame.raw, index };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface ReplayServerOptions extends ReplayOptions {
  trace?: Trace;
  /** Trace file (or session directory) to read when `trace` is not given. */
  file?: string;
  host?: string;
  port?: number;
  /** Serve the HTML panel at `/`. Default true. */
  html?: boolean;
}

export interface ReplayServerHandle {
  server: http.Server;
  port: number;
  url: string;
  streamUrl: string;
  plan: ReplayPlan;
  close: () => Promise<void>;
}

/** Start a replay server: `/stream` serves the (injected) stream. */
export async function startReplayServer(options: ReplayServerOptions): Promise<ReplayServerHandle> {
  const trace = options.trace ?? (options.file ? await readTrace(options.file) : undefined);
  if (!trace) throw new Error('startReplayServer needs a trace or a file');
  const plan = prepareReplay(trace, options);

  const server = http.createServer((req, res) => {
    void handle(req, res, plan, trace, options);
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const base = `http://${options.host ?? '127.0.0.1'}:${address.port}`;
  return {
    server,
    port: address.port,
    url: `${base}/`,
    streamUrl: `${base}/stream`,
    plan,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  plan: ReplayPlan,
  trace: Trace,
  options: ReplayServerOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, frames: plan.frames.length, outcome: plan.outcome }));
    return;
  }
  if (url.pathname === '/trace.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ meta: plan.meta, frames: plan.frames, outcome: plan.outcome, effects: plan.effects }));
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (options.html === false) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found\n');
      return;
    }
    const { renderPanelHtml } = await import('./ui/panel.js');
    const html = renderPanelHtml(trace, {
      inject: plan.faults,
      frames: plan.frames,
      title: `streamscope · ${trace.meta.session}`,
    });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (url.pathname !== '/stream') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
    return;
  }

  const status = plan.status;
  const headers: Record<string, string> = {
    'content-type': trace.meta.response?.contentType ?? 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'access-control-allow-origin': '*',
    'x-streamscope-outcome': plan.outcome,
    'x-streamscope-frames': String(plan.frames.length),
  };
  // A scenario whose first frame is the injected error is a plain HTTP error.
  if (plan.outcome === 'error' && plan.frames.length === 1 && plan.frames[0]?.injected) {
    res.writeHead(status ?? 500, headers);
    res.end(plan.frames[0].raw);
    return;
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const controller = new AbortController();
  req.on('close', () => controller.abort());
  let closedByClient = false;
  res.on('close', () => {
    if (!res.writableEnded) closedByClient = true;
    controller.abort();
  });

  try {
    for await (const item of streamReplay(plan, { ...options, signal: controller.signal })) {
      if (res.writableEnded || closedByClient) return;
      res.write(item.text);
    }
    if (plan.outcome === 'disconnect' && !res.writableEnded) {
      // Simulate a dropped connection: no terminal event, socket destroyed.
      res.destroy();
      return;
    }
    if (!res.writableEnded) res.end();
  } catch (error) {
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.end(String(error));
    }
  }
}
