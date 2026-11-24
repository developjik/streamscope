/**
 * Deterministic stream fault injection.
 *
 * DSL (comma or semicolon separated):
 *
 *   drop(3)                  drop frame #3
 *   drop(2..5)               drop frames #2..#5 inclusive
 *   dup(7)                   send frame #7 twice
 *   truncate_tool_args(12)   cut every tool-argument fragment to 12 bytes
 *   truncate_tool_args(12,4) cut the fragment of frame #4 to 12 bytes
 *   disconnect_at(0.62)      close the connection after 62% of the frames
 *   error(429)               finish with an error frame (HTTP-ish 429)
 *   error(429,5)             keep frames #0..#4, then error
 *   slow(800)                add 800 ms before every frame
 *   slow(800,3)              add 800 ms before frame #3
 *   reorder(2,5)             swap frames #2 and #5
 *
 * Indices are 0-based and always refer to frames of the *recorded* trace, so
 * drop order does not change the removed set. Application order is fixed: truncate → drop → dup → reorder → disconnect → error → slow.
 * Drops form a union of original positions; dup skips dropped frames and
 * copies the surviving transformed frame (including truncated arguments).
 * Same-kind non-commuting faults (for example overlapping reorders) retain
 * their written order. Indexed errors keep surviving original positions below
 * the boundary, including when the boundary frame was dropped or reordered.
 */
import { formatSseMessage } from './adapters/sse.js';
import { providerWire } from './adapters/providers.js';
import { encodeEvent } from './adapters/protocols.js';
import type { InjectedFrame, NormalizedEvent, ReplayOutcome, TraceFrame, TraceMeta } from './types.js';

export type Fault =
  | { kind: 'drop'; index?: number; from?: number; to?: number }
  | { kind: 'dup'; index: number }
  | { kind: 'truncate_tool_args'; atByte: number; index?: number }
  | { kind: 'disconnect_at'; ratio: number }
  | { kind: 'error'; status: number; index?: number }
  | { kind: 'slow'; ms: number; index?: number }
  | { kind: 'reorder'; a: number; b: number };

export class FaultSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FaultSyntaxError';
  }
}

const SUPPORTED = ['drop', 'dup', 'truncate_tool_args', 'disconnect_at', 'error', 'slow', 'reorder'] as const;
type FaultName = (typeof SUPPORTED)[number];

/** Split on separators that are outside parentheses. */
function splitTopLevel(text: string, separators: RegExp): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && separators.test(char)) {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function toInt(value: string, what: string): number {
  const n = Number(value.trim());
  if (!Number.isInteger(n) || n < 0) throw new FaultSyntaxError(`${what} must be a non-negative integer, got "${value}"`);
  return n;
}

function toNumber(value: string, what: string): number {
  const n = Number(value.trim());
  if (!Number.isFinite(n)) throw new FaultSyntaxError(`${what} must be a number, got "${value}"`);
  return n;
}

/** Parse a scenario string (or array of strings) into faults. */
export function parseScenario(input: string | string[] | undefined): Fault[] {
  if (!input) return [];
  const text = Array.isArray(input) ? input.join(',') : input;
  const calls = splitTopLevel(text, /[,;]/);
  const faults: Fault[] = [];
  for (const call of calls) {
    const match = /^([a-zA-Z_]+)\s*(?:\(([^)]*)\))?$/.exec(call.trim());
    if (!match) throw new FaultSyntaxError(`cannot parse "${call}" — expected name(args)`);
    const name = (match[1] as string).toLowerCase() as FaultName;
    if (!SUPPORTED.includes(name)) {
      throw new FaultSyntaxError(`unknown fault "${name}" — supported: ${SUPPORTED.join(', ')}`);
    }
    const args = splitTopLevel(match[2] ?? '', /,/);
    faults.push(buildFault(name, args));
  }
  return faults;
}

