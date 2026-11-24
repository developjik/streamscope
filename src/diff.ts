import type { Trace, TraceFrame } from './types.js';
import { escapeHtml, renderPanelHtml } from './ui/panel.js';

export interface PayloadChange {
  path: string;
  before?: unknown;
  after?: unknown;
}
export interface FrameChange {
  key: string;
  beforeIndex: number;
  afterIndex: number;
  latencyDeltaMs: number;
  payload: PayloadChange[];
  reordered: boolean;
}
export interface TraceDiff {
  version: 1;
  adapter: string;
  beforeCount: number;
  afterCount: number;
  added: Array<{ key: string; index: number }>;
  removed: Array<{ key: string; index: number }>;
  matched: FrameChange[];
  noDifferences: boolean;
}
export type DiffGate = { kind: 'added' | 'removed' | 'payload' | 'count' } | { kind: 'latency'; thresholdMs: number };

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function payloadDiff(before: unknown, after: unknown, path = ''): PayloadChange[] {
  if (stable(before) === stable(after)) return [];
  if (
    before &&
    after &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    Array.isArray(before) === Array.isArray(after)
  ) {
    const a = before as Record<string, unknown>,
      b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .sort()
      .flatMap((k) => payloadDiff(a[k], b[k], `${path}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`));
  }
  return [
    {
      path: path || '/',
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    },
  ];
}
function keyed(frames: TraceFrame[]): Array<{ key: string; frame: TraceFrame; index: number }> {
  const seen = new Map<string, number>();
  return frames.map((frame, index) => {
    const data = frame.event.data;
    const native = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    const identity =
      frame.event.id ??
      native.toolCallId ??
      native.tool_call_id ??
      native.inputIndex ??
      native.input_index ??
      native.index;
    const base = `${frame.event.type}:${identity === undefined ? `ordinal=${index}` : stable(identity)}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return { key: `${base}#${occurrence}`, frame, index };
  });
}
export function diffTraces(before: Trace, after: Trace): TraceDiff {
  if (
    before.meta.adapter !== after.meta.adapter ||
    before.meta.protocol !== after.meta.protocol ||
    before.meta.framing !== after.meta.framing
  )
    throw new RangeError(
      `incompatible trace adapters: ${before.meta.adapter}/${before.meta.protocol}/${before.meta.framing} vs ${after.meta.adapter}/${after.meta.protocol}/${after.meta.framing}`,
    );
  for (const trace of [before, after])
    for (const f of trace.frames)
      if (!Number.isFinite(f.t_ms) || f.t_ms < 0)
        throw new RangeError('trace timestamps must be finite and nonnegative');
  const a = keyed(before.frames),
    b = keyed(after.frames),
    am = new Map(a.map((x) => [x.key, x])),
    bm = new Map(b.map((x) => [x.key, x]));
  const commonA = a.filter((x) => bm.has(x.key)),
    commonB = b.filter((x) => am.has(x.key));
  const ranks = new Map(commonB.map((x, i) => [x.key, i]));
  const matched = commonA.map((x, rank) => {
    const y = bm.get(x.key)!;
    return {
      key: x.key,
      beforeIndex: x.index,
      afterIndex: y.index,
      latencyDeltaMs: y.frame.t_ms - x.frame.t_ms,
      payload: payloadDiff(x.frame.event, y.frame.event),
      reordered: ranks.get(x.key) !== rank,
    };
  });
  const added = b.filter((x) => !am.has(x.key)).map(({ key, index }) => ({ key, index }));
  const removed = a.filter((x) => !bm.has(x.key)).map(({ key, index }) => ({ key, index }));
  return {
    version: 1,
    adapter: before.meta.adapter,
    beforeCount: a.length,
    afterCount: b.length,
    added,
    removed,
    matched,
    noDifferences:
      !added.length &&
      !removed.length &&
      matched.every((x) => !x.reordered && !x.payload.length && x.latencyDeltaMs === 0),
  };
}
export function parseDiffGates(input: string): DiffGate[] {
  if (!input.trim()) throw new RangeError('--fail-on needs at least one gate');
  return input.split(',').map((raw) => {
    const value = raw.trim();
    if (['added', 'removed', 'payload', 'count'].includes(value))
      return { kind: value as 'added' | 'removed' | 'payload' | 'count' };
    const m = /^latency>(\d+(?:\.\d+)?)ms$/.exec(value);
    if (m) {
      const thresholdMs = Number(m[1]);
      if (Number.isFinite(thresholdMs)) return { kind: 'latency', thresholdMs };
    }
    throw new RangeError(`invalid diff gate: ${value}`);
  });
}
export function diffViolations(diff: TraceDiff, gates: DiffGate[]): string[] {
  return gates.flatMap((g) => {
    const hit =
      g.kind === 'added'
        ? diff.added.length > 0
        : g.kind === 'removed'
          ? diff.removed.length > 0
          : g.kind === 'payload'
            ? diff.matched.some((x) => x.payload.length > 0)
            : g.kind === 'count'
              ? diff.beforeCount !== diff.afterCount
              : diff.matched.some((x) => x.latencyDeltaMs > ('thresholdMs' in g ? g.thresholdMs : Infinity));
    return hit ? [g.kind === 'latency' ? `latency>${g.thresholdMs}ms` : g.kind] : [];
  });
}
export function formatTraceDiff(diff: TraceDiff): string {
  if (diff.noDifferences) return 'no differences';
  const lines = [
    `frames ${diff.beforeCount} -> ${diff.afterCount}`,
    `added ${diff.added.length}, removed ${diff.removed.length}`,
  ];
  for (const x of diff.added) lines.push(`+ ${x.key} at ${x.index}`);
  for (const x of diff.removed) lines.push(`- ${x.key} at ${x.index}`);
  for (const x of diff.matched) {
    if (x.reordered) lines.push(`order ${x.key}: ${x.beforeIndex} -> ${x.afterIndex}`);
    if (x.payload.length) lines.push(`payload ${x.key}: ${x.payload.map((p) => p.path).join(', ')}`);
    if (x.latencyDeltaMs) lines.push(`latency ${x.key}: ${x.latencyDeltaMs > 0 ? '+' : ''}${x.latencyDeltaMs}ms`);
  }
  return lines.join('\n');
}
export function renderDiffHtml(diff: TraceDiff, before: Trace, after: Trace, violations: string[] = []): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>streamscope trace diff</title><style>body{font:16px system-ui;background:#111827;color:#e5e7eb;margin:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#1f2937;padding:20px;border-radius:12px}section{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,500px),1fr));gap:18px}iframe{width:100%;height:650px;border:1px solid #475569;border-radius:12px}h1{font-size:28px}</style><h1>Trace diff</h1><pre>${escapeHtml(formatTraceDiff(diff))}</pre><p>${violations.length ? `Gate failed: ${escapeHtml(violations.join(', '))}` : 'No gate violations'}</p><p>Event identity: type + ID/index + occurrence. Events without identity use ordinal position. Latency is elapsed frame time, not server processing time.</p><section><div><h2>Before</h2><iframe title="Before trace" sandbox="allow-scripts" srcdoc="${escapeHtml(renderPanelHtml(before))}"></iframe></div><div><h2>After</h2><iframe title="After trace" sandbox="allow-scripts" srcdoc="${escapeHtml(renderPanelHtml(after))}"></iframe></div></section></html>`;
}
