/**
 * Recording reverse proxy + middleware.
 *
 *   npx streamscope record --target http://localhost:3000
 *
 * Every response whose content type can carry a stream (SSE, NDJSON, JSON,
 * plain text) is copied to the client *and* parsed through an adapter into
 * `.streams/<session>/events.jsonl`. Static assets are passed through untouched.
 */
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { AdapterOptions } from './adapters/index.js';
import { Recorder, type RecorderOptions } from './recorder.js';
import type { Trace } from './types.js';

export interface ProxyOptions {
  /** Upstream origin, e.g. `http://localhost:3000` (http: and https: only). */
  target: string;
  outDir?: string;
  adapter?: AdapterOptions;
  host?: string;
  port?: number;
  /** Record only URLs matching this pattern. */
  include?: RegExp;
  /** Never record URLs matching this pattern (assets, HMR, ...). */
  ignore?: RegExp;
  /** Called once per recorded session. */
  onSession?: (trace: Trace, file: string) => void;
  /** Log one line per session to stderr. */
  log?: boolean;
  now?: () => number;
  /**
   * Mask credentials in *recorded* headers (authorization, cookie, set-cookie,
   * x-api-key, proxy-authorization -> `[redacted]`). Default true; forwarding
   * is never affected. Pass `false` (--no-redact) to record headers verbatim.
   */
  redact?: boolean;
  /** Custom agent for upstream requests (self-signed TLS, corporate proxies). */
  agent?: http.Agent | https.Agent;
}

export interface ProxyHandle {
  server: http.Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

const DEFAULT_IGNORE = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|mp4|webm)(?:\?|$)/i;
const RECORDABLE = /(?:text\/event-stream|ndjson|jsonl|json|text\/plain)/i;

function isRecordable(contentType: string | undefined, options: ProxyOptions, url: string): boolean {
  if (options.include && !options.include.test(url)) return false;
  if ((options.ignore ?? DEFAULT_IGNORE).test(url)) return false;
  if (!contentType) return false;
  return RECORDABLE.test(contentType);
}

function forwardHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding'].includes(lower)) continue;
    out[key] = value;
  }
  return out;
}

function collectBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Header names whose values are masked in the recorded trace. */
export const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization',
]);

/** Mask credential headers for the trace file; forwarding is untouched. */
export function redactHeaders(headers: Record<string, string>, enabled = true): Record<string, string> {
  if (!enabled) return headers;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? '[redacted]' : value;
  }
  return out;
}

