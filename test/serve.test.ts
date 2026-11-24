import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { expect,test } from 'vitest';
import { startServe } from '../src/serve.js';
import { startRecordingProxy } from '../src/proxy.js';
import { startReplayServer } from '../src/replay.js';
import { readTrace } from '../src/trace.js';

async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'streamscope-serve-'));const upstream=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content:req.url}}]})}\n\ndata: [DONE]\n\n`);});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');const addr=upstream.address();if(!addr||typeof addr==='string')throw new Error('port');return{root,target:`http://127.0.0.1:${addr.port}`,done:async()=>{upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));await fs.rm(root,{recursive:true,force:true});}};}
async function sessions(root:string){for(let i=0;i<100;i++){const dirs=(await fs.readdir(root)).filter(n=>!n.startsWith('.'));if(dirs.length)return dirs;await new Promise(r=>setTimeout(r,10));}throw new Error('no session');}
test('serve records, lists, switches and replays two sessions without restarting',async()=>{
 const f=await fixture();const h=await startServe({target:f.target,outDir:f.root,port:0,panelPort:0,speed:0});
 try{
  expect(await (await fetch(h.url)).text()).toContain('No sessions yet');
  await (await fetch(h.proxyUrl+'/first')).text();const first=(await sessions(f.root))[0]!;
  await new Promise(r=>setTimeout(r,20));await (await fetch(h.proxyUrl+'/second')).text();
  for(let i=0;i<100&&(await fs.readdir(f.root)).length<3;i++)await new Promise(r=>setTimeout(r,10));
  const ids=(await fs.readdir(f.root)).filter(n=>!n.startsWith('.'));expect(ids).toHaveLength(2);
  const list=await (await fetch(h.url)).text();for(const id of ids)expect(list).toContain(encodeURIComponent(id));
  for(const id of ids){const panel=await(await fetch(h.url+'sessions/'+encodeURIComponent(id))).text();expect(panel).toContain('← Sessions');const trace=await readTrace(path.join(f.root,id));expect(await(await fetch(h.url+'sessions/'+encodeURIComponent(id)+'/stream')).text()).toBe(trace.frames.map(x=>x.raw).join(''));expect(((await(await fetch(h.url+'sessions/'+encodeURIComponent(id)+'/trace.json')).json()) as {frames:unknown[]}).frames).toHaveLength(trace.frames.length);}
  expect(first).toBeTruthy();
  await expect(startServe({target:f.target,outDir:f.root,port:0,panelPort:0})).rejects.toThrow(/already in use/);
  await fs.mkdir(path.join(f.root,'bad'));await fs.writeFile(path.join(f.root,'bad','events.jsonl'),'not json');
  expect((await fetch(h.url+'sessions/bad/stream')).status).toBe(400);
  await fs.symlink(path.dirname(f.root),path.join(f.root,'escape'));
  expect((await fetch(h.url+'sessions/escape/stream')).status).toBe(400);
  expect((await fetch(h.url+'sessions/%2e%2e%2foutside/stream')).status).toBe(400);
  expect((await fetch(h.url,{method:'POST'})).status).toBe(405);
 }finally{await h.close();await h.close();await f.done();}
});
test('port conflicts reject clearly and release both proxy and root lock',async()=>{
 const f=await fixture();const blocker=http.createServer();blocker.listen(0,'127.0.0.1');await once(blocker,'listening');const addr=blocker.address();if(!addr||typeof addr==='string')throw new Error('port');
 try{
  for(const create of [()=>startServe({target:f.target,outDir:f.root,port:addr.port,panelPort:0}),()=>startServe({target:f.target,outDir:f.root,port:0,panelPort:addr.port}),()=>startRecordingProxy({target:f.target,port:addr.port}),()=>startReplayServer({trace:{meta:{v:1,kind:'meta',session:'x',adapter:'sse',framing:'sse',protocol:'generic',startedAt:new Date().toISOString()},frames:[]},port:addr.port})])await expect(create()).rejects.toThrow(/cannot listen/);
  const h=await startServe({target:f.target,outDir:f.root,port:0,panelPort:0});await h.close();expect(await fs.readdir(f.root)).toEqual([]);
 }finally{await new Promise<void>(r=>blocker.close(()=>r()));await f.done();}
});
test('built serve CLI exits cleanly on SIGTERM and releases listeners and lock',async()=>{
 execFileSync(process.platform==='win32'?'npm.cmd':'npm',['run','build'],{cwd:process.cwd(),stdio:'pipe'});
 const f=await fixture();const child=spawn(process.execPath,['dist/cli.js','serve','--target',f.target,'--port','0','--panel-port','0','--out',f.root,'--quiet'],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',d=>output+=d.toString());let error='';child.stderr.on('data',d=>error+=d.toString());
 try{
  for(let i=0;i<200&&!output.includes('panel:');i++){if(child.exitCode!==null)throw new Error(error);await new Promise(r=>setTimeout(r,10));}
  expect(output).toContain('panel:');const urls=output.match(/http:\/\/127\.0\.0\.1:\d+/g)!;await(await fetch(urls[0]!+'/cli')).text();
  child.kill('SIGTERM');expect((await once(child,'exit'))[0]).toBe(0);await expect(fetch(urls.at(-1)!)).rejects.toThrow();expect((await fs.readdir(f.root)).includes('.streamscope-serve.lock')).toBe(false);
 }finally{if(child.exitCode===null){child.kill('SIGKILL');await once(child,'exit');}await f.done();}
});
