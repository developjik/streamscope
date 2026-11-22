import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { run, type CliIO } from '../bin/cli.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'demo', 'traces', 'chat-ai-sdk.jsonl');
const dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'streamscope-cli-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function capture(): { io: CliIO; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      cwd: root,
    },
    out: () => out,
    err: () => err,
  };
}

describe('streamscope CLI', () => {
  it('prints the version', async () => {
    const { io, out } = capture();
    expect(await run(['--version'], io)).toBe(0);
    expect(out().trim()).toBe('0.1.1');
  });

  it('prints top-level and per-command help', async () => {
    const top = capture();
    expect(await run(['--help'], top.io)).toBe(0);
    expect(top.out()).toContain('streamscope record');

    const rec = capture();
    expect(await run(['record', '--help'], rec.io)).toBe(0);
    expect(rec.out()).toContain('--target <url>');

    const rep = capture();
    expect(await run(['replay', '--help'], rep.io)).toBe(0);
    expect(rep.out()).toContain('--inject');
  });

  it('inspects a trace as text and JSON', async () => {
    const text = capture();
    expect(await run(['inspect', fixture], text.io)).toBe(0);
    expect(text.out()).toContain('adapter   ai-sdk');
    expect(text.out()).toContain('track_shipment');

    const json = capture();
    expect(await run(['inspect', fixture, '--json'], json.io)).toBe(0);
    const parsed = JSON.parse(json.out()) as { summary: { frames: number; textChars: number; terminal: string } };
    expect(parsed.summary.frames).toBe(16);
    expect(parsed.summary.textChars).toBe(120);
    expect(parsed.summary.terminal).toBe('finish');
  });

  it('renders the HTML panel', async () => {
    const dir = await tmpDir();
    const out = path.join(dir, 'viewer.html');
    const cli = capture();
    expect(await run(['inspect', fixture, '--html', out], cli.io)).toBe(0);
    const html = await fs.readFile(out, 'utf8');
    expect(html).toContain('id="scrub"');
  });

  it('injects faults into a new trace file', async () => {
    const dir = await tmpDir();
    const out = path.join(dir, 'broken.jsonl');
    const cli = capture();
    expect(await run(['inject', fixture, '--with', 'drop(3),disconnect_at(0.5)', '-o', out], cli.io)).toBe(0);
    expect(cli.out()).toContain('outcome disconnect');
    const lines = (await fs.readFile(out, 'utf8')).trim().split('\n');
    const meta = JSON.parse(lines[0] ?? '{}') as { notes?: { inject?: string; outcome?: string } };
    expect(meta.notes?.inject).toBe('drop(3), disconnect_at(0.5)');
    expect(meta.notes?.outcome).toBe('disconnect');
    expect(lines.length - 1).toBe(7);
  });

  it('fails clearly for missing input', async () => {
    const missingTrace = capture();
    expect(await run(['inspect'], missingTrace.io)).toBe(2);
    expect(missingTrace.err()).toContain('trace path');

    const missingWith = capture();
    expect(await run(['inject', fixture], missingWith.io)).toBe(2);
    expect(missingWith.err()).toContain('--with');

    const badDsl = capture();
    expect(await run(['inject', fixture, '--with', 'explode(1)'], badDsl.io)).toBe(2);
    expect(badDsl.err()).toContain('unknown fault');

    const badRange = capture();
    expect(await run(['inject', fixture, '--with', 'drop(99)'], badRange.io)).toBe(2);
    expect(badRange.err()).toContain('out of range');
  });

  it('warns once when recording with --no-redact', async () => {
    const dir = await tmpDir();
    const cli = capture();
    const before = new Set(process.listeners('SIGINT'));
    const done = run(
      ['record', '--target', 'http://127.0.0.1:1', '--port', '0', '--out', dir, '--no-redact'],
      cli.io,
    );
    const start = Date.now();
    while (!cli.err().includes('redaction') && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(cli.err()).toContain('without header redaction');
    // Invoke only the SIGINT handler this run registered — never vitest's own.
    for (const listener of process.listeners('SIGINT').filter((l) => !before.has(l))) listener('SIGINT');
    expect(await done).toBe(0);
    expect(cli.out()).toContain('streamscope proxy:');
  });

  it('rejects an unknown command with exit code 2', async () => {
    const cli = capture();
    expect(await run(['frobnicate'], cli.io)).toBe(2);
    expect(cli.err()).toContain('unknown command');
  });

  it('rejects an unknown option', async () => {
    const cli = capture();
    expect(await run(['inspect', fixture, '--nope', 'x'], cli.io)).toBe(2);
    expect(cli.err()).toContain('unknown option');
  });
});
