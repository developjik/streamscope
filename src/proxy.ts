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
import type { AddressInfo } from 'node:net';
import type { AdapterOptions } from './adapters/index.js';
import { Recorder, type RecorderOptions } from './recorder.js';
import type { Trace } from './types.js';

export interface ProxyOptions {
  /** Upstream origin, e.g. `http://localhost:3000`. */
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

/** Proxy one request, recording the response when it can carry a stream. */
export async function handleProxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: ProxyOptions,
): Promise<void> {
  const targetBase = new URL(options.target);
  const requestUrl = req.url ?? '/';
  const targetUrl = new URL(requestUrl, targetBase);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const body = hasBody ? await collectBody(req) : Buffer.alloc(0);

  const upstream = http.request(
    targetUrl,
    {
      method: req.method,
      headers: {
        ...forwardHeaders(req.headers),
        host: targetBase.host,
        ...(hasBody ? { 'content-length': String(body.length) } : {}),
      },
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
            headers: Object.fromEntries(
              Object.entries(forwardHeaders(req.headers)).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]),
            ),
            ...(hasBody && body.length <= 4096 ? { body: body.toString('utf8') } : {}),
          },
          response: {
            status: upstreamRes.statusCode ?? 0,
            contentType: contentType ?? '',
            headers: Object.fromEntries(
              Object.entries(upstreamRes.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')]),
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
  const server = http.createServer((req, res) => {
    void handleProxyRequest(req, res, options);
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve));
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
