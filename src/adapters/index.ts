/**
 * Stream adapters: turn an incremental text stream into normalized frames.
 *
 * An adapter only chooses *framing* (SSE / NDJSON / single JSON / raw text);
 * the semantic protocol (AG-UI, AI SDK, legacy AI SDK data stream, generic) is
 * detected per payload by `protocols.ts` and exposed as `protocol`.
 */
import type { AdapterFrame, Framing, NormalizedEvent, Protocol } from '../types.js';
import { providerEvents, providerWire } from './providers.js';
import { NdjsonParser } from './ndjson.js';
import { SseParser, formatSseMessage } from './sse.js';
import { adapterLabel, classifyPayload, encodeEvent } from './protocols.js';

export type FramingChoice = 'auto' | Framing;
export type ProtocolChoice = 'auto' | Protocol;

export interface AdapterOptions {
  framing?: FramingChoice;
  protocol?: ProtocolChoice;
  contentType?: string;
  /** Force a framing without content-type sniffing (used when the body is known). */
  forceFraming?: boolean;
}

export interface StreamAdapter {
  readonly framing: Framing;
  readonly protocol: Protocol;
  readonly label: string;
  feed(chunk: string | Uint8Array): AdapterFrame[];
  flush(): AdapterFrame[];
  /** Wire text for a (possibly synthesized/mutated) event. */
  encode(event: NormalizedEvent): string;
  /** Wire text for a raw error status line/event. */
  encodeError(status: number, message?: string): string;
}

