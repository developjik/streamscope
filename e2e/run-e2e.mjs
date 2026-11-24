/**
 * Real-browser E2E: the demo chat app + the Playwright replay fixture.
 *
 *   npm run build && node e2e/run-e2e.mjs
 *
 * Needs a Chromium binary: set PLAYWRIGHT_CHROMIUM to its path, or install one
 * with `npx playwright install chromium`. On minimal Linux images the bundled
 * system libraries usually need LD_LIBRARY_PATH (see README "Local E2E").
 */
import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import('playwright-core');
const { replayStream } = await import(path.join(root, 'dist', 'playwright.js'));
const { diffTraces, renderDiffHtml, parseTrace } = await import(path.join(root, 'dist', 'index.js'));
const { startReplayServer } = await import(path.join(root, 'dist', 'index.js'));

const DEMO_PORT = 8795;
const results = [];
const artifacts = path.join(root, 'e2e', '.artifacts');
await fs.mkdir(artifacts, { recursive: true });

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function chromiumLaunchOptions() {
  const executablePath =
    process.env.PLAYWRIGHT_CHROMIUM ??
    ['/workspace/.tools/chromium/pack/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => existsSync(p));
  const env = { ...process.env };
  const libs = [
    '/workspace/.tools/chromium/pack/libs/lib',
    '/workspace/.tools/root/usr/lib/x86_64-linux-gnu',
  ].filter((dir) => existsSync(dir));
  if (libs.length > 0) env.LD_LIBRARY_PATH = [...libs, env.LD_LIBRARY_PATH ?? ''].filter(Boolean).join(':');
  return {
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    env,
  };
}

const demo = spawn(process.execPath, [path.join(root, 'demo', 'server.mjs'), '--port', String(DEMO_PORT)], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('demo server did not start')), 10_000);
  demo.stdout.on('data', (chunk) => {
    if (String(chunk).includes('http://127.0.0.1')) {
      clearTimeout(timer);
      resolve();
    }
  });
  demo.on('error', reject);
});

let browser;
try {
  browser = await chromium.launch(chromiumLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto(`http://127.0.0.1:${DEMO_PORT}/`, { waitUntil: 'load' });

  // 1. Replay the recorded AI SDK stream into the real app.
  const full = await replayStream(page, path.join(root, 'demo', 'traces', 'chat-ai-sdk.jsonl'), {
    url: '**/api/chat*',
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.bubble .body .tool', { timeout: 15_000 });
  await page.waitForFunction(() => document.getElementById('status').textContent === 'finished', null, { timeout: 15_000 });
  const text = await page.textContent('.bubble:not(.me) .body');
  check('replay: assistant text matches the trace', text.includes('Sure — I checked the order'), text?.slice(0, 60));
  check('replay: tool result rendered', text.includes('in_transit'));
  check('replay: no page errors', pageErrors.length === 0, pageErrors.join(' | '));
  await page.screenshot({ path: path.join(artifacts, 'replay-complete.png'), fullPage: true });
  await full.stop();

  // 2. Fault injection: drop a frame, then disconnect mid-stream.
  const broken = await replayStream(page, path.join(root, 'demo', 'traces', 'chat-ai-sdk.jsonl'), {
    url: '**/api/chat*',
    inject: ['drop(3)', 'disconnect_at(0.5)'],
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.bubble .broken', { timeout: 15_000 });
  const brokenText = await page.textContent('.bubble .broken');
  const status = await page.textContent('#status');
  check('inject: UI shows the interrupted stream', /network error|closed before a finish/.test(brokenText ?? ''), brokenText);
  check('inject: status is not "finished"', status !== 'finished', status ?? '');
  check('inject: plan kept half of the frames', broken.plan.frames.length === 7, String(broken.plan.frames.length));
  await page.screenshot({ path: path.join(artifacts, 'replay-disconnected.png'), fullPage: true });
  await broken.stop();

  // 3. The timeline panel served by the replay server renders in a real browser.
  const panelServer = await startReplayServer({
    file: path.join(root, 'demo', 'traces', 'chat-ai-sdk.jsonl'),
    inject: 'error(429)',
    speed: 0,
  });
  const errorPlan = { url: panelServer.url, plan: panelServer.plan };
  await page.goto(errorPlan.url, { waitUntil: 'load' });
  await page.waitForSelector('#list .row', { timeout: 10_000 });
  const rows = await page.$$eval('#list .row', (els) => els.length);
  await page.fill('#scrub', '5');
  await page.dispatchEvent('#scrub', 'input');
  const frameTitle = await page.textContent('#frame-title');
  const breakCard = await page.$eval('#break-card', (el) => !el.hidden);
  check('panel: renders every frame row', rows === errorPlan.plan.frames.length, `${rows} rows`);
  check('panel: scrubbing selects a frame', /#5 /.test(frameTitle ?? ''), frameTitle ?? '');
  check('panel: injected error is flagged as the break point', breakCard);
  await page.screenshot({ path: path.join(artifacts, 'panel.png'), fullPage: false });
  await panelServer.close();

  // Diff report: gates, both reused viewers and narrow-screen controls.
  const original = parseTrace(await fs.readFile(path.join(root, 'demo', 'traces', 'chat-ai-sdk.jsonl'), 'utf8'));
  const changed = structuredClone(original);
  changed.frames.forEach(frame => { frame.t_ms += 200; });
  changed.frames.push({seq:100,t_ms:600,raw:'data: {}',event:{type:'tool-call-delta',id:'added-tool',argsDelta:'{}'}});
  const diff = diffTraces(original, changed);
  await page.setContent(renderDiffHtml(diff, original, changed, ['added', 'latency>199ms']));
  const report = page.locator('body');
  check('diff: change summary and failed gates visible', (await report.innerText()).includes('Gate failed: added, latency>199ms'));
  await page.setViewportSize({width:390,height:844});
  check('diff: no outer horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  for (const title of ['Before trace','After trace']) {
    const iframe = page.frameLocator(`iframe[title="${title}"]`);
    await iframe.locator('#scrub').waitFor();
    await iframe.locator('#next').click();
    check(`diff: ${title} next control works`, (await iframe.locator('#frame-title').innerText()).startsWith('#1 '));
    const fits = await iframe.locator('body').evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('#scrub').getBoundingClientRect().right <= innerWidth);
    check(`diff: ${title} controls fit narrow viewport`, fits);
    await iframe.locator('.counts').evaluate(el => { el.scrollLeft = el.scrollWidth; });
    check(`diff: ${title} counts can scroll`, await iframe.locator('.counts').evaluate(el => el.scrollWidth <= el.clientWidth || el.scrollLeft > 0));
  }
  await page.screenshot({path:path.join(artifacts,'diff-mobile.png'),fullPage:true});

} finally {
  if (browser) await browser.close();
  demo.kill('SIGTERM');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} E2E checks passed`);
if (failed.length > 0) {
  console.error('failed:', failed.map((f) => f.name).join(', '));
  process.exitCode = 1;
}
