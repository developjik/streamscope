import './style.css';
import { applyFaults, parseScenario } from '../../src/faults.js';
import { renderPanelHtml } from '../../src/ui/panel.js';
import { parseInput, encodeShare, decodeShare, MAX_BYTES } from './model.js';
const $ = <T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const input=$<HTMLTextAreaElement>('trace'),fault=$<HTMLInputElement>('fault'),panel=$<HTMLIFrameElement>('panel'),link=$<HTMLInputElement>('link'),consent=$<HTMLInputElement>('consent');
function status(text:string,bad=false){$('status').textContent=text;$('status').className=bad?'error':'ok';}
let generation=0;
function invalidate(){generation++;link.value='';consent.checked=false;history.replaceState(null,'',location.pathname+location.search);}
const samples:Record<string,string>={};
for(const kind of ['normal','disconnect','error']){
 const events:any[]=[{type:'run-start'},{type:'text-delta',delta:'Let me check the order. '},{type:'tool-call-delta',id:'check',name:'lookup_order',argsDelta:'{"order":'},{type:'tool-call-delta',id:'check',argsDelta:'"DEMO-42"}'},{type:'tool-result',id:'check',result:{status:'shipped'}},{type:'text-delta',delta:'Your synthetic order is on its way.'},{type:'finish',reason:'stop'}];
 if(kind==='disconnect')events.splice(4);if(kind==='error')events.splice(4,3,{type:'error',status:429,message:'Synthetic rate limit. Try again later.'});
 samples[kind]=[JSON.stringify({v:1,kind:'meta',session:'example-'+kind,adapter:'sse',framing:'sse',protocol:'generic',startedAt:'2026-01-01T00:00:00Z'}),...events.map((event,seq)=>JSON.stringify({seq,t_ms:seq*220,raw:'data: '+JSON.stringify(event)+'\n\n',event}))].join('\n')+'\n';
}
function load(){
 try{
  const trace=parseInput(input.value);if(fault.value.length>200)throw new Error('Fault scenario exceeds 200 characters.');
  const faults=parseScenario(fault.value);if(faults.length>12)throw new Error('Maximum 12 faults per replay.');
  if(trace.frames.length * 2 ** faults.filter(f=>f.kind==='dup').length > 4000)throw new Error('Fault scenario could create too many frames.');
  const applied=applyFaults(trace.frames,faults,{meta:trace.meta});if(applied.frames.length>4000)throw new Error('Fault scenario creates too many frames.');
  // Opaque sandbox prevents input traces from accessing parent state or network.
  panel.srcdoc=renderPanelHtml(trace,{frames:applied.frames,inject:faults,title:'streamscope / '+trace.meta.session}).replace('<head>','<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; connect-src \'none\'; img-src \'none\'; form-action \'none\'; base-uri \'none\'">');
  $('result').textContent=applied.frames.length+' frames / '+(faults.length?'faults applied':'recorded');
  status('Loaded '+trace.meta.session+'. Playback is local.');
 }catch(e){panel.srcdoc='';$('result').textContent='No valid replay';status(e instanceof Error?e.message:'Could not load trace.',true);}
}
document.querySelectorAll<HTMLButtonElement>('[data-example]').forEach(b=>b.onclick=()=>{invalidate();input.value=samples[b.dataset.example!]!;fault.value='';load();});
$('load').onclick=()=>{invalidate();load();};$('apply').onclick=()=>{invalidate();load();};
input.oninput=invalidate;fault.oninput=invalidate;
async function fileLoad(file:File){invalidate();const g=generation;try{if(file.size>MAX_BYTES)throw new Error('File exceeds 512 KiB.');const text=await file.text();if(g!==generation)return;input.value=text;fault.value='';load();}catch(e){status(String(e),true);}}
$<HTMLInputElement>('file').onchange=e=>{const f=(e.target as HTMLInputElement).files?.[0];if(f)void fileLoad(f);};
input.ondragover=e=>e.preventDefault();input.ondrop=e=>{e.preventDefault();const f=e.dataTransfer?.files[0];if(f)void fileLoad(f);};
$('share').onclick=async()=>{try{if(!consent.checked)throw new Error('Check the trace for private data and confirm first.');const g=generation;const fragment=await encodeShare(input.value,fault.value);if(g!==generation)return;link.value=location.origin+location.pathname+fragment;status('Link created. It contains the full trace. Copy it only to intended recipients.');}catch(e){link.value='';status(e instanceof Error?e.message:String(e),true);}};
$('clear').onclick=()=>{invalidate();input.value='';fault.value='';panel.srcdoc='';$<HTMLInputElement>('file').value='';$('result').textContent='No trace loaded';status('Cleared from this page.');};
function openHash(){if(location.hash){const g=++generation;decodeShare(location.hash).then(v=>{if(g!==generation)return;link.value='';consent.checked=false;input.value=v.text;fault.value=v.scenario;load();}).catch(e=>{if(g!==generation)return;panel.srcdoc='';$('result').textContent='No valid replay';status('Cannot open share: '+String(e),true);});}}
window.addEventListener('hashchange',openHash);
if(location.hash)openHash();else{input.value=samples.normal!;load();}
