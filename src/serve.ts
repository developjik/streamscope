import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { startRecordingProxy, type ProxyOptions } from './proxy.js';
import { handleReplayRequest, prepareReplay, type ReplayOptions } from './replay.js';
import { parseTrace } from './trace.js';
import { escapeHtml } from './ui/panel.js';

export interface ServeOptions extends ProxyOptions { panelPort?: number; speed?: number }
export interface ServeHandle { proxyUrl: string; url: string; close(): Promise<void> }
/** Bind failures reject startup rather than escaping as uncaught server errors. */
export function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve,reject)=>{const error=(e:Error)=>{server.off('listening',ready);reject(new Error(`streamscope: cannot listen on ${host}:${port}: ${e.message}`));}; const ready=()=>{server.off('error',error);resolve();};server.once('error',error);server.once('listening',ready);server.listen(port,host);});
}
export async function startServe(options: ServeOptions): Promise<ServeHandle> {
  for (const [name,value] of [['port',options.port??8787],['panelPort',options.panelPort??8788]] as const) if(!Number.isInteger(value)||value<0||value>65535)throw new Error(`${name} must be an integer from 0 to 65535`);
  if(!Number.isFinite(options.speed??1)||(options.speed??1)<0)throw new Error('speed must be nonnegative and finite');
  const token=randomBytes(24).toString('hex');const prefix='/'+token;
  const root=path.resolve(options.outDir??'.streams'); await fs.mkdir(root,{recursive:true});
  const lock=path.join(root,'.streamscope-serve.lock');
  let guard;try{guard=await fs.open(lock,'wx',0o600);}catch{throw new Error(`streamscope: session root already in use (or not writable): ${root}. If a previous process crashed, remove only its stale .streamscope-serve.lock after checking it stopped.`);}
  try{await guard.writeFile(String(process.pid));}catch(error){await guard.close();await fs.unlink(lock);throw error;}
  let proxy:Awaited<ReturnType<typeof startRecordingProxy>>|undefined;
  const server=http.createServer((req,res)=>{void route(req,res).catch(error=>{if(res.headersSent){res.destroy();return;}res.writeHead(400,{'content-type':'text/plain'});res.end(`Session unavailable: ${error instanceof Error?error.message:String(error)}`);});});
  const active=new Set<string>();
  let closed=false;
  const close=async()=>{if(closed)return;closed=true;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await proxy?.close();await guard.close();await fs.unlink(lock);};
  async function session(id:string){
    if(!id||id==='.'||id==='..'||/[\\/\x00-\x1f]/.test(id))throw new Error('Invalid session id');
    const dir=path.join(root,id),file=path.join(dir,'events.jsonl');
    if(active.has(file)||await fs.lstat(path.join(dir,'.recording')).then(()=>true,()=>false))throw new Error('Session still recording');
    const [d,f]=await Promise.all([fs.lstat(dir),fs.lstat(file)]);
    if(!d.isDirectory()||!f.isFile()||f.size>10_000_000)throw new Error('Session is not a regular trace below 10MB');
    const base=await fs.realpath(root),resolved=await fs.realpath(file);if(!resolved.startsWith(base+path.sep))throw new Error('Session outside root');
    const fd=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    let text:string;
    try {
      const stat=await fd.stat();const after=await fs.lstat(file);const parent=await fs.lstat(dir);
      if(!stat.isFile()||stat.size>10_000_000||stat.ino!==f.ino||stat.dev!==f.dev||after.ino!==stat.ino||after.dev!==stat.dev||parent.ino!==d.ino||parent.dev!==d.dev)throw new Error('Session changed while opening');
      if(process.platform==='linux'){const opened=await fs.realpath('/proc/self/fd/'+fd.fd);if(!opened.startsWith(base+path.sep))throw new Error('Opened file outside root');}
      const buffer=Buffer.alloc(10_000_001);let count=0;while(count<buffer.length){const read=await fd.read(buffer,count,buffer.length-count,null);if(!read.bytesRead)break;count+=read.bytesRead;}if(count>10_000_000)throw new Error('Trace exceeds10MB');text=buffer.subarray(0,count).toString('utf8');
    } finally {await fd.close();}
    if(active.has(file))throw new Error('Session still recording');
    const first=JSON.parse(text.split('\n').find(line=>line.trim())??'null') as Record<string,unknown>|null;
    if(!first||first.kind!=='meta'||first.v!==1||typeof first.session!=='string'||typeof first.adapter!=='string'||!['sse','ndjson','json','raw'].includes(String(first.framing)))throw new Error('Invalid trace metadata');
    const trace=parseTrace(text,file);if(trace.frames.some(f=>typeof f.raw!=='string'||!f.event||typeof f.event.type!=='string'))throw new Error('Invalid trace frames');return trace;
  }
  async function route(req:http.IncomingMessage,res:http.ServerResponse){
    if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405,{'allow':'GET, HEAD'});res.end();return;}
    const url=new URL(req.url??'/','http://localhost');
    if(!url.pathname.startsWith(prefix+'/')){res.writeHead(404);res.end('not found');return;}url.pathname=url.pathname.slice(prefix.length);
    res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');
    if(url.pathname==='/'){
      const entries=(await fs.readdir(root,{withFileTypes:true})).filter(e=>e.isDirectory()).sort((a,b)=>b.name.localeCompare(a.name));
      const rows:string[]=[];
      for(const entry of entries.slice(0,500)){try{const t=await session(entry.name);rows.push(`<li><a href="${prefix}/sessions/${encodeURIComponent(entry.name)}">${escapeHtml(entry.name)}</a><span>${t.frames.length} frames · ${escapeHtml(t.meta.adapter)}</span></li>`);}catch{rows.push(`<li>${escapeHtml(entry.name)}<span>Unavailable or still recording</span></li>`);}}
      res.setHeader('content-security-policy',"default-src 'none'; style-src 'unsafe-inline'");res.setHeader('content-type','text/html; charset=utf-8');res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>streamscope sessions</title><style>body{font:16px system-ui;background:#111827;color:#e5e7eb;max-width:1000px;margin:48px auto;padding:0 24px}a{color:#93c5fd}li{padding:20px;border:1px solid #374151;margin:12px 0;border-radius:10px;overflow-wrap:anywhere}span{display:block;color:#9ca3af;margin-top:8px}ul{padding:0;list-style:none}</style><h1>streamscope sessions</h1><p>Record through the proxy, then refresh this list. Select a session to replay its timeline.</p><p><a href="${prefix}/">Refresh sessions</a> · ${entries.length} session directories${entries.length>500?' (showing newest 500)':''}</p><ul>${rows.join('')||'<li>No sessions yet. Send a streaming request through the recording proxy.</li>'}</ul></html>`);return;
    }
    const m=/^\/sessions\/([^/]+)(?:\/(stream|trace.json))?$/.exec(url.pathname);
    if(!m){res.writeHead(404);res.end('not found');return;}
    const trace=await session(decodeURIComponent(m[1]!));const replay:ReplayOptions={speed:options.speed??1};
    if(!m[2]){const {renderPanelHtml}=await import('./ui/panel.js');res.setHeader('content-type','text/html; charset=utf-8');res.end(renderPanelHtml(trace).replace('<body>',`<body><nav style="padding:12px"><a href="${prefix}/" style="color:#93c5fd">← Sessions</a></nav>`));return;}
    req.url='/'+m[2];await handleReplayRequest(req,res,prepareReplay(trace,replay),trace,replay);
  }
  try {proxy=await startRecordingProxy({...options,port:options.port??8787,outDir:root,host:'127.0.0.1',onRecording:file=>{active.add(file);options.onRecording?.(file);},onSession:(trace,file)=>{active.delete(file);options.onSession?.(trace,file);}});await listen(server,options.panelPort??8788,'127.0.0.1');}
  catch(error){await close();throw error;}
  return {proxyUrl:proxy.url,url:`http://127.0.0.1:${(server.address() as AddressInfo).port}${prefix}/`,close};
}
