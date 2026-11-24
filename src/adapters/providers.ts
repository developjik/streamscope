import type { NormalizedEvent, Protocol } from '../types.js';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value !== null && typeof value === 'object' ? value as Obj : {};
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
/** Recognize provider SSE event names, not just generic payload shapes. */
export function providerEvents(name: string | undefined, payload: string, hint?: Protocol): { protocol: Protocol; events: NormalizedEvent[] } | undefined {
  if (name === 'error' && hint !== 'langgraph') return;
  if (!name || (!name.startsWith('thread.') && !['metadata', 'messages', 'messages-tuple', 'end', 'error'].includes(name))) return;
  let value: unknown;
  try { value = JSON.parse(payload); } catch { return; }
  const data = object(value);
  if (name.startsWith('thread.')) {
    const protocol: Protocol = 'openai-assistants';
    const id = str(data.id);
    if (name === 'thread.run.created') return { protocol, events: [{ type: 'run-start', id, data: value }] };
    if (name === 'thread.run.completed') return { protocol, events: [{ type: 'finish', id, reason: 'stop', data: value }] };
    if (['thread.run.failed', 'thread.run.cancelled', 'thread.run.expired'].includes(name)) return { protocol, events: [{ type: 'error', id, message: str(object(data.last_error).message) ?? name, data: value }] };
    if (name === 'thread.message.delta') {
      const content = object(data.delta).content;
      const events: NormalizedEvent[] = [];
      if (Array.isArray(content)) for (const item of content) {
        const text = str(object(object(item).text).value);
        if (text !== undefined) events.push({ type: 'text-delta', id, delta: text, data: { ...data, delta: { ...object(data.delta), content: [item] } } });
        else events.push({ type: 'lifecycle', id, name, data: { ...data, delta: { ...object(data.delta), content: [item] } } });
      }
      return { protocol, events: events.length ? events : [{ type: 'lifecycle', id, name, data: value }] };
    }
    if (name === 'thread.run.step.delta') {
      const calls = object(object(data.delta).step_details).tool_calls;
      const events: NormalizedEvent[] = [];
      if (Array.isArray(calls)) for (const item of calls) {
        const call = object(item); const fn = object(call.function);
        events.push({ type: 'tool-call-delta', id: str(call.id), name: str(fn.name), argsDelta: str(fn.arguments), data: { ...data, delta: { ...object(data.delta), step_details: { ...object(object(data.delta).step_details), tool_calls: [item] } } } });
      }
      return { protocol, events: events.length ? events : [{ type: 'lifecycle', id, name, data: value }] };
    }
    return { protocol, events: [{ type: 'lifecycle', id, name, data: value }] };
  }
  const protocol: Protocol = 'langgraph';
  if (name === 'metadata') return { protocol, events: [{ type: 'run-start', id: str(data.run_id), data: value }] };
  if (name === 'end') return { protocol, events: [{ type: 'finish', id: str(data.run_id), reason: str(data.status) ?? 'stop', data: value }] };
  if (name === 'error') return { protocol, events: [{ type: 'error', message: str(data.message) ?? str(data.error) ?? 'LangGraph stream error', data: value }] };
  if (name === 'messages' || name === 'messages-tuple') {
    const message = object(Array.isArray(value) ? value[0] : value);
    const content = message.content;
    const events: NormalizedEvent[] = [];
    if (typeof content === 'string' && (content !== '' || !Array.isArray(message.tool_call_chunks) || message.tool_call_chunks.length === 0)) events.push({ type: 'text-delta', id: str(message.id), delta: content, data: [{ ...message, content, tool_call_chunks: undefined }, ...(Array.isArray(value) ? value.slice(1) : [{}])] });
    else if (Array.isArray(content)) for (const block of content) { const text = str(object(block).text); if (text !== undefined) events.push({ type: 'text-delta', id: str(message.id), delta: text, data: [{ ...message, content: [block], tool_call_chunks: undefined }, ...(Array.isArray(value) ? value.slice(1) : [{}])] }); }
    if (Array.isArray(message.tool_call_chunks)) for (const item of message.tool_call_chunks) { const call = object(item); events.push({ type: 'tool-call-delta', id: str(call.id), name: str(call.name), argsDelta: str(call.args), data: [{ ...message, content: '', tool_call_chunks: [item] }, ...(Array.isArray(value) ? value.slice(1) : [{}])] }); }
    return { protocol, events: events.length ? events : [{ type: 'lifecycle', name, data: value }] };
  }
}

/** Re-encode synthesized/mutated events so provider clients retain their SSE envelope. */
export function providerWire(event: NormalizedEvent, protocol: Protocol): string | undefined {
  let name: string; let data: unknown;
  const original = object(event.data);
  const tuple = Array.isArray(event.data) ? event.data : [];
  const message = object(tuple[0]);
  const metadata = tuple[1] ?? {};
  if (protocol === 'openai-assistants') {
    switch (event.type) {
      case 'text-delta': name = 'thread.message.delta'; data = { ...original, id: event.id, delta: { ...object(original.delta), content: [{ ...object((object(original.delta).content as unknown[] | undefined)?.[0]), type: 'text', text: { ...object(object((object(original.delta).content as unknown[] | undefined)?.[0]).text), value: event.delta ?? '' } }] } }; break;
      case 'tool-call-delta': name = 'thread.run.step.delta'; data = { ...original, delta: { ...object(original.delta), step_details: { ...object(object(original.delta).step_details), tool_calls: [{ ...object((object(object(original.delta).step_details).tool_calls as unknown[] | undefined)?.[0]), id: event.id, type: 'function', function: { name: event.name, arguments: event.argsDelta ?? '' } }] } } }; break;
      case 'run-start': name = 'thread.run.created'; data = { id: event.id }; break;
      case 'finish': name = 'thread.run.completed'; data = { id: event.id }; break;
      case 'error': name = 'thread.run.failed'; data = { id: event.id, last_error: { message: event.message, code: event.status } }; break;
      default: name = event.name?.startsWith('thread.') ? event.name : 'thread.unknown'; data = event.data ?? event;
    }
  } else if (protocol === 'langgraph') {
    switch (event.type) {
      case 'text-delta': name = 'messages'; data = [{ ...message, id: event.id, content: event.delta ?? '', tool_call_chunks: undefined }, metadata]; break;
      case 'tool-call-delta': name = 'messages'; data = [{ ...message, content: '', tool_call_chunks: [{ ...object((message.tool_call_chunks as unknown[] | undefined)?.[0]), id: event.id, name: event.name, args: event.argsDelta ?? '' }] }, metadata]; break;
      case 'run-start': name = 'metadata'; data = { run_id: event.id }; break;
      case 'finish': name = 'end'; data = { run_id: event.id, status: event.reason ?? 'success' }; break;
      case 'error': name = 'error'; data = { message: event.message, code: event.status }; break;
      default: name = event.name ?? 'custom'; data = event.data ?? event;
    }
  } else return;
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}
