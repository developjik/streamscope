#!/usr/bin/env node
/**
 * streamscope CLI.
 *
 *   streamscope record --target http://localhost:3000
 *   streamscope replay .streams/<session> --inject "drop(3),disconnect_at(0.62)"
 *   streamscope inject .streams/<session> --with "dup(4)" -o checkout.broken.jsonl
 *   streamscope inspect .streams/<session> --html viewer.html
 */
import { createHash } from 'node:crypto';
import { diffTraces, diffViolations, formatTraceDiff, parseDiffGates, renderDiffHtml } from '../src/diff.js';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFaults, FaultSyntaxError, defaultEncoder, formatScenario, parseScenario } from '../src/faults.js';
import { startRecordingProxy } from '../src/proxy.js';
import { startServe } from '../src/serve.js';
import { startReplayServer } from '../src/replay.js';
import { formatSummary, parseTrace, readTrace, resolveTracePath, summarize, traceToJsonl } from '../src/trace.js';
import { renderPanelHtml } from '../src/ui/panel.js';
import type { Trace } from '../src/types.js';

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
}

const DEFAULT_IO: CliIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd: process.cwd(),
};

const BOOLEAN_FLAGS = new Set([
  'help',
  'version',
  'json',
  'open',
  'no-ui',
  'print',
  'quiet',
  'force',
  'frames',
  'no-redact',
]);
const VALUE_FLAGS = new Set([
  'panel-port',
  'target',
  'port',
  'out',
  'adapter',
  'include',
  'ignore',
  'inject',
  'with',
  'speed',
  'html',
  'url',
  'baseline',
  'fail-on',
]);
const COMMANDS = ['serve', 'record', 'replay', 'inject', 'inspect', 'diff', 'help', 'version'] as const;
type Command = (typeof COMMANDS)[number];

interface Parsed {
  command: Command | string;
  positionals: string[];
  flags: Map<string, string | boolean>;
  rest: string[];
}

class UsageError extends Error {}

/** Find the package root no matter how the bin was launched (npx, symlink, dist/). */
export function packageRoot(moduleUrl: string = import.meta.url): string {
  let file: string;
  try {
    file = realpathSync(fileURLToPath(moduleUrl));
  } catch {
    file = fileURLToPath(moduleUrl);
  }
  let dir = path.dirname(file);
  for (let depth = 0; depth < 5; depth += 1) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function readVersion(root = packageRoot()): string {
  try {
    const file = path.join(root, 'package.json');
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as {
        version?: unknown;
      };
      if (typeof pkg.version === 'string') return pkg.version;
    }
  } catch {
    // fall through
  }
  return '0.1.0';
}

function parseArgv(argv: string[]): Parsed {
  const rest = [...argv];
  let command = rest.shift() ?? 'help';
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  const tail: string[] = [];
  let passthrough = false;

  if (command === '--version' || command === '-v') {
    command = 'version';
  } else if (command === '--help' || command === '-h') {
    command = 'help';
  }

  while (rest.length > 0) {
    const token = rest.shift() as string;
    if (passthrough) {
      tail.push(token);
      continue;
    }
    if (token === '--') {
      passthrough = true;
      continue;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        flags.set(token.slice(2, eq), token.slice(eq + 1));
        continue;
      }
      const name = token.slice(2);
      if (!BOOLEAN_FLAGS.has(name) && !VALUE_FLAGS.has(name)) {
        throw new UsageError(`unknown option --${name}`);
      }
      if (BOOLEAN_FLAGS.has(name)) {
        flags.set(name, true);
        continue;
      }
      const next = rest[0];
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`--${name} needs a value`);
      }
      rest.shift();
      flags.set(name, next);
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      const name = token.slice(1);
      if (name === 'o' || name === 'p' || name === 's') {
        const next = rest[0];
        if (next === undefined) throw new UsageError(`-${name} needs a value`);
        rest.shift();
        flags.set({ o: 'out', p: 'port', s: 'speed' }[name] as string, next);
        continue;
      }
      if (name === 'h') {
        flags.set('help', true);
        continue;
      }
      throw new UsageError(`unknown option -${name}`);
    }
    positionals.push(token);
  }
  return { command, positionals, flags, rest: tail };
}

