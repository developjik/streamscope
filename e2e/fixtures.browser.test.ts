import { expect, test } from 'vitest';
import { createTraceFetch, toMatchTrace } from '../src/vitest.js';
import type { Trace } from '../src/types.js';
// Vite imports the actual recording as text, then browser-native JSON handles JSONL.
import jsonl from '../demo/traces/chat-ag-ui.jsonl?raw';
expect.extend({ toMatchTrace });
test('recording-backed browser-mode fetch passes and a changed frame fails', async () => {
  const [meta, ...frames] = jsonl.trim().split('\n').map(line => JSON.parse(line));
  const trace: Trace = { meta, frames };
  const response = await createTraceFetch(trace)('/chat');
  expect(await response.text()).toBe(frames.map(frame => frame.raw).join(''));
  expect(trace).toMatchTrace(trace);
  const changed = structuredClone(trace);
  changed.frames[0]!.event.type = 'unknown';
  expect(() => expect(changed).toMatchTrace(trace)).toThrow('frame 0');
});
