import http from 'node:http';
import https from 'node:https';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMiddleware, redactHeaders, startRecordingProxy } from '../src/proxy.js';
import { readTrace } from '../src/trace.js';
import type { Trace } from '../src/types.js';

// Self-signed test pair (CN=localhost, SAN localhost/127.0.0.1, generated once
// with openssl; expires 2036). Used only to prove https targets proxy correctly.
const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCcXQl6S/P1Szur
GIEo+9Q2HY9HEeClD76K6E8hPM16BZW0flz6IUBxqRC1X68ZpsP8FUWvPiV54CzM
eoJap4cy5QDFlGdOse8rIBiPq6HaMLxxj/adXCTRTQv6Tm8iQ8DDl7iiWVeu2cT4
5UZ6v66dUAjyJ/Zz6m2lzT2IuRS13SPXgSVSDZr9j8+cZMqhwjbFfp+wpTzZ+J1I
EEJhxCuArO+8HtN+7rIM32gWLrMim224ZoAdxmAZ+dcp7BvP3npTfQpUwNI/MfpD
l03y3ijnTn9YBLGa307DnU7YXV+R6ZM14MSwHE7SQByJKSr040XpktfYXDYMVG7z
vC9y9QRFAgMBAAECggEAANHayAn/beGr2vOKUGt0v13M0PmEQPO6Fje138wM+wdj
jFa5yS7GSB1doyvT+Oa1w7EE+xEFfoVKlTN71SkUuPQAlD9z7+Q4u7Le23swgxDN
6lAXIyZyGWA8TigDLC7TIx8gOvhvsVDdbN9GRTmtPQNNNZpSn6OpvErxUQ/DVqJ9
oyKfp4dw8OjzcPNiEGFwsYx0gw2k6QkwXecqRJtBdL+oIg9DM9A9OrV+PYgGhGD6
8qHJW4fgUmt1xa9wBSbPfMxQyHUKzcinE3E3OnfACt09vN3yojS41Xc5X0EuGtzv
3FsFZdh6gQRP7PbUALgZVpE2AGxvTyDl9xyvOW686wKBgQDZgbZTXft40TRbuHnK
fZ5aYQeAwG1G2NIzdoIfOdV9OqMQPStdzBJj6xscb+ZzuOgfTC8Ots1BQ69/XVMM
njpC+JWFG5HK2q2aONApfS46xiwGqn6ifjCbiXx2t+esDhpC0h9qJcy80fdCRTqp
3L+aRVqhJnqTn6U+Z5JsS68ZTwKBgQC4CTAap0NBfKBZBrX9PPAZBuQeIEwufV6i
RUluWEUI0mWTvPxMACSODQEqK6smMlpIcG3MAZh7dN5aBHXZVCnfMZG6jYBx3X16
Ma993QFCYGC5gvIRCPv2XbCbtOBwDUlAS/RqpNS2Nb+1DkNgzqYrxbhB4pKWeJp0
cSjpOb78KwKBgQDGtJm8z79NQNJ0eLPLKbfhGYOhPCqY7rwaB8oYfN1s6oTN8RQN
PMIQRlkeQZxnXCWzcgYLizU4yn0p/jhA7syLIk52rBklGWI/4mdJf/Mb/q9554iJ
Kn99mLz8OEaOCNQ094F7l8zTM36QLG7Lf8ALUBDb6CtTciWkPTqndP0iQQKBgQCE
NY2KSEkHvalP64NIJsPxpsKwZdF0wHoApzfmfqExgjyY0vaI/r1EE1GX4wE0Eo5L
ZgFqwmaxojaugm/LLixafDjNxSPWKSEgbJs/F0r1TVmPS+PsmwCvb4UVhu6JcPID
r80p47owIBLV1iZPYIV+Aq+pHUTjtkZ3imeyjNqIOwKBgFlXaf58cm8hdjBFKdB3
xIrDyonQVYlR6knpdjT6uLdiWzl+LmXv+NnId906xhNBTw9qgrc0GwBVu0LNmEvn
3y+sOD+LgF4zmNXNq8oo79J6fPc4mCMJBhKg23Z+nBhG9P89jFKjmzLrkZ0y3deO
7hgacmvAEFkqGa/8LioNm+bD
-----END PRIVATE KEY-----`;
const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUSa4yIFrGd7ZpDtsmlLiMaefohRkwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTEyMjExMjkxM1oXDTM2MTEx
OTExMjkxM1owFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAnF0Jekvz9Us7qxiBKPvUNh2PRxHgpQ++iuhPITzNegWV
tH5c+iFAcakQtV+vGabD/BVFrz4leeAszHqCWqeHMuUAxZRnTrHvKyAYj6uh2jC8
cY/2nVwk0U0L+k5vIkPAw5e4ollXrtnE+OVGer+unVAI8if2c+ptpc09iLkUtd0j
14ElUg2a/Y/PnGTKocI2xX6fsKU82fidSBBCYcQrgKzvvB7Tfu6yDN9oFi6zIptt
uGaAHcZgGfnXKewbz956U30KVMDSPzH6Q5dN8t4o505/WASxmt9Ow51O2F1fkemT
NeDEsBxO0kAciSkq9ONF6ZLX2Fw2DFRu87wvcvUERQIDAQABo28wbTAdBgNVHQ4E
FgQU9gOy7uzSlGZ3B3eIxojug6XbAUswHwYDVR0jBBgwFoAU9gOy7uzSlGZ3B3eI
xojug6XbAUswDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAH4nZcEwvcG5IW21HBOxs0AyvquduVK/
l6M/yhEXa4Xt7d9fXyy0ugHvkntzOOCw+/idCluurkA9GLCmtre34sTgFS0szntR
d1h5w+CePff787k2NwtU0h5HkdVhYtrWvjXBKAqsjwQQB7TM3Noknq2A+A9du6RL
FhCSz+ViNOOU9hWeGDGpCoe+7VFmu7b1LjS8pCePWwntdgYQtF5dfwHgSTohjan3
teUisi7xnqIlccCNLqPAvaqDyWWUx4AiMp6DzE6QNJkVeJZcjdN3N9pZM3R7gsNu
Yad357/NY5Bh2uP8LKN96uB/AnxTEuhPW6XLqxylbwH0NkXZipfGP00=
-----END CERTIFICATE-----`;