const SSE_HINT = /^\s*(data:|event:|id:|retry:|:)/;
const NDJSON_HINT = /^\s*[{[]/;
const LEGACY_LINE_HINT = /^\s*[0-9a-z]:["{\[]/;

/** Guess framing from a content type. */
export function detectFraming(contentType: string | undefined): Framing | 'auto' {
  if (!contentType) return 'auto';
  const ct = contentType.toLowerCase();
  if (ct.includes('text/event-stream')) return 'sse';
  if (ct.includes('ndjson') || ct.includes('jsonl')) return 'ndjson';
  if (ct.includes('json')) return 'json';
  if (ct.includes('text/plain') || ct.includes('text/html')) return 'raw';
  return 'auto';
}

class Adapter implements StreamAdapter {
  private framingImpl: Framing | 'auto';
  private readonly requested: FramingChoice;
  private readonly hint: Protocol | 'auto';
  private detectedProtocol: Protocol | undefined;
  private sse?: SseParser;
  private ndjson?: NdjsonParser;
  private jsonBuffer = '';
  private started = false;

  constructor(options: AdapterOptions = {}) {
    this.requested = options.framing ?? 'auto';
    this.framingImpl =
      this.requested !== 'auto'
        ? this.requested
        : options.forceFraming
          ? 'raw'
          : detectFraming(options.contentType);
    this.hint = options.protocol ?? 'auto';
  }

  get framing(): Framing {
    return this.framingImpl === 'auto' ? 'raw' : this.framingImpl;
  }

  get protocol(): Protocol {
    if (this.detectedProtocol) return this.detectedProtocol;
    if (this.hint !== 'auto') return this.hint;
    return 'generic';
  }

  get label(): string {
    return adapterLabel(this.framing, this.protocol);
  }

  feed(chunk: string | Uint8Array): AdapterFrame[] {
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    if (text === '') return [];
    if (!this.started) {
      this.started = true;
      if (this.framingImpl === 'auto') this.framingImpl = this.sniff(text);
    }
    switch (this.framing) {
      case 'sse':
        return this.feedSse(text);
      case 'ndjson':
        return this.feedNdjson(text);
      case 'json':
        this.jsonBuffer += text;
        return [];
      default:
        return this.synthesize(text, classifyPayload(text, this.hint));
    }
  }

  flush(): AdapterFrame[] {
    switch (this.framing) {
      case 'sse':
        return this.toFrames((this.sse ??= new SseParser()).flush());
      case 'ndjson':
        return (this.ndjson ??= new NdjsonParser()).flush().flatMap((line) => this.lineToFrames(line));
      case 'json': {
        const text = this.jsonBuffer;
        this.jsonBuffer = '';
        if (!text.trim()) return [];
        const events = classifyPayload(text, this.hint).events;
        this.observe(events);
        return [{ raw: text, event: events[0] ?? { type: 'unknown' } }];
      }
      default:
        return [];
    }
  }

  encode(event: NormalizedEvent): string {
    if (this.framing === 'sse') { const wire = providerWire(event, this.protocol); if (wire) return wire; }
    const payload = encodeEvent(event, this.protocol);
    return this.wrap(payload);
  }

  encodeError(status: number, message?: string): string {
    return this.encode({ type: 'error', status, message: message ?? `streamscope injected HTTP ${status}` });
  }

  private wrap(payload: string): string {
    switch (this.framing) {
      case 'sse':
        return formatSseMessage({ data: payload });
      case 'ndjson':
        return `${payload}\n`;
      default:
        return payload;
    }
  }

  private sniff(text: string): Framing {
    const head = text.slice(0, 512);
    if (SSE_HINT.test(head)) return 'sse';
    if (NDJSON_HINT.test(head) || LEGACY_LINE_HINT.test(head)) return 'ndjson';
    return 'raw';
  }

  private feedSse(text: string): AdapterFrame[] {
    this.sse ??= new SseParser();
    return this.toFrames(this.sse.push(text));
  }

  private toFrames(messages: ReturnType<SseParser['push']>): AdapterFrame[] {
    const frames: AdapterFrame[] = [];
    for (const message of messages) {
      const payload = message.data;
      if (payload === '' && message.event === undefined) continue;
      const classified = providerEvents(message.event, payload, this.detectedProtocol ?? (this.hint === 'auto' ? undefined : this.hint)) ?? classifyPayload(payload, this.hint);
      const events = classified.events;
      this.observeProtocol(classified.protocol);
      if (events.length === 0) continue;
      events.forEach((event, index) => {
        frames.push({ raw: index === 0 ? message.raw : this.wrap(encodeEvent(event, this.protocol)), event });
      });
    }
    return frames;
  }

  private feedNdjson(text: string): AdapterFrame[] {
    this.ndjson ??= new NdjsonParser();
    return this.ndjson.push(text).flatMap((line) => this.lineToFrames(line));
  }

  private lineToFrames(line: string): AdapterFrame[] {
    const classified = classifyPayload(line, this.hint);
    this.observeProtocol(classified.protocol);
    if (classified.events.length === 0) return [];
    return classified.events.map((event, index) => ({
      raw: index === 0 ? line : this.wrap(encodeEvent(event, this.protocol)),
      event,
    }));
  }

  private synthesize(raw: string, classified: ReturnType<typeof classifyPayload>): AdapterFrame[] {
    const events = classified.events;
    this.observeProtocol(classified.protocol);
    if (events.length === 0) return [];
    return events.map((event, index) => ({ raw: index === 0 ? raw : this.wrap(encodeEvent(event, this.protocol)), event }));
  }

  private observeProtocol(protocol: Protocol): void {
    if (this.detectedProtocol) return;
    if (protocol !== 'generic') this.detectedProtocol = protocol;
  }

  private observe(events: NormalizedEvent[]): void {
    if (this.detectedProtocol) return;
    for (const event of events) {
      const detected = classifyProtocolOf(event);
      if (detected) {
        this.detectedProtocol = detected;
        return;
      }
    }
  }
}

function classifyProtocolOf(event: NormalizedEvent): Protocol | undefined {
  const data = event.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const type = (data as Record<string, unknown>).type;
    if (typeof type === 'string') {
      if (/^[A-Z][A-Z0-9_]+$/.test(type)) return 'ag-ui';
      if (type.includes('-') || ['start', 'finish', 'error', 'abort'].includes(type)) return 'ai-sdk';
    }
    if ('toolCallId' in (data as Record<string, unknown>) && 'toolCallName' in (data as Record<string, unknown>)) {
      return 'ag-ui';
    }
  }
  return undefined;
}

export function createAdapter(options: AdapterOptions = {}): StreamAdapter {
  return new Adapter(options);
}
