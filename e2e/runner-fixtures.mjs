// Real browser import of built Vitest entry, no Node shims or paid services.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>runner fixture check</title>'); return; }
    if (req.url === '/fixture.json') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({meta:{v:1,kind:'meta',session:'browser',adapter:'sse',framing:'sse',protocol:'generic',startedAt:'2026-01-01'},frames:[{seq:0,t_ms:0,raw:'data: hello\n\n',event:{type:'text-delta',delta:'hello'}}]})); return; }
    if (req.url !== '/vitest.js') { res.writeHead(404);res.end(); return; }
    res.setHeader('content-type', 'text/javascript');res.end(await readFile('dist/vitest.js'));
  } catch { res.writeHead(500);res.end(); }
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
function launchOptions() {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM ?? ['/workspace/.tools/chromium/pack/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(path => existsSync(path));
  const env = { ...process.env };
  const libs = ['/workspace/.tools/chromium/pack/libs/lib', '/workspace/.tools/root/usr/lib/x86_64-linux-gnu'].filter(path => existsSync(path));
  if (libs.length) env.LD_LIBRARY_PATH = [...libs, env.LD_LIBRARY_PATH ?? ''].filter(Boolean).join(':');
  return { headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], env };
}
let browser;
try {
  browser=await chromium.launch(launchOptions());const page=await browser.newPage();
  await page.goto('http://127.0.0.1:'+server.address().port+'/');
  const result=await page.evaluate(async()=>{
    const {createTraceFetch,toMatchTrace}=await import('/vitest.js');
    const trace=await(await fetch('/fixture.json')).json();
    const mock=createTraceFetch(trace,{url:'/chat'});const response=await mock('/chat');
    const good=toMatchTrace(trace,trace);const changed=structuredClone(trace);changed.frames[0].event.delta='bad';const bad=toMatchTrace(changed,trace);
    return {body:await response.text(),good:good.pass,bad:bad.pass,message:bad.message()};
  });
  if(result.body!=='data: hello\n\n'||!result.good||result.bad||!result.message.includes('frame 0'))throw new Error(JSON.stringify(result));
  console.log('Browser runner fixture: SSE fetch, passing and failing frame matcher verified');
} finally {await browser?.close();await new Promise(r=>server.close(r));}
