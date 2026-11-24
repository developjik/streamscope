import {describe,test,expect} from 'vitest';
import {parseInput,encodeShare,decodeShare,MAX_BYTES} from '../apps/playground/model.js';
import {parseTrace} from '../src/trace.js';
import {truncateUtf8} from '../src/faults.js';
const meta={v:1,kind:'meta',session:'test',adapter:'sse',framing:'sse',protocol:'generic',startedAt:'2026-01-01'};
const frame={seq:0,t_ms:0,raw:'data: demo',event:{type:'text-delta',delta:'hello'}};
const text=JSON.stringify(meta)+'\n'+JSON.stringify(frame);
describe('bounded browser trace input',()=>{
 test('uses shared parser without changing CLI tolerance',()=>{expect(parseInput(text)).toEqual(parseTrace(text));expect(parseTrace(text+'\n{truncated').frames).toHaveLength(1);expect(()=>parseInput(text+'\n{truncated')).toThrow('Line 3');});
 test('rejects empty, malformed, non-trace and dangerous event shapes',()=>{for(const input of ['', '{}','null','[1]',JSON.stringify(meta),JSON.stringify(frame),JSON.stringify(meta)+'\n'+JSON.stringify({...frame,event:{type:'constructor'}}),JSON.stringify(meta)+'\n'+JSON.stringify({...frame,event:{type:'text-delta',delta:{x:1}}}),text+'\n'+JSON.stringify(frame)])expect(()=>parseInput(input)).toThrow();});
 test('bounds bytes, frames, clocks and order',()=>{expect(()=>parseInput('x'.repeat(MAX_BYTES+1))).toThrow('512');for(const t_ms of [-1,Infinity,86400001])expect(()=>parseInput(JSON.stringify(meta)+'\n'+JSON.stringify({...frame,t_ms}))).toThrow();expect(()=>parseInput(JSON.stringify(meta)+'\n'+Array.from({length:2001},(_,seq)=>JSON.stringify({...frame,seq})).join('\n'))).toThrow('2000');});
 test('compressed fragment round trip and corrupt links',async()=>{const hash=await encodeShare(text,'slow(40)');expect(hash).toMatch(/^#trace=/);expect(await decodeShare(hash)).toEqual({text,scenario:'slow(40)'});for(const h of ['#trace=!', '#trace='+'x'.repeat(16000),'#trace=abcd'])await expect(decodeShare(h)).rejects.toThrow();});
 test('bounds decompressed input',async()=>{const bytes=new Uint8Array(await new Response(new Blob(['x'.repeat(MAX_BYTES*2+10000)]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());let s='';for(const b of bytes)s+=String.fromCharCode(b);await expect(decodeShare('#trace='+btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''))).rejects.toThrow('large');});
 test('UTF8 truncation works without Node Buffer',()=>{expect(truncateUtf8('한글🙂abc',8)).toBe('한글');expect(truncateUtf8('한글🙂abc',10)).toBe('한글🙂');});
});
