/**
 * streamscope trace model.
 *
 * A trace is a `.streams/<session>/events.jsonl` file: one meta line, then one
 * line per *wire frame* (one SSE message or one NDJSON line).
 *
 *   {"v":1,"kind":"meta","session":"...","adapter":"ai-sdk","framing":"sse",...}
 *   {"t_ms":12,"seq":0,"raw":"data: {...}\n\n","event":{"type":"text-delta",...}}
 *
 * `raw` is the wire frame in its normalized text form (the exact JSON payload,
 * wrapped in `data: ` lines for SSE). `event` is the normalized semantic event,
 * which is what tools, the panel and fault injection work on.
 */

/** Semantic event kinds streamscope understands. */
export type EventType =
  | 'text-delta'
  | 'tool-call-delta'
  | 'tool-result'
  | 'approval'
  | 'error'
  | 'finish'
  | 'run-start'
  | 'lifecycle'
  | 'unknown';

/** A normalized event. Protocol specific extras live in `data`. */
export interface NormalizedEvent {
  type: EventType;
  /** Message id / tool call id / run id this frame belongs to. */
  id?: string;
  /** Tool name for `tool-call-delta`. */
  name?: string;
  /** Text fragment for `text-delta`. */
  delta?: string;
  /** Raw JSON text fragment of tool arguments, for `tool-call-delta`. */
  argsDelta?: string;
  /** Parsed tool result for `tool-result`. */
  result?: unknown;
  /** `approved` / `denied` / protocol specific decision for `approval`. */
  decision?: string;
  /** Human readable error text. */
  message?: string;
  /** Status code carried by an error (429, 500, ...). */
  status?: number;
  /** Finish reason (`stop`, `length`, ...). */
  reason?: string;
  /** True when `argsDelta` completes the JSON payload. */
  complete?: boolean;
  /** Protocol-native payload, kept so a mutated frame can be re-encoded. */
  data?: unknown;
}

/** Framing of a recorded response. */
export type Framing = 'sse' | 'ndjson' | 'json' | 'raw';

/** Protocol adapter label written into trace metadata. */
export type Protocol = 'ag-ui' | 'ai-sdk' | 'ai-sdk-data' | 'generic';

export interface TraceRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface TraceResponseInfo {
  status?: number;
  contentType?: string;
  headers?: Record<string, string>;
}

export interface TraceMeta {
  v: 1;
  kind: 'meta';
  /** Session id, also the `.streams/<session>` directory name. */
  session: string;
  /** Human readable adapter label: `ai-sdk`, `ag-ui`, `ndjson`, `sse`, `raw`. */
  adapter: string;
  framing: Framing;
  protocol: Protocol;
  /** ISO time of the first recorded byte. */
  startedAt: string;
  request?: TraceRequest;
  response?: TraceResponseInfo;
  /** Free form notes (demo name, proxy target, ...). */
  notes?: Record<string, string>;
}

/** One recorded wire frame. */
export interface TraceFrame {
  /** Milliseconds since the first recorded frame. Never decreases. */
  t_ms: number;
  /** Monotonic frame number inside the trace. */
  seq: number;
  /** Wire form of the frame (SSE message text or NDJSON line). */
  raw: string;
  /** Normalized semantic event. */
  event: NormalizedEvent;
}

export interface Trace {
  meta: TraceMeta;
  frames: TraceFrame[];
  /** Where the trace was read from, when known. */
  path?: string;
}

/** A frame as produced by an adapter before it is timestamped. */
export interface AdapterFrame {
  raw: string;
  event: NormalizedEvent;
}

/** Where a replay stopped. */
export type ReplayOutcome = 'complete' | 'disconnect' | 'error';

/** A trace frame after fault injection. */
export interface InjectedFrame extends TraceFrame {
  /** Extra delay added by `slow(...)`, in ms. */
  delay_ms?: number;
  /** The frame was synthesized by a fault (`error(...)`). */
  injected?: boolean;
}

export interface ReplayPlan {
  meta: TraceMeta;
  frames: InjectedFrame[];
  outcome: ReplayOutcome;
  /** Status code for `error(status)`, if any. */
  status?: number;
  /** Human readable list of what the scenario changed. */
  effects: string[];
  /** Parsed DSL, useful for reports. */
  faults: import('./faults.js').Fault[];
}

export interface TraceSummary {
  session: string;
  adapter: string;
  protocol: Protocol;
  framing: Framing;
  frames: number;
  durationMs: number;
  wireBytes: number;
  text: string;
  textChars: number;
  eventCounts: Record<string, number>;
  toolCalls: Array<{ id: string; name?: string; argsBytes: number; argsComplete: boolean; resultSeen: boolean }>;
  approvals: number;
  errors: string[];
  terminal: EventType | null;
  /** Gaps of 1s or more between consecutive frames. */
  gaps: Array<{ afterSeq: number; ms: number }>;
}