function flag(parsed: Parsed, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function bool(parsed: Parsed, name: string): boolean {
  return parsed.flags.get(name) === true;
}

const HELP = `streamscope — record, replay and break AI streaming UIs

Usage
  streamscope <command> [options]

Commands
  serve    Record + session list + replay in one process
  record   Reverse-proxy an app and record every SSE / NDJSON stream it serves
  replay   Serve a recorded stream (optionally fault-injected) + timeline panel
  inject   Write a new trace file with faults baked in (for regression fixtures)
  inspect  Summarize a trace, or render a standalone HTML panel

Record
  streamscope record --target http://localhost:3000 [--port 8787]
      [--out .streams] [--adapter auto|sse|ndjson|json] [--include <regex>] [--no-redact] [--quiet]

Replay
  streamscope replay <trace|session-dir> [--port 8788] [--speed 1]
      [--inject "drop(3),dup(7),disconnect_at(0.62)"] [--no-ui]

Inject
  streamscope inject <trace> --with "truncate_tool_args(12),error(429)" -o out.jsonl

Diff
  streamscope diff <before> <after> [--fail-on 'removed,payload,latency>200ms'] [--json] [--html diff.html]
  streamscope diff <after> --baseline <trace>

Inspect
  streamscope inspect <trace> [--json] [--html viewer.html]

Fault DSL
  drop(3)  drop(2..5)  dup(7)  truncate_tool_args(12[,frame])
  disconnect_at(0.62)  error(429[,frame])  slow(800[,frame])  reorder(2,5)

Options
  -h, --help      Show help (also per command)
  -v, --version   Print the version

Docs: https://github.com/developjik/streamscope`;

function commandHelp(command: string): string {
  switch (command) {
    case 'serve':
      return `streamscope serve --target <url> [--port 8787] [--panel-port 8788] [--out .streams]
Both listeners bind only to 127.0.0.1. Use --port 0 --panel-port 0 for random ports.
Supports record flags (--adapter, --include, --ignore, --no-redact, --quiet) and --speed.
Open the panel URL, refresh sessions, select a recorded session. Ctrl-C stops both.
A root lock prevents duplicate serve processes; remove a stale lock only after checking the old process stopped.`;
    case 'record':
      return `streamscope record — reverse proxy + recorder

  --target <url>     Upstream app (required), e.g. http://localhost:3000
  --port <port>      Proxy port (default 8787, 0 = random)
  --out <dir>        Trace root (default .streams)
  --adapter <name>   auto | sse | ndjson | json (default auto, sniffed)
  --include <regex>  Record only matching request URLs
  --ignore <regex>   Never record matching URLs
  --no-redact        Record Authorization/Cookie/etc. headers verbatim
                     (default masks them as [redacted] in the trace)
  --quiet            Do not log each recorded session

Point your browser at the proxy URL instead of the app; every stream it serves
is written to <out>/<session>/events.jsonl.`;
    case 'replay':
      return `streamscope replay — serve a recorded stream

  streamscope replay <trace|session-dir> [options]

  --port <port>      Port (default 8788, 0 = random)
  --speed <n>        Playback speed, 0 = no waits (default 1)
  --inject <dsl>     Fault scenario, e.g. "drop(3),disconnect_at(0.62)"
  --no-ui            Do not serve the HTML panel at /
  --open             Print the panel URL only (no browser is launched)

  GET /stream    the (injected) stream
  GET /          timeline panel
  GET /trace.json  plan + frames`;
    case 'inject':
      return `streamscope inject — bake faults into a new trace file

  streamscope inject <trace> --with "<dsl>" [-o <out.jsonl>] [--print]

  Without -o the result is written next to the input as <session>.injected.jsonl.`;
    case 'diff':
      return `streamscope diff <before> <after> [--fail-on 'added,removed,payload,count,latency>200ms'] [--json] [--html diff.html]\nWith one trace, use --baseline <trace> or .streams/baseline.json containing {path,sha256}. Paths in the manifest are relative to the manifest directory.\nIdentity-less events match by ordinal; latency is elapsed frame time.`;
    case 'inspect':
      return `streamscope inspect — summarize a trace

  streamscope inspect <trace> [--json] [--html <out.html>]

  --json          Machine readable summary
  --html <file>   Write the standalone timeline panel
  --frames        Print every frame (type, t_ms, raw)`;
    default:
      return HELP;
  }
}

/** Run the CLI; returns the process exit code. */
export async function run(argv: string[], io: CliIO = DEFAULT_IO): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`streamscope: ${error.message}\n\n${HELP}\n`);
      return 2;
    }
    throw error;
  }

  if (parsed.command === 'version') {
    io.stdout(`${readVersion()}\n`);
    return 0;
  }
  if (parsed.command === 'help' || !COMMANDS.includes(parsed.command as Command)) {
    if (parsed.command !== 'help') {
      io.stderr(`streamscope: unknown command "${parsed.command}"\n\n`);
    }
    const topic = parsed.positionals[0];
    io.stdout(`${topic ? commandHelp(topic) : HELP}\n`);
    return parsed.command !== 'help' && !COMMANDS.includes(parsed.command as Command) ? 2 : 0;
  }
  if (bool(parsed, 'help')) {
    io.stdout(`${commandHelp(parsed.command)}\n`);
    return 0;
  }

  try {
    switch (parsed.command as Command) {
      case 'diff':
        return await runDiff(parsed, io);
      case 'inspect':
        return await runInspect(parsed, io);
      case 'inject':
        return await runInject(parsed, io);
      case 'serve':
        return await runServe(parsed, io);
      case 'record':
        return await runRecord(parsed, io);
      case 'replay':
        return await runReplay(parsed, io);
      default:
        return 0;
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof FaultSyntaxError) {
      io.stderr(`streamscope: ${error.message}\n`);
      return 2;
    }
    if (error instanceof RangeError) {
      io.stderr(`streamscope: ${error.message}\n`);
      return 2;
    }
    io.stderr(`streamscope: ${(error as Error).message}\n`);
    return 1;
  }
}

