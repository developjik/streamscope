import { expect, test } from 'vitest';
import { createAdapter } from '../src/adapters/index.js';
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
test('OpenAI Assistants SSE maps run, message text, tool args and completion across chunks', () => {
  const wire = frame('thread.run.created', { id: 'r1' }) + frame('thread.message.delta', { id: 'm1', delta: { content: [{ type: 'text', text: { value: 'Hello' } }] } }) + frame('thread.run.step.delta', { delta: { step_details: { tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":"hi"}' } }] } } }) + frame('thread.run.completed', { id: 'r1' });
  const adapter = createAdapter({ contentType: 'text/event-stream' });
  const events = [];
  for (let i = 0; i < wire.length; i += 7) events.push(...adapter.feed(wire.slice(i, i + 7)));
  events.push(...adapter.flush());
  expect(adapter.protocol).toBe('openai-assistants');
  expect(events.map(f => f.event.type)).toEqual(['run-start', 'text-delta', 'tool-call-delta', 'finish']);
  expect(events[1]!.event.delta).toBe('Hello');
  expect(events[2]!.event.argsDelta).toBe('{"q":"hi"}');
});
test('OpenAI terminal failures and unknown events remain visible', () => {
  const adapter = createAdapter({ framing: 'sse' });
  expect(adapter.feed(frame('thread.run.failed', { id: 'r1', last_error: { message: 'quota' } }))[0]!.event).toMatchObject({ type: 'error', message: 'quota' });
  expect(adapter.feed(frame('thread.new_event', { id: 'x' }))[0]!.event).toMatchObject({ type: 'lifecycle', name: 'thread.new_event' });
});
test('LangGraph SDK message tuples map text and tool chunks, not metadata as text', () => {
  const adapter = createAdapter({ framing: 'sse' });
  const events = adapter.feed(frame('metadata', { run_id: 'r2' }) + frame('messages', [{ id: 'm2', content: 'Hi', tool_call_chunks: [{ id: 't2', name: 'tool', args: '{' }] }, { langgraph_node: 'model' }]) + frame('messages-tuple', [{ id: 'm2', content: [{ type: 'text', text: ' there' }] }, {}]) + frame('end', { run_id: 'r2', status: 'success' }));
  expect(adapter.protocol).toBe('langgraph');
  expect(events.map(f => f.event.type)).toEqual(['run-start', 'text-delta', 'tool-call-delta', 'text-delta', 'finish']);
  expect(events[3]!.event.delta).toBe(' there');
});
test('LangGraph errors and malformed payloads do not crash existing SSE', () => {
  const adapter = createAdapter({ framing: 'sse', protocol: 'langgraph' });
  expect(adapter.feed(frame('error', { message: 'failed' }))[0]!.event).toMatchObject({ type: 'error', message: 'failed' });
  expect(() => adapter.feed('event: messages\ndata: not json\n\n')).not.toThrow();
});

test('generic SSE error is not automatically mislabeled as LangGraph', () => {
  const adapter = createAdapter({ framing: 'sse' });
  adapter.feed(frame('error', { message: 'generic' }));
  expect(adapter.protocol).not.toBe('langgraph');
});

test('provider fault encoding round-trips a mutated tool argument', async () => {
  const { defaultEncoder } = await import('../src/faults.js');
  for (const protocol of ['langgraph', 'openai-assistants'] as const) {
    const encode = defaultEncoder({ framing: 'sse', protocol });
    const adapter = createAdapter({ framing: 'sse', protocol });
    const event = adapter.feed(encode({ type: 'tool-call-delta', id: 'tool', argsDelta: '{' })).find(frame => frame.event.type === 'tool-call-delta')!.event;
    expect(event.argsDelta).toBe('{');
  }
});


test('multiple provider deltas replay once and permit dropping or truncating a single delta', async () => {
  const { prepareReplay } = await import('../src/replay.js');
  for (const protocol of ['openai-assistants', 'langgraph'] as const) {
    const wire = protocol === 'langgraph' ? frame('messages', [{id:'m',content:'Hi',tool_call_chunks:[{id:'t',index:2,name:'tool',args:'{"long":true}'}]},{node:'model'}]) : frame('thread.run.step.delta',{id:'step',delta:{step_details:{type:'tool_calls',tool_calls:[{id:'a',index:0,function:{arguments:'{"x":true}'}},{id:'b',index:1,function:{arguments:'{"y":true}'}}]}}});
    const adapter = createAdapter({framing:'sse',protocol}); const frames=adapter.feed(wire).map((f,seq)=>({...f,seq,t_ms:0}));
    const trace={meta:{v:1,kind:'meta',session:'multi',adapter:protocol,framing:'sse',protocol,startedAt:'2026-01-01'},frames} as import('../src/types.js').Trace;
    const replay=(raw:string)=>createAdapter({framing:'sse',protocol}).feed(raw);
    expect(replay(frames.map(f=>f.raw).join('')).map(f=>f.event.type)).toEqual(frames.map(f=>f.event.type));
    const dropped=prepareReplay(trace,{inject:'drop(1)'}); expect(replay(dropped.frames.map(f=>f.raw).join(''))).toHaveLength(1);
    const cut=prepareReplay(trace,{inject:'truncate_tool_args(1)'});const tool=replay(cut.frames.map(f=>f.raw).join('')).filter(f=>f.event.type==='tool-call-delta');expect(tool.every(f=>f.event.argsDelta==='{')).toBe(true);
    if(protocol==='openai-assistants') expect(cut.frames[1]!.raw).toContain('"index":1');
    else expect(cut.frames[1]!.raw).toContain('"node":"model"');
  }
});
test('non-text message deltas remain recorded and replayable',()=>{
  const adapter=createAdapter({framing:'sse'});
  const wire=frame('thread.message.delta',{id:'m',delta:{content:[{index:0,type:'image_file',image_file:{file_id:'img'}},{index:1,type:'text',text:{annotations:[{index:0,type:'file_citation'}]}}]}});
  const frames=adapter.feed(wire);expect(frames).toHaveLength(2);expect(frames.every(f=>f.event.type==='lifecycle')).toBe(true);
  const again=createAdapter({framing:'sse'}).feed(frames.map(f=>f.raw).join(''));expect(again).toHaveLength(2);expect(again[0]!.raw).toContain('img');expect(again[1]!.raw).toContain('file_citation');
});
