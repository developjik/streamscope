/**
 * Dependency-free replay panel: one self-contained HTML file.
 *
 * The panel shows the event timeline, a scrubber, the accumulated text and the
 * tool-call argument assembly at the selected frame, and highlights the frame
 * where the stream broke (error frame, or a stream that never finished).
 */
import type { Fault } from '../faults.js';
import type { InjectedFrame, NormalizedEvent, Trace } from '../types.js';

export interface PanelOptions {
  inject?: Fault[];
  title?: string;
  /** Include the injected frames instead of the recorded ones. */
  frames?: InjectedFrame[];
}

/** JSON that is safe to inline in a <script type="application/json"> block. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Compute the UI state at a frame index (also used by tests). */
export interface PanelState {
  index: number;
  text: string;
  toolCalls: Array<{ id: string; name?: string; args: string; argsValid: boolean; result?: unknown }>;
  approvals: Array<{ id: string; decision: string }>;
  errors: string[];
  sawFinish: boolean;
  breakIndex: number | null;
  breakReason: string | null;
}

export function stateAt(frames: Array<{ event: NormalizedEvent }>, index: number): PanelState {
  const text: string[] = [];
  const calls = new Map<string, { id: string; name?: string; args: string; argsValid: boolean; result?: unknown }>();
  const approvals: Array<{ id: string; decision: string }> = [];
  const errors: string[] = [];
  let sawFinish = false;
  const end = Math.max(0, Math.min(index, frames.length - 1));
  for (let i = 0; i <= end; i += 1) {
    const event = frames[i]?.event;
    if (!event) continue;
    switch (event.type) {
      case 'text-delta':
        text.push(event.delta ?? '');
        break;
      case 'tool-call-delta': {
        const id = event.id ?? `tool-${calls.size}`;
        const call = calls.get(id) ?? { id, name: event.name, args: '', argsValid: false };
        if (event.name) call.name = event.name;
        // `complete` frames (tool-input-available) carry the whole JSON payload,
        // so they replace the assembled fragment instead of extending it.
        call.args = event.complete ? (event.argsDelta ?? '') : call.args + (event.argsDelta ?? '');
        try {
          JSON.parse(call.args);
          call.argsValid = true;
        } catch {
          call.argsValid = false;
        }
        calls.set(id, call);
        break;
      }
      case 'tool-result': {
        const id = event.id ?? 'tool-0';
        const call = calls.get(id) ?? { id, args: '', argsValid: false };
        call.result = event.result;
        calls.set(id, call);
        break;
      }
      case 'approval':
        approvals.push({ id: event.id ?? 'approval', decision: event.decision ?? 'unknown' });
        break;
      case 'error':
        errors.push(event.message ?? 'error');
        break;
      case 'finish':
        sawFinish = true;
        break;
      default:
        break;
    }
  }
  let breakIndex: number | null = null;
  let breakReason: string | null = null;
  const errorIndex = frames.findIndex((frame) => frame.event.type === 'error');
  if (errorIndex !== -1) {
    breakIndex = errorIndex;
    breakReason = `error frame: ${frames[errorIndex]?.event.message ?? 'error'}`;
  } else {
    const finishIndex = frames.findIndex((frame) => frame.event.type === 'finish');
    if (finishIndex === -1 && frames.length > 0) {
      breakIndex = frames.length - 1;
      breakReason = 'stream ended without a finish event';
    }
  }
  return {
    index: end,
    text: text.join(''),
    toolCalls: [...calls.values()],
    approvals,
    errors,
    sawFinish,
    breakIndex,
    breakReason,
  };
}