const closers: Array<() => Promise<void> | void> = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'streamscope-proxy-'));
  dirs.push(dir);
  return dir;
}

/** A tiny upstream app: SSE chat + a PNG asset. Pass TLS pair for https. */
async function startUpstream(tls?: { key: string; cert: string }): Promise<{ url: string; close: () => Promise<void> }> {
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url?.startsWith('/api/chat')) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'set-cookie': 'sid=upstream-secret; HttpOnly',
      });
      const frames = [
        { type: 'start', messageId: 'm1' },
        { type: 'text-delta', id: 'm1', delta: 'Hello ' },
        { type: 'text-delta', id: 'm1', delta: 'world' },
        { type: 'finish', finishReason: 'stop' },
      ];
      let i = 0;
      const timer = setInterval(() => {
        if (i >= frames.length) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify(frames[i])}\n\n`);
        i += 1;
      }, 5);
      return;
    }
    if (req.url === '/logo.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    res.writeHead(404);
    res.end('nope');
  };
  const server = tls ? https.createServer({ key: tls.key, cert: tls.cert }, handler) : http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

describe('recording proxy', () => {
  it('passes the response through unchanged and records the stream', async () => {
    const upstream = await startUpstream();
    closers.push(upstream.close);
    const dir = await tmpDir();
    let session: Trace | undefined;

    const proxy = await startRecordingProxy({
      target: upstream.url,
      port: 0,
      outDir: dir,
      onSession: (trace) => {
        session = trace;
      },
    });
    closers.push(proxy.close);

    const response = await fetch(`${proxy.url}/api/chat`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"Hello "');
    expect(body.trim().split('\n\n')).toHaveLength(4);

    const started = Date.now();
    while (!session && Date.now() - started < 3000) await new Promise((r) => setTimeout(r, 20));
    expect(session).toBeDefined();
    const trace = await readTrace(session!.path!);
    expect(trace.meta.adapter).toBe('ai-sdk');
    expect(trace.meta.request?.url).toContain('/api/chat');
    expect(trace.frames.map((f) => f.event.type)).toEqual(['run-start', 'text-delta', 'text-delta', 'finish']);
    expect(trace.frames[1]?.event.delta).toBe('Hello ');
    expect(trace.meta.response?.status).toBe(200);
  });

  it('does not record static assets', async () => {
    const upstream = await startUpstream();
    closers.push(upstream.close);
    const dir = await tmpDir();
    const sessions: Trace[] = [];
    const proxy = await startRecordingProxy({
      target: upstream.url,
      port: 0,
      outDir: dir,
      onSession: (trace) => sessions.push(trace),
    });
    closers.push(proxy.close);

    const response = await fetch(`${proxy.url}/logo.png`);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect((await response.arrayBuffer()).byteLength).toBe(4);
    await new Promise((r) => setTimeout(r, 200));
    expect(sessions).toHaveLength(0);
  });

  it('returns 502 when the target is unreachable', async () => {
    const dir = await tmpDir();
    const proxy = await startRecordingProxy({ target: 'http://127.0.0.1:1', port: 0, outDir: dir });
    closers.push(proxy.close);
    const response = await fetch(`${proxy.url}/api/chat`);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('could not reach target');
  });

  it('works as an Express-style middleware', async () => {
    const upstream = await startUpstream();
    closers.push(upstream.close);
    const dir = await tmpDir();
    // Response completion precedes the asynchronous recording flush. Wait for
    // onSession before removing the output directory in afterEach.
    let resolveRecorded!: (trace: Trace) => void;
    const recorded = new Promise<Trace>((resolve) => { resolveRecorded = resolve; });
    const middleware = createMiddleware({ target: upstream.url, outDir: dir, onSession: resolveRecorded });
    const server = http.createServer((req, res) => middleware(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    );
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('world');
    const trace = await recorded;
    expect(trace.frames.at(-1)?.event.type).toBe('finish');
    expect((await readTrace(trace.path!)).frames).toHaveLength(4);
  });

  it('redacts credential headers in the trace by default', async () => {
    const upstream = await startUpstream();
    closers.push(upstream.close);
    const dir = await tmpDir();
    let session: Trace | undefined;
    const proxy = await startRecordingProxy({
      target: upstream.url,
      port: 0,
      outDir: dir,
      onSession: (trace) => {
        session = trace;
      },
    });
    closers.push(proxy.close);

    const status = await new Promise<number>((resolve, reject) => {
      const request = http.get(`${proxy.url}/api/chat`, {
        headers: {
          authorization: 'Bearer sekret-token',
          cookie: 'sid=client-secret',
          'x-api-key': 'k3y-123',
          'proxy-authorization': 'Basic cHJveHk=',
          'x-custom': 'keep-me',
        },
      });
      request.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      request.on('error', reject);
    });
    expect(status).toBe(200);

    const started = Date.now();
    while (!session && Date.now() - started < 3000) await new Promise((r) => setTimeout(r, 20));
    expect(session).toBeDefined();
    const trace = await readTrace(session!.path!);

    const requestHeaders = trace.meta.request?.headers ?? {};
    expect(requestHeaders['authorization']).toBe('[redacted]');
    expect(requestHeaders['cookie']).toBe('[redacted]');
    expect(requestHeaders['x-api-key']).toBe('[redacted]');
    expect(requestHeaders['proxy-authorization']).toBe('[redacted]');
    expect(requestHeaders['x-custom']).toBe('keep-me');

    const responseHeaders = trace.meta.response?.headers ?? {};
    expect(responseHeaders['set-cookie']).toBe('[redacted]');
    expect(responseHeaders['content-type']).toContain('text/event-stream');

    // Nothing sensitive survives anywhere in the trace file.
    const raw = await fs.readFile(session!.path!, 'utf8');
    expect(raw).not.toContain('sekret-token');
    expect(raw).not.toContain('client-secret');
    expect(raw).not.toContain('k3y-123');
    expect(raw).not.toContain('upstream-secret');
  });

  it('records headers verbatim when redact is false', async () => {
    const upstream = await startUpstream();
    closers.push(upstream.close);
    const dir = await tmpDir();
    let session: Trace | undefined;
    const proxy = await startRecordingProxy({
      target: upstream.url,
      port: 0,
      outDir: dir,
      redact: false,
      onSession: (trace) => {
        session = trace;
      },
    });
    closers.push(proxy.close);

    const status = await new Promise<number>((resolve, reject) => {
      const request = http.get(`${proxy.url}/api/chat`, {
        headers: { authorization: 'Bearer sekret-token', cookie: 'sid=client-secret' },
      });
      request.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      request.on('error', reject);
    });
    expect(status).toBe(200);

    const started = Date.now();
    while (!session && Date.now() - started < 3000) await new Promise((r) => setTimeout(r, 20));
    const trace = await readTrace(session!.path!);
    expect(trace.meta.request?.headers?.['authorization']).toBe('Bearer sekret-token');
    expect(trace.meta.request?.headers?.['cookie']).toBe('sid=client-secret');
    expect(trace.meta.response?.headers?.['set-cookie']).toContain('upstream-secret');
  });

  it('redactHeaders masks only the sensitive names, case-insensitively', () => {
    const out = redactHeaders({ Authorization: 'a', 'Set-Cookie': 'b', Other: 'c' });
    expect(out).toEqual({ Authorization: '[redacted]', 'Set-Cookie': '[redacted]', Other: 'c' });
    expect(redactHeaders({ Authorization: 'a' }, false)).toEqual({ Authorization: 'a' });
  });

  it('proxies an https (self-signed) target and records its stream', async () => {
    const upstream = await startUpstream({ key: TLS_KEY, cert: TLS_CERT });
    closers.push(upstream.close);
    const dir = await tmpDir();
    let session: Trace | undefined;
    const proxy = await startRecordingProxy({
      target: upstream.url,
      port: 0,
      outDir: dir,
      agent: new https.Agent({ rejectUnauthorized: false }),
      onSession: (trace) => {
        session = trace;
      },
    });
    closers.push(proxy.close);

    const response = await fetch(`${proxy.url}/api/chat`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('world');

    const started = Date.now();
    while (!session && Date.now() - started < 3000) await new Promise((r) => setTimeout(r, 20));
    expect(session).toBeDefined();
    expect(session!.meta.request?.url).toMatch(/^https:/);
  });

  it('rejects unsupported target protocols at startup', async () => {
    const dir = await tmpDir();
    await expect(startRecordingProxy({ target: 'ftp://example.com', port: 0, outDir: dir })).rejects.toThrow(
      /unsupported target protocol/,
    );
    await expect(startRecordingProxy({ target: 'ws://example.com', port: 0, outDir: dir })).rejects.toThrow(
      /unsupported target protocol/,
    );
    await expect(startRecordingProxy({ target: 'not a url', port: 0, outDir: dir })).rejects.toThrow();
  });

  it('answers a non-http request-target with 502 and keeps serving', async () => {
    const upstream = await startUpstream();
    closers.push(upstream.close);
    const dir = await tmpDir();
    const proxy = await startRecordingProxy({ target: upstream.url, port: 0, outDir: dir });
    closers.push(proxy.close);

    // Absolute-form request-target with a foreign scheme must not crash or hang.
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: proxy.port, path: 'ftp://evil.example/x' });
      request.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      request.on('error', reject);
      request.end();
    });
    expect(status).toBe(502);

    const ok = await fetch(`${proxy.url}/logo.png`);
    expect(ok.status).toBe(200);
  });
});
