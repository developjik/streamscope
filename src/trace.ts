/** Trace file IO and summaries. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  EventType,
  NormalizedEvent,
  Trace,
  TraceFrame,
  TraceSummary,
} from './types.js';

export const DEFAULT_STREAMS_DIR = '.streams';
export const TRACE_FILE = 'events.jsonl';

/** Session id like `2026-11-21T14-05-33-4f2a`. */
export function newSessionId(date = new Date()): string {
  const iso = date.toISOString().replace(/[:.]/g, '-').replace('T', 'T').replace('Z', '');
  const rand = Math.random().toString(16).slice(2, 6);
  return `${iso.slice(0, 19)}-${rand}`;
}

/** Resolve a trace argument: a directory means `<dir>/events.jsonl`. */
export function resolveTracePath(input: string): string {
  if (/[/\\]$/.test(input)) return path.join(input, TRACE_FILE);
  if (path.extname(input) === '.jsonl' || path.extname(input) === '.json') return input;
  return path.join(input, TRACE_FILE);
}

export function serializeMeta(meta: Trace['meta']): string {
  return JSON.stringify(meta);
}

export function serializeFrame(frame: TraceFrame): string {
  return JSON.stringify(frame);
}

export function traceToJsonl(trace: Trace): string {
  return [serializeMeta(trace.meta), ...trace.frames.map(serializeFrame)].join('\n') + '\n';
}

/** Parse a trace `events.jsonl` body. */
export function parseTrace(text: string, filePath?: string): Trace {
  let meta: Trace['meta'] | undefined;
  const frames: TraceFrame[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a truncated last line while a stream is still being written
    }
    const record = parsed as Record<string, unknown>;
    if (record.kind === 'meta') {
      meta = record as unknown as Trace['meta'];
      continue;
    }
    if (typeof record.t_ms === 'number' && typeof record.seq === 'number' && record.event) {
      frames.push(record as unknown as TraceFrame);
    }
  }
  if (!meta) {
    const first = frames[0];
    meta = {
      v: 1,
      kind: 'meta',
      session: filePath ? path.basename(path.dirname(filePath)) : 'unknown',
      adapter: 'unknown',
      framing: 'sse',
      protocol: 'generic',
      startedAt: new Date(0).toISOString(),
    };
    void first;
  }
  frames.sort((a, b) => a.seq - b.seq);
  const trace: Trace = { meta, frames };
  if (filePath) trace.path = filePath;
  return trace;
}

export async function readTrace(input: string): Promise<Trace> {
  const file = resolveTracePath(input);
  const text = await fs.readFile(file, 'utf8');
  return parseTrace(text, file);
}

export async function writeTrace(trace: Trace, file: string): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, traceToJsonl(trace), 'utf8');
  return file;
}

/** Build a summary used by `streamscope inspect` and the CLI report. */
export function summarize(trace: Trace): TraceSummary {
  const eventCounts: Record<string, number> = {};
  const toolCalls = new Map<
    string,
    { id: string; name?: string; argsBytes: number; argsComplete: boolean; resultSeen: boolean; argsText: string }
  >();
  const errors: string[] = [];
  const gaps: Array<{ afterSeq: number; ms: number }> = [];
  let text = '';
  let wireBytes = 0;
  let approvals = 0;
  let terminal: EventType | null = null;

  trace.frames.forEach((frame, index) => {
    const event = frame.event;
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
    wireBytes += Buffer.byteLength(frame.raw, 'utf8');
    if (event.type === 'text-delta' && typeof event.delta === 'string') text += event.delta;
    if (event.type === 'tool-call-delta') {
      const id = event.id ?? `tool-${toolCalls.size}`;
      const call =
        toolCalls.get(id) ?? { id, name: event.name, argsBytes: 0, argsComplete: false, resultSeen: false, argsText: '' };
      if (event.name) call.name = event.name;
      call.argsBytes += (event.argsDelta ?? '').length;
      call.argsText += event.argsDelta ?? '';
      if (event.complete) call.argsComplete = true;
      toolCalls.set(id, call);
    }
    if (event.type === 'tool-result' && event.id) {
      const call = toolCalls.get(event.id);
      if (call) call.resultSeen = true;
    }
    if (event.type === 'approval') approvals += 1;
    if (event.type === 'error') errors.push(event.message ?? `error ${event.status ?? ''}`.trim());

    const next = trace.frames[index + 1];
    if (next) {
      const delta = next.t_ms - frame.t_ms;
      if (delta >= 1000) gaps.push({ afterSeq: frame.seq, ms: delta });
    }
    if (event.type === 'finish' || event.type === 'error') terminal = event.type;
  });

  const durationMs = trace.frames.length > 0 ? trace.frames[trace.frames.length - 1]!.t_ms : 0;
  return {
    session: trace.meta.session,
    adapter: trace.meta.adapter,
    protocol: trace.meta.protocol,
    framing: trace.meta.framing,
    frames: trace.frames.length,
    durationMs,
    wireBytes,
    text,
    textChars: text.length,
    eventCounts,
    toolCalls: [...toolCalls.values()].map(({ argsText, ...call }) => ({
      ...call,
      argsComplete: call.argsComplete || isCompleteJson(argsText),
    })),
    approvals,
    errors,
    terminal,
    gaps,
  };
}

function isCompleteJson(text: string | undefined): boolean {
  if (!text) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Human readable summary for the terminal. */
export function formatSummary(summary: TraceSummary): string {
  const lines: string[] = [];
  lines.push(`session   ${summary.session}`);
  lines.push(`adapter   ${summary.adapter} (${summary.framing}, protocol=${summary.protocol})`);
  lines.push(`frames    ${summary.frames} over ${summary.durationMs} ms, ${summary.wireBytes} wire bytes`);
  lines.push(`text      ${summary.textChars} chars`);
  const counts = Object.entries(summary.eventCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${type}=${n}`);
  lines.push(`events    ${counts.join(' ') || 'none'}`);
  lines.push(`terminal  ${summary.terminal ?? 'none (stream did not finish)'}`);
  if (summary.toolCalls.length > 0) {
    lines.push('tools');
    for (const call of summary.toolCalls) {
      lines.push(
        `  - ${call.name ?? '(unnamed)'} [${call.id}] ${call.argsBytes}B args${call.argsComplete ? ' (valid JSON)' : ' (incomplete)'}${call.resultSeen ? ' +result' : ''}`,
      );
    }
  }
  if (summary.approvals > 0) lines.push(`approvals ${summary.approvals}`);
  if (summary.errors.length > 0) lines.push(`errors    ${summary.errors.join(' | ')}`);
  if (summary.gaps.length > 0) {
    lines.push(`gaps      ${summary.gaps.map((g) => `${g.ms}ms after #${g.afterSeq}`).join(', ')}`);
  }
  return lines.join('\n');
}