async function loadTrace(input: string | undefined, io: CliIO): Promise<Trace> {
  if (!input) throw new UsageError('a trace path or session directory is required');
  const file = path.resolve(io.cwd, resolveTracePath(input));
  if (!existsSync(file)) throw new Error(`trace not found: ${file}`);
  return readTrace(file);
}

async function runInspect(parsed: Parsed, io: CliIO): Promise<number> {
  const trace = await loadTrace(parsed.positionals[0], io);
  const summary = summarize(trace);
  if (bool(parsed, 'json')) {
    io.stdout(`${JSON.stringify({ meta: trace.meta, summary }, null, 2)}\n`);
  } else {
    io.stdout(`${formatSummary(summary)}\n`);
    if (bool(parsed, 'frames')) {
      io.stdout('\n');
      for (const frame of trace.frames) {
        io.stdout(
          `#${frame.seq}\t${frame.t_ms}ms\t${frame.event.type}\t${JSON.stringify(frame.event.delta ?? frame.event.argsDelta ?? frame.event.message ?? '')}\n`,
        );
      }
    }
  }
  const html = flag(parsed, 'html');
  if (html) {
    const out = path.resolve(io.cwd, html);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, renderPanelHtml(trace, { title: `streamscope · ${trace.meta.session}` }), 'utf8');
    io.stdout(`panel: ${out}\n`);
  }
  return 0;
}

async function runInject(parsed: Parsed, io: CliIO): Promise<number> {
  const trace = await loadTrace(parsed.positionals[0], io);
  const scenario = flag(parsed, 'with') ?? flag(parsed, 'inject');
  if (!scenario) throw new UsageError('--with "<dsl>" is required (e.g. --with "drop(3),disconnect_at(0.6)")');
  const faults = parseScenario(scenario);
  const result = applyFaults(trace.frames, faults, {
    meta: trace.meta,
    encode: defaultEncoder(trace.meta),
  });
  const meta = {
    ...trace.meta,
    notes: {
      ...(trace.meta.notes ?? {}),
      inject: formatScenario(faults),
      outcome: result.outcome,
    },
  };
  const injected: Trace = { meta, frames: result.frames, path: trace.path };
  const defaultOut = path.join(
    path.dirname(resolveTracePath(path.resolve(io.cwd, parsed.positionals[0] as string))),
    `${trace.meta.session}.injected.jsonl`,
  );
  const out = path.resolve(io.cwd, flag(parsed, 'out') ?? defaultOut);
  await writeFile(out, traceToJsonl(injected), 'utf8');
  io.stdout(`wrote ${out}\n`);
  io.stdout(`frames ${trace.frames.length} -> ${result.frames.length}, outcome ${result.outcome}\n`);
  for (const effect of result.effects) io.stdout(`  - ${effect}\n`);
  if (bool(parsed, 'print')) io.stdout(`${formatSummary(summarize(injected))}\n`);
  return 0;
}

