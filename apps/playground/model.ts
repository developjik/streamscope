import type { Trace } from '../../src/types.js';
import { parseTrace } from '../../src/trace-parse.js';
export const MAX_BYTES = 512 * 1024;
const encoder = new TextEncoder();
export function parseInput(text: string): Trace {
  if (encoder.encode(text).length > MAX_BYTES) throw new Error('Trace exceeds 512 KiB. Use the local CLI for larger traces.');
  const lines = text.split('\n').filter(x => x.trim());
  if (!lines.length) throw new Error('Paste JSONL or choose an example.');
  if (lines.length > 2001) throw new Error('Maximum 2000 frames.');
  const types = new Set(['text-delta','tool-call-delta','tool-result','approval','error','finish','run-start','lifecycle','unknown']);
  let meta = 0, frames = 0, lastSeq = -1, lastTime = -1;
  lines.forEach((line, i) => {
    let r: any;
    try { r = JSON.parse(line); } catch { throw new Error(`Line ${i + 1}: invalid JSON.`); }
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error(`Line ${i + 1}: expected an object.`);
    if (r.kind === 'meta') {
      if (++meta > 1 || i !== 0 || r.v !== 1 || !['sse','ndjson','json','raw'].includes(r.framing) || !['ag-ui','ai-sdk','ai-sdk-data','openai-assistants','langgraph','generic'].includes(r.protocol) || typeof r.session !== 'string' || typeof r.adapter !== 'string' || typeof r.startedAt !== 'string') throw new Error('First line must be one version 1 trace meta record.');
    } else {
      if (!Number.isSafeInteger(r.seq) || r.seq <= lastSeq || !Number.isFinite(r.t_ms) || r.t_ms < lastTime || r.t_ms < 0 || r.t_ms > 86400000 || typeof r.raw !== 'string' || !r.event || !types.has(r.event.type)) throw new Error(`Line ${i + 1}: invalid frame, order, time, raw text or event type.`);
      for (const k of ['id','name','delta','argsDelta','decision','message','reason']) if (r.event[k] !== undefined && typeof r.event[k] !== 'string') throw new Error(`Line ${i + 1}: event ${k} must be text.`);
      if (r.event.complete !== undefined && typeof r.event.complete !== 'boolean') throw new Error(`Line ${i+1}: complete must be boolean.`);
      if (r.event.status !== undefined && !Number.isFinite(r.event.status)) throw new Error(`Line ${i+1}: status must be numeric.`);
      lastSeq=r.seq; lastTime=r.t_ms; frames++;
    }
  });
  if (!meta || !frames) throw new Error('Trace needs one meta record and at least one frame.');
  return parseTrace(text);
}
export async function encodeShare(text: string, scenario: string): Promise<string> {
  parseInput(text);
  if (scenario.length > 200) throw new Error('Fault scenario exceeds 200 characters.');
  const packed = new Uint8Array(await new Response(new Blob([JSON.stringify({text,scenario})]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  let binary=''; for (const byte of packed) binary+=String.fromCharCode(byte);
  const fragment = '#trace='+btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  if (fragment.length>16000) throw new Error('Compressed share exceeds 16000 characters. Share a smaller sanitized trace instead.');
  return fragment;
}
export async function decodeShare(hash: string): Promise<{text:string;scenario:string}> {
  if (!/^#trace=[A-Za-z0-9_-]+$/.test(hash) || hash.length>16000) throw new Error('Invalid or oversized share link.');
  const packed=Uint8Array.from(atob(hash.slice(7).replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
  const reader=new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const chunks:Uint8Array[]=[];let size=0;
  try { while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES*2+4096)throw new Error('Expanded share is too large.');chunks.push(value);} } finally {await reader.cancel();}
  const all=new Uint8Array(size);let at=0;for(const c of chunks){all.set(c,at);at+=c.length;}
  const value=JSON.parse(new TextDecoder().decode(all));
  if(typeof value.text!=='string'||typeof value.scenario!=='string'||value.scenario.length>200)throw new Error('Invalid shared payload.');
  parseInput(value.text);return value;
}
