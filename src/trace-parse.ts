/** Browser-safe trace parsing, preserving the CLI tolerant parsing contract. */
import type { Trace, TraceFrame } from './types.js';
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
      session: filePath ? filePath.replace(/\\/g, '/').split('/').slice(-2, -1)[0] ?? 'unknown' : 'unknown',
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