async function runRecord(parsed: Parsed, io: CliIO): Promise<number> {
  const target = flag(parsed, 'target');
  if (!target) throw new UsageError('--target <http://localhost:3000> is required');
  const port = Number(flag(parsed, 'port') ?? 8787);
  const out = path.resolve(io.cwd, flag(parsed, 'out') ?? '.streams');
  const adapterName = (flag(parsed, 'adapter') ?? 'auto') as 'auto' | 'sse' | 'ndjson' | 'json';
  const include = flag(parsed, 'include');
  const ignore = flag(parsed, 'ignore');
  const proxy = await startRecordingProxy({
    target,
    port,
    host: '127.0.0.1',
    outDir: out,
    adapter: { framing: adapterName },
    ...(include ? { include: new RegExp(include) } : {}),
    ...(ignore ? { ignore: new RegExp(ignore) } : {}),
    redact: !bool(parsed, 'no-redact'),
    log: !bool(parsed, 'quiet'),
    onSession: () => undefined,
  });
  if (bool(parsed, 'no-redact')) {
    io.stderr(
      'streamscope: warning: recording without header redaction — Authorization, Cookie, Set-Cookie, X-API-Key and Proxy-Authorization are stored verbatim\n',
    );
  }
  io.stdout(`streamscope proxy: ${proxy.url} -> ${target}\n`);
  io.stdout(`traces: ${out}/<session>/events.jsonl  (Ctrl-C to stop)\n`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  await proxy.close();
  io.stdout('stopped\n');
  return 0;
}

async function runReplay(parsed: Parsed, io: CliIO): Promise<number> {
  const trace = await loadTrace(parsed.positionals[0], io);
  const port = Number(flag(parsed, 'port') ?? 8788);
  const speed = Number(flag(parsed, 'speed') ?? 1);
  const inject = flag(parsed, 'inject');
  const handle = await startReplayServer({
    trace,
    port,
    host: '127.0.0.1',
    speed,
    html: !bool(parsed, 'no-ui'),
    ...(inject ? { inject } : {}),
  });
  io.stdout(`replay: ${handle.streamUrl}\n`);
  io.stdout(`panel:  ${handle.url}\n`);
  io.stdout(`frames ${handle.plan.frames.length}, outcome ${handle.plan.outcome}\n`);
  for (const effect of handle.plan.effects) io.stdout(`  - ${effect}\n`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  await handle.close();
  io.stdout('stopped\n');
  return 0;
}

const isMain = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  run(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`streamscope: ${(error as Error).stack ?? String(error)}\n`);
      process.exitCode = 1;
    });
}

async function runDiff(parsed: Parsed, io: CliIO): Promise<number> {
  if (parsed.positionals.length < 1 || parsed.positionals.length > 2)
    throw new UsageError('diff needs <before> <after>, or <after> with a baseline');
  let base: string | undefined, head: string | undefined, expected: string | undefined;
  const explicit = flag(parsed, 'baseline');
  if (parsed.positionals.length === 2) {
    if (explicit) throw new UsageError('--baseline cannot be combined with two traces');
    [base, head] = parsed.positionals;
  } else {
    head = parsed.positionals[0];
    if (explicit) base = explicit;
    else {
      const manifest = path.resolve(io.cwd, '.streams/baseline.json');
      const record = JSON.parse(readFileSync(manifest, 'utf8')) as {
        path?: unknown;
        sha256?: unknown;
        sha?: unknown;
      };
      const hash = record.sha256 ?? record.sha;
      if (typeof record.path !== 'string' || typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash))
        throw new UsageError('baseline manifest needs path and 64-character sha256 (sha alias accepted)');
      base = path.resolve(path.dirname(manifest), record.path);
      expected = hash.toLowerCase();
    }
  }
  const before = await loadDiffTrace(base, io, expected),
    after = await loadDiffTrace(head, io);
  const html = flag(parsed, 'html');
  if (html) {
    const output = path.resolve(io.cwd, html);
    for (const input of [before.path!, after.path!, path.resolve(io.cwd, '.streams/baseline.json')]) {
      if (
        output === input ||
        (existsSync(output) &&
          existsSync(input) &&
          (realpathSync(output) === realpathSync(input) ||
            (statSync(output).dev === statSync(input).dev && statSync(output).ino === statSync(input).ino)))
      )
        throw new UsageError('--html must not overwrite an input trace or baseline manifest');
    }
  }
  const result = diffTraces(before, after),
    raw = flag(parsed, 'fail-on');
  const violations = diffViolations(result, raw === undefined ? [] : parseDiffGates(raw));
  const output = { ...result, violations };
  io.stdout(
    (bool(parsed, 'json')
      ? JSON.stringify(output, null, 2)
      : formatTraceDiff(result) + (violations.length ? `\nfailed gates: ${violations.join(', ')}` : '')) + '\n',
  );
  if (html) {
    const out = path.resolve(io.cwd, html);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, renderDiffHtml(result, before, after, violations), 'utf8');
    io.stderr(`diff report: ${out}\n`);
  }
  return violations.length ? 1 : 0;
}