export function renderPanelHtml(trace: Trace, options: PanelOptions = {}): string {
  const frames = (options.frames ?? trace.frames).map((frame, index) => ({
    seq: index,
    t_ms: frame.t_ms,
    raw: frame.raw,
    event: frame.event,
  }));
  const payload = {
    meta: trace.meta,
    frames,
    inject: options.inject ? options.inject : [],
    effects: options.frames ? 'injected' : 'recorded',
  };
  const title = options.title ?? `streamscope · ${trace.meta.session}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
:root {
  color-scheme: dark;
  --bg: #0f1113; --panel: #16191c; --panel-2: #1c2024; --line: #2a2f34;
  --text: #e6e9ec; --muted: #8b949e; --accent: #6ee7b7; --warn: #fbbf24; --bad: #f87171;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { display: flex; align-items: baseline; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--line); background: var(--panel); }
header h1 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: .2px; }
header .meta { color: var(--muted); font-family: var(--mono); font-size: 12px; }
main { display: grid; grid-template-columns: minmax(320px, 420px) 1fr; height: calc(100vh - 54px); }
.timeline { border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
.controls { display: flex; gap: 8px; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
button, select { background: var(--panel-2); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 5px 10px; font: inherit; cursor: pointer; }
button:hover, select:hover { border-color: #3b4248; }
button.primary { border-color: #2f6f57; color: var(--accent); }
input[type="range"] { flex: 1; accent-color: var(--accent); min-width: 120px; }
.list { overflow: auto; flex: 1; min-height: 0; }
.row { display: grid; grid-template-columns: 42px 64px 1fr; gap: 8px; padding: 5px 12px; border-bottom: 1px solid #1d2125; cursor: pointer; font-family: var(--mono); font-size: 12px; align-items: center; }
.row:hover { background: #191d21; }
.row.selected { background: #1d2a26; box-shadow: inset 2px 0 0 var(--accent); }
.row.broken { box-shadow: inset 2px 0 0 var(--bad); }
.row .seq { color: var(--muted); text-align: right; }
.row .t { color: var(--muted); text-align: right; }
.row .preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { display: inline-block; padding: 0 6px; border-radius: 999px; font-size: 11px; border: 1px solid var(--line); margin-right: 6px; color: var(--muted); }
.badge.text-delta { color: #93c5fd; border-color: #1e3a5f; }
.badge.tool-call-delta { color: #fcd34d; border-color: #5b4a16; }
.badge.tool-result { color: #6ee7b7; border-color: #1f5f4a; }
.badge.approval { color: #c4b5fd; border-color: #3b2f5f; }
.badge.error { color: #fca5a5; border-color: #5f2323; }
.badge.finish { color: #86efac; border-color: #1f5f34; }
.inspector { overflow: auto; padding: 16px 18px; display: flex; flex-direction: column; gap: 16px; min-height: 0; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.card h2 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); font-weight: 600; }
pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: var(--mono); font-size: 12.5px; }
.text-out { min-height: 64px; }
.calls { display: flex; flex-direction: column; gap: 10px; }
.call { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; background: var(--panel-2); }
.call .head { display: flex; gap: 8px; align-items: center; font-family: var(--mono); font-size: 12px; margin-bottom: 6px; }
.call .ok { color: var(--accent); } .call .bad { color: var(--warn); }
.break { border-color: #5f2323; background: #1f1517; }
.break h2 { color: #fca5a5; }
.empty { color: var(--muted); font-family: var(--mono); font-size: 12px; }
.counts { display: flex; gap: 10px; flex-wrap: wrap; font-family: var(--mono); font-size: 12px; color: var(--muted); }
.counts b { color: var(--text); font-weight: 600; }
@media (max-width: 860px) { main { grid-template-columns: 1fr; height: auto; } .timeline { border-right: 0; border-bottom: 1px solid var(--line); max-height: 50vh; } }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <span class="meta" id="meta"></span>
</header>
<main>
  <section class="timeline">
    <div class="controls">
      <button id="play" class="primary" title="Play / pause (space)">▶ Play</button>
      <button id="prev" title="Previous frame (←)">◀</button>
      <button id="next" title="Next frame (→)">▶</button>
      <select id="speed" title="Playback speed">
        <option value="0.5">0.5×</option>
        <option value="1" selected>1×</option>
        <option value="4">4×</option>
        <option value="16">16×</option>
      </select>
      <input id="scrub" type="range" min="0" max="0" value="0" />
    </div>
    <div class="counts" id="counts"></div>
    <div class="list" id="list"></div>
  </section>
  <section class="inspector">
    <div class="card" id="frame-card">
      <h2>Frame <span id="frame-title"></span></h2>
      <div id="frame-body"><span class="empty">select a frame</span></div>
    </div>
    <div class="card" id="break-card" hidden>
      <h2>Break point</h2>
      <div id="break-body"></div>
    </div>
    <div class="card">
      <h2>Accumulated text</h2>
      <pre class="text-out" id="text-out"></pre>
    </div>
    <div class="card">
      <h2>Tool calls (argument assembly)</h2>
      <div class="calls" id="calls"><span class="empty">no tool calls</span></div>
    </div>
    <div class="card">
      <h2>Wire frame</h2>
      <pre id="raw-out" class="empty">—</pre>
    </div>
  </section>
</main>
<script type="application/json" id="trace-data">${safeJson(payload)}</script>
<script>
(function () {
  const data = JSON.parse(document.getElementById('trace-data').textContent);
  const frames = data.frames || [];
  const meta = data.meta || {};
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let index = 0;
  let timer = null;

  $('meta').textContent = [meta.adapter, meta.framing, meta.protocol, (frames.length + ' frames')].filter(Boolean).join(' · ');

  function summarize(event) {
    if (!event) return '';
    switch (event.type) {
      case 'text-delta': return JSON.stringify(event.delta || '');
      case 'tool-call-delta': return (event.name || event.id || 'tool') + ' ' + (event.argsDelta || '');
      case 'tool-result': return (event.id || 'tool') + ' → ' + JSON.stringify(event.result);
      case 'approval': return (event.decision || '') + ' ' + (event.id || '');
      case 'error': return event.status ? 'HTTP ' + event.status + ': ' + (event.message || '') : (event.message || 'error');
      case 'finish': return 'finish ' + (event.reason || '');
      default: return event.type + (event.name ? ' ' + event.name : '');
    }
  }

  function renderList() {
    const list = $('list');
    list.innerHTML = frames.map((frame, i) => {
      const event = frame.event || {};
      const broken = event.type === 'error' ? ' broken' : '';
      return '<div class="row' + (i === index ? ' selected' : '') + broken + '" data-i="' + i + '">' +
        '<span class="seq">' + i + '</span>' +
        '<span class="t">' + frame.t_ms + 'ms</span>' +
        '<span class="preview"><span class="badge ' + esc(event.type) + '">' + esc(event.type) + '</span>' + esc(summarize(event)) + '</span>' +
        '</div>';
    }).join('') || '<div class="row"><span></span><span></span><span class="empty">empty trace</span></div>';
    const selected = list.querySelector('.row.selected');
    if (selected && selected.scrollIntoView) selected.scrollIntoView({ block: 'nearest' });
  }

  function stateUpTo(i) {
    const text = [];
    const calls = [];
    const byId = new Map();
    const approvals = [];
    const errors = [];
    let finishSeen = false;
    for (let n = 0; n <= i && n < frames.length; n++) {
      const event = frames[n].event || {};
      if (event.type === 'text-delta') text.push(event.delta || '');
      else if (event.type === 'tool-call-delta') {
        const id = event.id || ('tool-' + byId.size);
        let call = byId.get(id);
        if (!call) { call = { id: id, name: event.name, args: '', result: undefined }; byId.set(id, call); calls.push(call); }
        if (event.name) call.name = event.name;
        call.args = event.complete ? (event.argsDelta || '') : call.args + (event.argsDelta || '');
      } else if (event.type === 'tool-result') {
        const id = event.id || 'tool-0';
        let call = byId.get(id);
        if (!call) { call = { id: id, args: '', result: undefined }; byId.set(id, call); calls.push(call); }
        call.result = event.result;
      } else if (event.type === 'approval') approvals.push({ id: event.id, decision: event.decision });
      else if (event.type === 'error') errors.push(event.message || ('error ' + (event.status || '')));
      else if (event.type === 'finish') finishSeen = true;
    }
    let breakIndex = -1;
    for (let n = 0; n < frames.length; n++) if ((frames[n].event || {}).type === 'error') { breakIndex = n; break; }
    if (breakIndex === -1 && !finishSeen && frames.length) breakIndex = frames.length - 1;
    return { text: text.join(''), calls: calls, approvals: approvals, errors: errors, finishSeen: finishSeen, breakIndex: breakIndex };
  }

  function renderInspector() {
    const frame = frames[index];
    $('frame-title').textContent = frame ? ('#' + index + ' · ' + frame.t_ms + 'ms · ' + ((frame.event || {}).type || '?')) : '';
    const event = frame && frame.event ? frame.event : null;
    $('frame-body').innerHTML = event
      ? ('<pre>' + esc(JSON.stringify(event, null, 2)) + '</pre>')
      : '<span class="empty">empty trace</span>';
    $('raw-out').textContent = frame ? frame.raw : '—';
    $('raw-out').className = frame ? '' : 'empty';
    const state = stateUpTo(index);
    $('text-out').textContent = state.text || '';
    $('calls').innerHTML = state.calls.length
      ? state.calls.map(function (call) {
          let valid = false, parsed = '';
          try { JSON.parse(call.args); valid = true; parsed = JSON.stringify(JSON.parse(call.args), null, 2); } catch (e) { parsed = call.args; }
          return '<div class="call"><div class="head"><strong>' + esc(call.name || '(unnamed)') + '</strong><span>' + esc(call.id) + '</span>' +
            '<span class="' + (valid ? 'ok' : 'bad') + '">' + (valid ? 'valid JSON · ' + call.args.length + 'B' : 'incomplete · ' + call.args.length + 'B') + '</span>' +
            (call.result !== undefined ? '<span class="ok">result ✓</span>' : '') + '</div><pre>' + esc(parsed) + '</pre></div>';
        }).join('')
      : '<span class="empty">no tool calls</span>';
    const breakCard = $('break-card');
    const breakBody = $('break-body');
    if (state.breakIndex !== -1) {
      breakCard.hidden = false;
      const bf = frames[state.breakIndex];
      const reason = (bf && bf.event && bf.event.type === 'error') ? ('error frame: ' + (bf.event.message || 'error')) : 'stream ended without a finish event';
      const reached = state.breakIndex <= index ? 'reached' : 'not reached yet — scrub past it to see the cut';
      breakBody.innerHTML = '<pre>frame #' + state.breakIndex + ' at ' + (bf ? bf.t_ms : 0) + 'ms (' + reached + ')\\n' + esc(reason) + '\\n\\naccumulated text stops at ' + state.text.length + ' chars, ' + state.calls.length + ' tool call(s)</pre>';
    } else {
      breakCard.hidden = true;
    }
    $('counts').textContent = '';
    const counts = {};
    frames.forEach(function (f) { const t = (f.event || {}).type || '?'; counts[t] = (counts[t] || 0) + 1; });
    $('counts').innerHTML = Object.keys(counts).sort().map(function (k) { return k + ' <b>' + counts[k] + '</b>'; }).join('  ·  ');
    if (data.inject && data.inject.length) $('counts').innerHTML += '  ·  <span style="color:#fbbf24">injected: ' + esc(JSON.stringify(data.inject)) + '</span>';
  }

  function setIndex(i) {
    index = Math.max(0, Math.min(frames.length - 1, i));
    $('scrub').value = String(index);
    renderList();
    renderInspector();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    $('play').textContent = '▶ Play';
  }

  function play() {
    if (timer) { stop(); return; }
    $('play').textContent = '❚❚ Pause';
    const speed = Number($('speed').value) || 1;
    timer = setInterval(function () {
      if (index >= frames.length - 1) { stop(); return; }
      const next = index + 1;
      setIndex(next);
      const gap = (frames[next].t_ms - frames[index].t_ms) / speed;
      if (gap > 250) { stop(); setTimeout(function () { if (!timer) play(); }, Math.min(gap, 1500)); }
    }, 120);
  }

  $('scrub').max = String(Math.max(0, frames.length - 1));
  $('scrub').addEventListener('input', function (e) { stop(); setIndex(Number(e.target.value)); });
  $('play').addEventListener('click', play);
  $('prev').addEventListener('click', function () { stop(); setIndex(index - 1); });
  $('next').addEventListener('click', function () { stop(); setIndex(index + 1); });
  $('list').addEventListener('click', function (e) {
    const row = e.target.closest('.row[data-i]');
    if (row) { stop(); setIndex(Number(row.dataset.i)); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight') { stop(); setIndex(index + 1); }
    else if (e.key === 'ArrowLeft') { stop(); setIndex(index - 1); }
    else if (e.key === ' ') { e.preventDefault(); play(); }
  });

  setIndex(0);
})();
</script>
</body>
</html>`;
}
