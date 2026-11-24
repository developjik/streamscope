/**
 * Recorder: turns a live byte stream into a trace on disk.
 *
 *   .streams/<session>/events.jsonl
 *     {"kind":"meta", ...}
 *     {"t_ms":0,"seq":0,"raw":"data: {...}\n\n","event":{"type":"text-delta",...}}
 *
 * The same core is used by the reverse proxy, by the middleware and by
 * `recordStream()` (tests, custom servers).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createAdapter, type AdapterOptions, type StreamAdapter } from './adapters/index.js';
import { DEFAULT_STREAMS_DIR, TRACE_FILE, newSessionId, serializeFrame, serializeMeta, traceToJsonl } from './trace.js';
import type { AdapterFrame, Trace, TraceFrame, TraceRequest, TraceResponseInfo } from './types.js';

export interface RecorderOptions {
  /** Directory that holds all sessions. Default `.streams`. */
  dir?: string;
  /** Session id; default is a timestamp. */
  session?: string;
  adapter?: AdapterOptions;
  request?: TraceRequest;
  response?: TraceResponseInfo;
  notes?: Record<string, string>;
  /** Injectable clock for deterministic tests (ms). */
  now?: () => number;
  startedAt?: Date;
}

export class Recorder {
  readonly session: string;
  readonly file: string;
  readonly adapter: StreamAdapter;
  readonly meta: Trace['meta'];
  readonly frames: TraceFrame[] = [];
  private readonly options: RecorderOptions;
  private readonly clock: () => number;
  private startMs: number | undefined;
  private seq = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(options: RecorderOptions = {}) {
    this.options = options;
    this.session = options.session ?? newSessionId(options.startedAt ?? new Date());
    this.file = path.join(options.dir ?? DEFAULT_STREAMS_DIR, this.session, TRACE_FILE);
    this.adapter = createAdapter(options.adapter);
    this.clock = options.now ?? (() => Date.now());
    this.meta = {
      v: 1,
      kind: 'meta',
      session: this.session,
      adapter: 'unknown',
      framing: this.adapter.framing,
      protocol: this.adapter.protocol,
      startedAt: (options.startedAt ?? new Date()).toISOString(),
    };
    if (options.request) this.meta.request = options.request;
    if (options.response) this.meta.response = options.response;
    if (options.notes) this.meta.notes = options.notes;
  }

  /** Create the session directory and write the meta line. */
  begin(): Promise<void> {
    this.queue = this.queue.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(path.join(path.dirname(this.file), '.recording'), 'active');
      await fs.writeFile(this.file, `${serializeMeta({ ...this.meta, adapter: this.adapter.label })}\n`, 'utf8');
    });
    return this.queue.then(() => undefined);
  }

  /** Feed raw bytes/text; they are parsed into frames and appended. */
  async push(chunk: string | Uint8Array): Promise<AdapterFrame[]> {
    if (this.closed) throw new Error('recorder already closed');
    const frames = this.adapter.feed(chunk);
    await this.append(frames);
    return frames;
  }

  /** Feed an already-parsed frame (used by tools and tests). */
  async pushFrame(frame: AdapterFrame): Promise<void> {
    await this.append([frame]);
  }

  /** Flush parser state and finalize the meta line. */
  async end(response?: TraceResponseInfo): Promise<Trace> {
    if (this.closed) return this.snapshot();
    const tail = this.adapter.flush();
    await this.append(tail);
    this.closed = true;
    const meta: Trace['meta'] = {
      ...this.meta,
      adapter: this.adapter.label,
      framing: this.adapter.framing,
      protocol: this.adapter.protocol,
    };
    if (response) {
      meta.response = { ...(meta.response ?? {}), ...response };
    }
    await this.queue;
    // Rewrite the whole file so the final adapter/protocol/response metadata
    // is exact (session files are small enough; frames already live in memory).
    await fs.writeFile(this.file, traceToJsonl({ meta, frames: this.frames }), 'utf8');
    this.meta.adapter = meta.adapter;
    this.meta.framing = meta.framing;
    this.meta.protocol = meta.protocol;
    if (response) this.meta.response = meta.response;
    await fs.unlink(path.join(path.dirname(this.file), '.recording')).catch(() => undefined);
    return this.snapshot();
  }

  snapshot(): Trace {
    return { meta: { ...this.meta, adapter: this.adapter.label }, frames: [...this.frames], path: this.file };
  }

  private append(frames: AdapterFrame[]): Promise<void> {
    if (frames.length === 0) return Promise.resolve();
    const now = this.clock();
    if (this.startMs === undefined) this.startMs = now;
    const lines: string[] = [];
    for (const frame of frames) {
      const previous = this.frames[this.frames.length - 1];
      const rawT = Math.max(0, Math.round(now - this.startMs));
      const t_ms = previous ? Math.max(previous.t_ms, rawT) : rawT;
      const record: TraceFrame = { t_ms, seq: this.seq++, raw: frame.raw, event: frame.event };
      this.frames.push(record);
      lines.push(serializeFrame(record));
    }
    const payload = `${lines.join('\n')}\n`;
    this.queue = this.queue.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.appendFile(this.file, payload, 'utf8');
    });
    return this.queue.then(() => undefined);
  }
}

export function createRecorder(options: RecorderOptions = {}): Recorder {
  return new Recorder(options);
}

/** Convenience: record any async iterable of chunks into a fresh session. */
export async function recordStream(
  source: AsyncIterable<string | Uint8Array>,
  options: RecorderOptions = {},
): Promise<Trace> {
  const recorder = createRecorder(options);
  await recorder.begin();
  for await (const chunk of source) {
    await recorder.push(chunk);
  }
  return recorder.end();
}