async function loadDiffTrace(input: string | undefined, io: CliIO, expected?: string): Promise<Trace> {
  if (!input) throw new UsageError('missing diff trace');
  const file = path.resolve(io.cwd, resolveTracePath(input));
  const bytes = readFileSync(file);
  if (expected && createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new UsageError('baseline SHA-256 mismatch');
  const text = bytes.toString('utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) throw new UsageError(`empty diff trace: ${file}`);
  const records = lines.map((line, i) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new UsageError(`invalid JSON at ${file}:${i + 1}`);
    }
  });
  const meta = records[0];
  if (
    !meta ||
    meta.kind !== 'meta' ||
    meta.v !== 1 ||
    typeof meta.adapter !== 'string' ||
    !meta.adapter ||
    typeof meta.protocol !== 'string' ||
    typeof meta.framing !== 'string'
  )
    throw new UsageError(`invalid trace metadata: ${file}`);
  const seq = new Set<number>();
  for (const [i, frame] of records.slice(1).entries()) {
    const event = frame?.event as Record<string, unknown> | undefined;
    if (
      !frame ||
      !Number.isInteger(frame.seq) ||
      seq.has(frame.seq as number) ||
      typeof frame.t_ms !== 'number' ||
      !Number.isFinite(frame.t_ms) ||
      frame.t_ms < 0 ||
      typeof frame.raw !== 'string' ||
      !event ||
      typeof event.type !== 'string'
    )
      throw new UsageError(`invalid diff frame at ${file}:${i + 2}`);
    seq.add(frame.seq as number);
  }
  return parseTrace(text, file);
}


async function runServe(parsed: Parsed, io: CliIO): Promise<number> {
  const target=flag(parsed,'target');if(!target)throw new UsageError('--target is required');
  const url=new URL(target);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new UsageError('target must be HTTP(S) without credentials');
  const portValue=(name:string,fallback:number)=>{const n=Number(flag(parsed,name)??fallback);if(!Number.isInteger(n)||n<0||n>65535)throw new UsageError(`--${name} must be an integer from 0 to 65535`);return n;};
  const speed=Number(flag(parsed,'speed')??1);if(!Number.isFinite(speed)||speed<0)throw new UsageError('--speed must be a nonnegative finite number');
  const adapter=(flag(parsed,'adapter')??'auto');if(!['auto','sse','ndjson','json'].includes(adapter))throw new UsageError('invalid adapter');
  const handle=await startServe({target,port:portValue('port',8787),panelPort:portValue('panel-port',8788),outDir:path.resolve(io.cwd,flag(parsed,'out')??'.streams'),speed,adapter:{framing:adapter as 'auto'|'sse'|'ndjson'|'json'},include:flag(parsed,'include')?new RegExp(flag(parsed,'include')!):undefined,ignore:flag(parsed,'ignore')?new RegExp(flag(parsed,'ignore')!):undefined,redact:!bool(parsed,'no-redact'),log:!bool(parsed,'quiet')});
  try{
    io.stdout(`streamscope proxy: ${handle.proxyUrl} -> ${target}\npanel: ${handle.url}\n`);
    if(bool(parsed,'no-redact'))io.stderr('Warning: header redaction disabled; recorded headers may contain credentials.\n');
    await new Promise<void>(resolve=>{const stop=()=>{process.off('SIGINT',stop);process.off('SIGTERM',stop);resolve();};process.on('SIGINT',stop);process.on('SIGTERM',stop);});
  }finally{await handle.close();}return 0;
}