function buildFault(name: FaultName, args: string[]): Fault {
  const need = (min: number, max: number) => {
    if (args.length < min || args.length > max) {
      throw new FaultSyntaxError(`${name}() takes ${min === max ? min : `${min}-${max}`} argument(s), got ${args.length}`);
    }
  };
  switch (name) {
    case 'drop': {
      need(1, 1);
      const arg = (args[0] ?? '').trim();
      const range = /^(\d+)\s*(?:\.\.|-)\s*(\d+)$/.exec(arg);
      if (range) {
        const from = toInt(range[1] as string, 'drop start');
        const to = toInt(range[2] as string, 'drop end');
        if (to < from) throw new FaultSyntaxError(`drop range must be ascending, got ${from}..${to}`);
        return { kind: 'drop', from, to };
      }
      return { kind: 'drop', index: toInt(arg, 'drop index') };
    }
    case 'dup': {
      need(1, 1);
      return { kind: 'dup', index: toInt(args[0] ?? '', 'dup index') };
    }
    case 'truncate_tool_args': {
      need(1, 2);
      const fault: Fault = { kind: 'truncate_tool_args', atByte: toInt(args[0] ?? '', 'truncate byte count') };
      if (args[1] !== undefined) fault.index = toInt(args[1], 'truncate frame index');
      return fault;
    }
    case 'disconnect_at': {
      need(1, 1);
      const ratio = toNumber(args[0] ?? '', 'disconnect ratio');
      if (!(ratio > 0 && ratio < 1)) throw new FaultSyntaxError(`disconnect_at ratio must be between 0 and 1 (exclusive), got ${ratio}`);
      return { kind: 'disconnect_at', ratio };
    }
    case 'error': {
      need(1, 2);
      const fault: Fault = { kind: 'error', status: toInt(args[0] ?? '', 'error status') };
      if (args[1] !== undefined) fault.index = toInt(args[1], 'error frame index');
      return fault;
    }
    case 'slow': {
      need(1, 2);
      const ms = toInt(args[0] ?? '', 'slow milliseconds');
      const fault: Fault = { kind: 'slow', ms };
      if (args[1] !== undefined) fault.index = toInt(args[1], 'slow frame index');
      return fault;
    }
    case 'reorder': {
      need(2, 2);
      return { kind: 'reorder', a: toInt(args[0] ?? '', 'reorder index'), b: toInt(args[1] ?? '', 'reorder index') };
    }
  }
}

/** Canonical string for a fault list. */
export function formatScenario(faults: Fault[]): string {
  return faults
    .map((fault) => {
      switch (fault.kind) {
        case 'drop':
          return fault.from !== undefined ? `drop(${fault.from}..${fault.to})` : `drop(${fault.index})`;
        case 'truncate_tool_args':
          return `truncate_tool_args(${fault.atByte}${fault.index !== undefined ? `,${fault.index}` : ''})`;
        case 'error':
          return `error(${fault.status}${fault.index !== undefined ? `,${fault.index}` : ''})`;
        case 'slow':
          return `slow(${fault.ms}${fault.index !== undefined ? `,${fault.index}` : ''})`;
        case 'reorder':
          return `reorder(${fault.a},${fault.b})`;
        case 'dup':
          return `dup(${fault.index})`;
        case 'disconnect_at':
          return `disconnect_at(${fault.ratio})`;
      }
    })
    .join(', ');
}

/** Wire encoder for mutated frames, matching the trace framing/protocol. */
export function defaultEncoder(meta: Pick<TraceMeta, 'framing' | 'protocol'>): (event: NormalizedEvent) => string {
  return (event) => {
    if (meta.framing === 'sse') { const wire = providerWire(event, meta.protocol); if (wire) return wire; }
    const payload = encodeEvent(event, meta.protocol);
    switch (meta.framing) {
      case 'sse':
        return formatSseMessage({ data: payload });
      case 'ndjson':
        return `${payload}\n`;
      default:
        return payload;
    }
  };
}

export interface ApplyOptions {
  encode?: (event: NormalizedEvent) => string;
  meta?: Pick<TraceMeta, 'framing' | 'protocol'>;
}

export interface InjectedResult {
  frames: InjectedFrame[];
  outcome: ReplayOutcome;
  status?: number;
  effects: string[];
}

/** Cut a UTF-8 string to at most `bytes` bytes without splitting a codepoint. */
export function truncateUtf8(text: string, bytes: number): string {
  if (bytes <= 0) return '';
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= bytes) return text;
  let end = bytes;
  // Walk back while the byte is a UTF-8 continuation byte (10xxxxxx).
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