function writeJson(res: http.ServerResponse, status: number, payload: Record<string, unknown>): void {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

/** Proxy one request, recording the response when it can carry a stream. */
export async function handleProxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: ProxyOptions,
): Promise<void> {
  const requestUrl = req.url ?? '/';
  let targetUrl: URL;
  try {
    targetUrl = new URL(requestUrl, new URL(options.target));
  } catch {
    writeJson(res, 400, {
      error: 'streamscope proxy: invalid target or request URL',
      target: options.target,
      url: requestUrl,
    });
    return;
  }
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    writeJson(res, 502, {
      error: 'streamscope proxy: unsupported target protocol',
      protocol: targetUrl.protocol,
    });
    return;
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const body = hasBody ? await collectBody(req) : Buffer.alloc(0);

  const transport = targetUrl.protocol === 'https:' ? https : http;
  const upstream = transport.request(
    targetUrl,
    {
      method: req.method,
      headers: {
        ...forwardHeaders(req.headers),
        host: targetUrl.host,
        ...(hasBody ? { 'content-length': String(body.length) } : {}),
      },
      ...(options.agent ? { agent: options.agent } : {}),
    },
    (upstreamRes) => {
      const contentType = upstreamRes.headers['content-type'] as string | undefined;
      res.statusCode = upstreamRes.statusCode ?? 502;
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (value !== undefined && !['connection', 'transfer-encoding', 'content-length'].includes(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      }

      const recordable = isRecordable(contentType, options, requestUrl);
      let recorder: Recorder | undefined;
      if (recordable) {
        const recorderOptions: RecorderOptions = {
          adapter: { ...options.adapter, contentType, forceFraming: options.adapter?.forceFraming },
          request: {
            method: req.method,
            url: targetUrl.toString(),
            headers: redactHeaders(
              Object.fromEntries(
                Object.entries(forwardHeaders(req.headers)).map(([k, v]) => [
                  k,
                  Array.isArray(v) ? v.join(', ') : String(v),
                ]),
              ),
              options.redact !== false,
            ),
            ...(hasBody && body.length <= 4096 ? { body: body.toString('utf8') } : {}),
          },
          response: {
            status: upstreamRes.statusCode ?? 0,
            contentType: contentType ?? '',
            headers: redactHeaders(
              Object.fromEntries(
                Object.entries(upstreamRes.headers).map(([k, v]) => [
                  k,
                  Array.isArray(v) ? v.join(', ') : String(v ?? ''),
                ]),
              ),
              options.redact !== false,
            ),
          },
          notes: { proxy: options.target },
        };
        if (options.outDir) recorderOptions.dir = options.outDir;
        if (options.now) recorderOptions.now = options.now;
        recorder = new Recorder(recorderOptions);
        void recorder.begin();
      }

      const decoder = new TextDecoder();
      let failed = false;
      upstreamRes.on('data', (chunk: Buffer) => {
        if (!res.writableEnded) res.write(chunk);
        if (recorder && !failed) {
          void recorder.push(decoder.decode(chunk, { stream: true })).catch(() => {
            failed = true;
          });
        }
      });
      upstreamRes.on('end', () => {
        if (!res.writableEnded) res.end();
        void finish(recorder, upstreamRes.statusCode, contentType);
      });
      upstreamRes.on('error', () => {
        if (!res.writableEnded) res.end();
        void finish(recorder, upstreamRes.statusCode, contentType);
      });

      async function finish(rec?: Recorder, status?: number, ct?: string): Promise<void> {
        if (!rec) return;
        try {
          const trace = await rec.end({ status: status ?? 0, contentType: ct ?? '' });
          options.onSession?.(trace, rec.file);
          if (options.log) {
            process.stderr.write(
              `streamscope: recorded ${trace.frames.length} frames (${trace.meta.adapter}) -> ${rec.file}\n`,
            );
          }
        } catch {
          // Recording must never break the proxied request.
        }
      }
    },
  );

  upstream.on('error', (error) => {
    if (!res.writableEnded) {
      res.statusCode = 502;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'streamscope proxy could not reach target', target: options.target, detail: String(error) }));
    }
  });

  req.on('close', () => {
    if (!res.writableEnded) upstream.destroy();
  });

  if (hasBody) upstream.end(body);
  else upstream.end();
}

/** Express/Connect style middleware. */
export function createMiddleware(options: ProxyOptions) {
  return (req: http.IncomingMessage, res: http.ServerResponse, next?: (error?: unknown) => void): void => {
    handleProxyRequest(req, res, options).catch((error) => {
      if (next) next(error);
      else {
        res.statusCode = 500;
        res.end(String(error));
      }
    });
  };
}

/** Start a standalone recording proxy. */
export async function startRecordingProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const scheme = new URL(options.target).protocol;
  if (scheme !== 'http:' && scheme !== 'https:') {
    throw new Error(`streamscope: unsupported target protocol "${scheme}" (expected http: or https:)`);
  }
  const server = http.createServer((req, res) => {
    handleProxyRequest(req, res, options).catch((error: unknown) => {
      // A failed request must end as a response, never as an unhandled
      // rejection that takes the proxy process down.
      if (res.writableEnded) return;
      if (res.headersSent) {
        res.end();
        return;
      }
      writeJson(res, 502, { error: 'streamscope proxy request failed', detail: String(error) });
    });
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => { const fail = (error: Error) => reject(new Error(`streamscope: cannot listen on ${options.host ?? '127.0.0.1'}:${options.port ?? 0}: ${error.message}`)); server.once('error', fail); server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => { server.off('error', fail); resolve(); }); });
  const address = server.address() as AddressInfo;
  return {
    server,
    port: address.port,
    url: `http://${options.host ?? '127.0.0.1'}:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
