/** Browser-safe replay helpers. Load JSONL with your runner, then pass a Trace. */
import type { Trace, TraceFrame } from './types.js';

export interface TraceMatchResult { pass: boolean; message: () => string }
export function toMatchTrace(received: Trace | TraceFrame[], expected: Trace | TraceFrame[]): TraceMatchResult {
  const actual = Array.isArray(received) ? received : received.frames;
  const wanted = Array.isArray(expected) ? expected : expected.frames;
  for (let i = 0; i < Math.max(actual.length, wanted.length); i++) {
    if (JSON.stringify(actual[i]?.event) !== JSON.stringify(wanted[i]?.event)) {
      return { pass: false, message: () => `Trace mismatch at frame ${i}: expected ${JSON.stringify(wanted[i]?.event)}, received ${JSON.stringify(actual[i]?.event)}` };
    }
  }
  return { pass: true, message: () => 'Expected traces to differ, but every normalized frame matched' };
}

export interface TraceFetchOptions {
  /** Exact URL, RegExp, or predicate. Unmatched calls use fallback or reject. */
  url?: string | RegExp | ((url: string) => boolean);
  fallback?: typeof fetch;
  /** 1 = recorded timing, 0 = immediate. */
  speed?: number;
}
export function createTraceFetch(trace: Trace, options: TraceFetchOptions = {}): typeof fetch {
  const speed = options.speed ?? 0;
  if (!Number.isFinite(speed) || speed < 0) throw new Error('speed must be finite and nonnegative');
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const match = options.url;
    const matches = match === undefined || (typeof match === 'string' ? url === match : typeof match === 'function' ? match(url) : new RegExp(match.source, match.flags.replace(/[gy]/g, '')).test(url));
    if (!matches) {
      if (options.fallback) return options.fallback(input, init);
      throw new Error(`No recorded response for ${url}`);
    }
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let index = 0;
    let previous = 0;
    let abort: (() => void) | undefined;
    let resolveWait: (() => void) | undefined;
    const cleanup = () => { if (timer) clearTimeout(timer); resolveWait?.(); resolveWait = undefined; if (abort) signal?.removeEventListener('abort', abort); };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        abort = () => { cleanup(); controller.error(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
        signal?.addEventListener('abort', abort, { once: true });
      },
      pull(controller) {
        const frame = trace.frames[index++];
        if (!frame) { cleanup(); controller.close(); return; }
        const wait = speed === 0 ? 0 : Math.max(0, frame.t_ms - previous) / speed;
        previous = frame.t_ms;
        if (wait === 0) { controller.enqueue(new TextEncoder().encode(frame.raw)); return; }
        return new Promise<void>((resolve) => { resolveWait = resolve; timer = setTimeout(() => { timer = undefined; resolveWait = undefined; if (!signal?.aborted) controller.enqueue(new TextEncoder().encode(frame.raw)); resolve(); }, wait); });
      },
      cancel() { cleanup(); },
    });
    return new Response(body, { status: trace.meta.response?.status ?? 200, headers: { ...trace.meta.response?.headers, 'content-type': trace.meta.response?.contentType ?? 'text/event-stream; charset=utf-8' } });
  };
}

export interface CypressLike {
  intercept(matcher: string | RegExp, handler: (request: { reply(response: { statusCode: number; headers: Record<string, string>; body: string }): void }) => void): unknown;
}
/** Cypress buffers replies. This helper does not claim frame timing or disconnect fidelity. */
export function interceptTrace(cy: CypressLike, url: string | RegExp, trace: Trace): unknown {
  return cy.intercept(url, (request) => request.reply({ statusCode: trace.meta.response?.status ?? 200, headers: { ...trace.meta.response?.headers, 'content-type': trace.meta.response?.contentType ?? 'text/event-stream; charset=utf-8' }, body: trace.frames.map((frame) => frame.raw).join('') }));
}