/** Apply a fault scenario to trace frames. Pure and deterministic. */
export function applyFaults(frames: TraceFrame[], faults: Fault[], options: ApplyOptions = {}): InjectedResult {
  if (faults.length === 0) {
    return { frames: frames.map((frame) => ({ ...frame })), outcome: 'complete', effects: [] };
  }
  const effects: string[] = [];
  const encode = options.encode ?? (options.meta ? defaultEncoder(options.meta) : undefined);
  const check = (index: number | undefined, kind: string) => {
    if (index === undefined) return;
    if (index >= frames.length) {
      throw new RangeError(`${kind}(${index}) is out of range — the trace has ${frames.length} frame(s), indices are 0-based`);
    }
  };

  type WorkingFrame = InjectedFrame & { originalIndex: number };
  let working: WorkingFrame[] = frames.map((frame, originalIndex) => ({ ...frame, event: { ...frame.event }, originalIndex }));

  // 1. truncate_tool_args
  for (const fault of faults) {
    if (fault.kind !== 'truncate_tool_args') continue;
    check(fault.index, 'truncate_tool_args');
    let touched = 0;
    working = working.map((frame) => {
      if (fault.index !== undefined && fault.index !== frame.originalIndex) return frame;
      const args = frame.event.argsDelta;
      if (frame.event.type !== 'tool-call-delta' || !args) return frame;
      const cut = truncateUtf8(args, fault.atByte);
      if (cut === args) return frame;
      touched += 1;
      const event: NormalizedEvent = { ...frame.event, argsDelta: cut, complete: false };
      const raw = encode ? encode(event) : JSON.stringify(event);
      return { ...frame, event, raw };
    });
    effects.push(`truncate_tool_args(${fault.atByte}): cut ${touched} tool-argument fragment(s)`);
  }

  // 2. drop. Resolve each range against the recorded trace, never the
  // shrinking working array. Overlapping drops therefore form a union.
  for (const fault of faults) {
    if (fault.kind !== 'drop') continue;
    const from = fault.from ?? fault.index ?? 0;
    const to = fault.to ?? from;
    if (fault.from === undefined) check(fault.index, 'drop');
    const before = working.length;
    working = working.filter((frame) => frame.originalIndex < from || frame.originalIndex > to);
    effects.push(`drop(${fault.from !== undefined ? `${from}..${to}` : from}): removed ${before - working.length} frame(s)`);
  }

  // 3. dup
  for (const fault of faults) {
    if (fault.kind !== 'dup') continue;
    check(fault.index, 'dup');
    const at = working.findIndex((frame) => frame.originalIndex === fault.index);
    // Drop wins over dup. Duplicate the transformed surviving frame so any
    // earlier argument truncation is preserved in both copies.
    if (at === -1) {
      effects.push(`dup(${fault.index}): skipped dropped frame #${fault.index}`);
      continue;
    }
    const transformed = working[at]!;
    const copy: WorkingFrame = { ...transformed, event: { ...transformed.event } };
    working.splice(at + 1, 0, copy);
    effects.push(`dup(${fault.index}): frame #${fault.index} sent twice`);
  }

  // 4. reorder
  for (const fault of faults) {
    if (fault.kind !== 'reorder') continue;
    check(fault.a, 'reorder');
    check(fault.b, 'reorder');
    const indexA = working.findIndex((frame) => frame.originalIndex === fault.a);
    const indexB = working.findIndex((frame) => frame.originalIndex === fault.b);
    if (indexA !== -1 && indexB !== -1) {
      const tmp = working[indexA]!;
      working[indexA] = working[indexB]!;
      working[indexB] = tmp;
    }
    effects.push(`reorder(${fault.a},${fault.b}): frames #${fault.a} and #${fault.b} swapped`);
  }

  let outcome: ReplayOutcome = 'complete';
  let status: number | undefined;

  // 5. disconnect_at
  for (const fault of faults) {
    if (fault.kind !== 'disconnect_at') continue;
    const keep = Math.max(1, Math.floor(working.length * fault.ratio));
    const before = working.length;
    working = working.slice(0, keep);
    outcome = 'disconnect';
    effects.push(`disconnect_at(${fault.ratio}): kept ${keep}/${before} frame(s), then closed the connection`);
  }

  // 6. error
  for (const fault of faults) {
    if (fault.kind !== 'error') continue;
    const code = fault.status;
    if (fault.index !== undefined) {
      check(fault.index, 'error');
      const boundary = fault.index;
      working = working.filter((frame) => frame.originalIndex >= 0 && frame.originalIndex < boundary);
      effects.push(`error(${code},${fault.index}): kept frames #0..#${fault.index - 1} and failed with ${code}`);
    } else {
      effects.push(`error(${code}): stream finished with error ${code}`);
    }
    const event: NormalizedEvent = { type: 'error', status: code, message: `streamscope injected error ${code}` };
    const raw = encode ? encode(event) : JSON.stringify(event);
    const t_ms = working.length > 0 ? working[working.length - 1]!.t_ms + 1 : 0;
    working.push({ t_ms, seq: -1, raw, event, injected: true, originalIndex: -1 });
    outcome = 'error';
    status = code;
  }

  // 7. slow (timing only)
  for (const fault of faults) {
    if (fault.kind !== 'slow') continue;
    if (fault.index !== undefined) {
      check(fault.index, 'slow');
      const target = working.find((frame) => frame.originalIndex === fault.index);
      if (target) target.delay_ms = (target.delay_ms ?? 0) + fault.ms;
      effects.push(`slow(${fault.ms},${fault.index}): +${fault.ms} ms before frame #${fault.index}`);
    } else {
      for (const frame of working) frame.delay_ms = (frame.delay_ms ?? 0) + fault.ms;
      effects.push(`slow(${fault.ms}): +${fault.ms} ms before every frame`);
    }
  }

  // Renumber seq so duplicated/injected frames stay addressable in the UI.
  const result = working.map(({ originalIndex: _originalIndex, ...frame }, seq) => ({ ...frame, seq }));

  return { frames: result, outcome, ...(status !== undefined ? { status } : {}), effects };
}
