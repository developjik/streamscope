/**
 * streamscope demo app — no dependencies on purpose.
 *
 *   node demo/server.mjs [--port 8790]
 *
 * Endpoints (all stream tokens slowly so a person can watch the UI):
 *   /api/chat         Vercel AI SDK UI message stream (SSE)
 *   /api/ag-ui        AG-UI event stream (SSE)
 *   /api/chat-legacy  Vercel AI SDK legacy data stream (NDJSON)
 *   /api/chat-ndjson  plain NDJSON `{"type":"text-delta"}` frames
 *   /api/plain        text/plain token stream
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const portArgIndex = process.argv.indexOf('--port');
const PORT = portArgIndex !== -1 ? Number(process.argv[portArgIndex + 1]) : Number(process.env.PORT ?? 8790);

const answer = [
  'Sure — ',
  'I checked the order ',
  'and it shipped ',
  'yesterday. ',
  'Want me to ',
  'reschedule the delivery?',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sse(res, chunk, { event } = {}) {
  res.write(`${event ? `event: ${event}\n` : ''}data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`);
}

async function aiSdkChat(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const fast = req.url.includes('fast');
  const delay = fast ? 5 : 70;
  const messageId = 'msg_demo_1';
  try {
    sse(res, { type: 'start', messageId });
    for (const token of answer) {
      sse(res, { type: 'text-delta', id: messageId, delta: token });
      await sleep(delay);
    }
    const toolCallId = 'call_track_1';
    sse(res, { type: 'tool-input-start', toolCallId, toolName: 'track_shipment' });
    await sleep(delay);
    for (const fragment of ['{"order', 'Id":"A-10', '42"}']) {
      sse(res, { type: 'tool-input-delta', toolCallId, inputTextDelta: fragment });
      await sleep(delay);
    }
    sse(res, { type: 'tool-input-available', toolCallId, toolName: 'track_shipment', input: { orderId: 'A-1042' } });
    await sleep(delay);
    sse(res, { type: 'tool-output-available', toolCallId, output: { status: 'in_transit', eta: '2026-11-23' } });
    await sleep(delay);
    sse(res, { type: 'text-delta', id: messageId, delta: ' Tracking says it is in transit.' });
    await sleep(delay);
    sse(res, { type: 'tool-approval-request', approvalId: 'approval_1', toolCallId, toolName: 'reschedule_delivery' });
    await sleep(delay);
    sse(res, { type: 'finish', finishReason: 'stop' });
  } finally {
    res.end();
  }
}

async function agUiChat(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const delay = req.url.includes('fast') ? 5 : 70;
  try {
    sse(res, { type: 'RUN_STARTED', threadId: 'thread_1', runId: 'run_1' });
    sse(res, { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' });
    for (const token of answer) {
      sse(res, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: token });
      await sleep(delay);
    }
    sse(res, { type: 'TEXT_MESSAGE_END', messageId: 'm1' });
    sse(res, { type: 'TOOL_CALL_START', toolCallId: 'tc1', toolCallName: 'track_shipment', parentMessageId: 'm1' });
    for (const fragment of ['{"order', 'Id":"A-10', '42"}']) {
      sse(res, { type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: fragment });
      await sleep(delay);
    }
    sse(res, { type: 'TOOL_CALL_END', toolCallId: 'tc1' });
    sse(res, { type: 'TOOL_CALL_RESULT', messageId: 'm2', toolCallId: 'tc1', content: '{"status":"in_transit","eta":"2026-11-23"}', role: 'tool' });
    await sleep(delay);
    sse(res, { type: 'RUN_FINISHED', threadId: 'thread_1', runId: 'run_1' });
  } finally {
    res.end();
  }
}

async function legacyChat(req, res) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
  const delay = req.url.includes('fast') ? 5 : 60;
  try {
    for (const token of answer) {
      res.write(`0:${JSON.stringify(token)}\n`);
      await sleep(delay);
    }
    res.write(`9:${JSON.stringify({ toolCallId: 'call_1', toolName: 'track_shipment', args: { orderId: 'A-1042' } })}\n`);
    await sleep(delay);
    res.write(`a:${JSON.stringify({ toolCallId: 'call_1', result: { status: 'in_transit' } })}\n`);
    res.write(`d:${JSON.stringify({ finishReason: 'stop', usage: { promptTokens: 42, completionTokens: 88 } })}\n`);
  } finally {
    res.end();
  }
}

async function ndjsonChat(req, res) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
  const delay = req.url.includes('fast') ? 5 : 60;
  try {
    for (const token of answer) {
      res.write(`${JSON.stringify({ type: 'text-delta', id: 'm1', delta: token })}\n`);
      await sleep(delay);
    }
    res.write(`${JSON.stringify({ type: 'finish', reason: 'stop' })}\n`);
  } finally {
    res.end();
  }
}

async function plainText(req, res) {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
  for (const token of answer) {
    res.write(token);
    await sleep(req.url.includes('fast') ? 5 : 60);
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  try {
    switch (url.pathname) {
      case '/':
      case '/index.html': {
        const html = await readFile(path.join(here, 'app.html'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      case '/api/chat':
        return void (await aiSdkChat(req, res));
      case '/api/ag-ui':
        return void (await agUiChat(req, res));
      case '/api/chat-legacy':
        return void (await legacyChat(req, res));
      case '/api/chat-ndjson':
        return void (await ndjsonChat(req, res));
      case '/api/plain':
        return void (await plainText(req, res));
      case '/health':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      default:
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found\n');
    }
  } catch (error) {
    if (!res.headersSent) res.writeHead(500);
    res.end(String(error));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`streamscope demo: http://127.0.0.1:${PORT}/`);
  console.log('  endpoints: /api/chat (AI SDK UI) /api/ag-ui /api/chat-legacy /api/chat-ndjson /api/plain');
});
