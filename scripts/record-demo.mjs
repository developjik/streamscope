/**
 * Record the bundled demo through the recording proxy and write the traces
 * into `demo/traces/`. Reproducible fixture generation:
 *
 *   node scripts/record-demo.mjs
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRecordingProxy } from '../dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const streamsDir = path.join(root, '.streams');
const tracesDir = path.join(root, 'demo', 'traces');
const demoPort = 8791;
const proxyPort = 8792;

const fixtures = [
  { file: 'chat-ai-sdk.jsonl', path: '/api/chat', label: 'AI SDK UI message stream over SSE' },
  { file: 'chat-ag-ui.jsonl', path: '/api/ag-ui', label: 'AG-UI event stream over SSE' },
  { file: 'chat-legacy.jsonl', path: '/api/chat-legacy', label: 'AI SDK legacy data stream over NDJSON' },
  { file: 'chat-ndjson.jsonl', path: '/api/chat-ndjson', label: 'plain NDJSON text deltas' },
  { file: 'plain-text.jsonl', path: '/api/plain', label: 'text/plain token stream' },
];

const demo = spawn(process.execPath, [path.join(root, 'demo', 'server.mjs'), '--port', String(demoPort)], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('demo server did not start')), 8000);
  demo.stdout.on('data', (chunk) => {
    if (String(chunk).includes('http://127.0.0.1')) {
      clearTimeout(timer);
      resolve();
    }
  });
  demo.on('error', reject);
});

const recorded = [];
const proxy = await startRecordingProxy({
  target: `http://127.0.0.1:${demoPort}`,
  port: proxyPort,
  outDir: streamsDir,
  log: false,
  onSession: (trace) => recorded.push(trace),
});

await fs.mkdir(tracesDir, { recursive: true });
const written = [];
for (const fixture of fixtures) {
  const before = recorded.length;
  const response = await fetch(`http://127.0.0.1:${proxyPort}${fixture.path}?fast=1`);
  const body = await response.text();
  if (!response.ok) throw new Error(`${fixture.path} -> HTTP ${response.status}`);
  const started = Date.now();
  while (recorded.length === before && Date.now() - started < 5000) await new Promise((r) => setTimeout(r, 20));
  const trace = recorded[recorded.length - 1];
  if (!trace) throw new Error(`no trace recorded for ${fixture.path}`);
  const text = await fs.readFile(trace.path, 'utf8');
  const lines = text.split('\n');
  const meta = JSON.parse(lines[0]);
  meta.session = path.basename(fixture.file, '.jsonl');
  meta.notes = { ...(meta.notes ?? {}), demo: fixture.label, endpoint: fixture.path };
  lines[0] = JSON.stringify(meta);
  const out = path.join(tracesDir, fixture.file);
  await fs.writeFile(out, lines.join('\n'), 'utf8');
  written.push({ file: out, frames: trace.frames.length, bytes: body.length, adapter: trace.meta.adapter });
  console.log(`recorded ${fixture.path} -> ${path.relative(root, out)} (${trace.frames.length} frames, ${trace.meta.adapter})`);
}

await proxy.close();
demo.kill('SIGTERM');
console.log(`\n${written.length} traces written to demo/traces/`);
