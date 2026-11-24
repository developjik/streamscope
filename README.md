# streamscope

[한국어](README.ko.md) · English

**Record, replay and deliberately break AI streaming UIs — down to the frame.**

[![CI](https://github.com/developjik/streamscope/actions/workflows/ci.yml/badge.svg)](https://github.com/developjik/streamscope/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-informational)](https://nodejs.org)

A chat UI that streams tokens, tool calls and approvals has state that only exists *between* frames. When it breaks — a tool's arguments arrive half-parsed, a token is duplicated, the socket dies at 62% — the failure is gone the moment you reload, and nobody can reproduce it.

`streamscope` sits between your app and the model server as a recording proxy, stores every wire frame with its timing, and plays it back deterministically with **faults injected**. The same recording becomes a Playwright fixture, so "the UI broke when the stream was cut here" turns into a test that runs in CI.

```
┌───────────┐   SSE / NDJSON    ┌──────────────────────┐   recorded frames   ┌────────────────────────────┐
│  browser  │ ◀───────────────▶ │  streamscope record  │ ──────────────────▶ │ .streams/<session>/        │
│  (your    │   reverse proxy   │  adapter: ai-sdk /   │                     │   events.jsonl             │
│   app)    │                   │  ag-ui / legacy /    │                     └─────────────┬──────────────┘
└───────────┘                   │  generic             │                                   │
                                └──────────────────────┘                                   │
                                                                                           ▼
┌──────────────────┐   replay + faults   ┌──────────────────────┐   same frames, injected  ┌────────────────┐
│ timeline panel   │ ◀────────────────── │  streamscope replay  │ ◀─────────────────────── │ fault DSL      │
│ scrub · text ·   │                     │  local HTTP server   │                          │ drop/dup/      │
│ tool args · break│                     └──────────┬───────────┘                          │ truncate/...   │
└──────────────────┘                                │                                      └────────────────┘
                                                    ▼
                                     ┌──────────────────────────────┐
                                     │ Playwright: replayStream()   │
                                     │ route the app's real request │
                                     │ to the replay server         │
                                     └──────────────────────────────┘
```

## Why this exists

Agent frontends now ship on streams (AI SDK UI, AG-UI, custom SSE), but the debugging tools stop at "show me the events": DevTools panels display SSE frames, Playwright traces replay DOM and actions, MSW mocks HTTP without stream semantics. The bugs people actually file are about stream *state boundaries* — e.g. AG-UI's [tool-call argument chunks being dropped when a subscriber replaces a message](https://github.com/ag-ui-protocol/ag-ui/issues/3264), or [an aborted subagent's snapshot being undefined](https://github.com/ag-ui-protocol/ag-ui/issues/3312). Reproducing those needs the exact frame sequence, plus the ability to break it on purpose.

streamscope is not a test framework and not a monitoring panel. It is the recorder and the experimental bench: record the session, replay the frame the UI died on, inject the failure, keep the result as a fixture.

## Install

```bash
# nothing to install to try it
npx streamscope --help

# as a dev dependency (library + Playwright fixture)
npm install --save-dev streamscope
npm install --save-dev playwright   # only for the fixture's page object
```

Requires Node ≥ 20. No runtime dependencies.

## 60-second tour

```bash
git clone https://github.com/developjik/streamscope && cd streamscope
npm install && npm run build

# 1. start the bundled demo app (a tiny streaming agent UI, four wire protocols)
npm run demo            # http://127.0.0.1:8790

# 2. record it — open the proxy URL, not the app URL
npx streamscope record --target http://127.0.0.1:8790
#   streamscope proxy: http://127.0.0.1:8787 -> http://127.0.0.1:8790
#   recorded 16 frames (ai-sdk) -> .streams/2026-11-21T14-09-10-4a2e/events.jsonl

# 3. inspect what was captured
npx streamscope inspect .streams/<session>
#   frames    16 over 84 ms, 1359 wire bytes
#   events    text-delta=7 tool-call-delta=5 tool-result=1 approval=1 finish=1
#   tools
#     - track_shipment [call_track_1] 40B args (valid JSON) +result

# 4. replay it broken, with a timeline panel
npx streamscope replay .streams/<session> --inject "drop(3),disconnect_at(0.62)"
#   replay: http://127.0.0.1:8788/stream
#   panel:  http://127.0.0.1:8788/
```

`demo/traces/` already contains traces recorded from the demo app through the real proxy, so you can skip straight to `replay demo/traces/chat-ai-sdk.jsonl`.

## What gets recorded

One file per session, `.streams/<session>/events.jsonl`: a meta line, then one line per **wire frame** (one SSE message or one NDJSON line).

```json
{"v":1,"kind":"meta","session":"chat-ai-sdk","adapter":"ai-sdk","framing":"sse","protocol":"ai-sdk",
 "startedAt":"2026-11-21T14:09:10.434Z","request":{"method":"GET","url":"http://127.0.0.1:8791/api/chat?fast=1"},
 "response":{"status":200,"contentType":"text/event-stream; charset=utf-8"}}
{"t_ms":0,"seq":0,"raw":"data: {\"type\":\"start\",\"messageId\":\"msg_demo_1\"}\n\n","event":{"type":"run-start","name":"start"}}
{"t_ms":0,"seq":1,"raw":"data: {\"type\":\"text-delta\",\"id\":\"msg_demo_1\",\"delta\":\"Sure — \"}\n\n","event":{"type":"text-delta","id":"msg_demo_1","delta":"Sure — "}}
{"t_ms":12,"seq":2,"raw":"data: {\"type\":\"tool-input-delta\",\"toolCallId\":\"call_track_1\",\"inputTextDelta\":\"{\\\"order\"}\n\n","event":{"type":"tool-call-delta","id":"call_track_1","argsDelta":"{\"order"}}
```

- `t_ms` — milliseconds since the first recorded frame; never decreases.
- `raw` — the wire frame in normalized text form. This is what replay writes back to the app.
- `event` — the normalized semantic event. Everything else (panel, faults, summaries) works on this.

Normalized events: `text-delta`, `tool-call-delta`, `tool-result`, `approval`, `error`, `finish`, plus `run-start`, `lifecycle` and `unknown` for protocol plumbing.

### Adapters

| Wire format | Detected as | Notes |
|---|---|---|
| Vercel AI SDK **UI message stream** (SSE, `{"type":"text-delta"}` / `tool-input-delta` / `tool-output-available` / `error` / `finish`) | `ai-sdk` | default for AI SDK chatbot UIs |
| Vercel AI SDK **legacy data stream** (`0:"text"`, `9:{toolCall}`, `a:{result}`, `3:"error"`, `d:{finish}`) | `ai-sdk-data` | often NDJSON |
| **AG-UI** events over SSE (`RUN_STARTED`, `TEXT_MESSAGE_CONTENT`, `TOOL_CALL_ARGS`, `TOOL_CALL_RESULT`, `RUN_ERROR`, `RUN_FINISHED`) | `ag-ui` | uppercase event names |
| Any SSE/NDJSON with `{"type": ...}` or `delta`/`text`/`content` | `generic` | best-effort mapping |
| `text/plain` token stream | `raw` framing | each chunk is a `text-delta` |
| Single JSON response | `json` framing | recorded as one frame, so "no stream at all" is visible too |

Framing is sniffed from the content type first (`--adapter` can force `sse`, `ndjson`, `json`, `auto`), then from the first bytes. Parsing is chunk-boundary safe: a `data:` line split across TCP reads, CRLF, lone CR, comments and multi-line `data:` are all handled.

## Fault DSL

Indices are **0-based frame indices of the recorded trace**, so the order you write faults in never changes the result. Application order is fixed: `truncate → drop → dup → reorder → disconnect → error → slow`.

| Fault | Meaning |
|---|---|
| `drop(3)` | drop frame #3 |
| `drop(2..5)` | drop frames #2 through #5 |
| `dup(7)` | send frame #7 twice (the classic duplicate-token bug) |
| `truncate_tool_args(12)` | cut every tool-argument fragment to 12 bytes, producing the half-parsed JSON that breaks tool UIs |
| `truncate_tool_args(12,4)` | …only for frame #4 |
| `disconnect_at(0.62)` | close the connection after 62% of the frames, with no terminal event |
| `error(429)` | finish the stream with an error frame (429) |
| `error(429,5)` | keep frames #0–#4, then fail with 429 |
| `slow(800)` | add 800 ms before every frame (a stalled token) |
| `slow(800,3)` | add 800 ms before frame #3 |
| `reorder(2,5)` | swap frames #2 and #5 (out-of-order tool args) |

Scenarios combine with commas or semicolons: `--inject "drop(3), dup(7), disconnect_at(0.62)"`. Invalid faults fail with the reason (`drop(99)` → `out of range — the trace has 16 frame(s)`), never silently.

All indices refer to 0-based positions in the recorded trace, even when sequence numbers repeat. Multiple `drop` faults remove the union of original positions; repeated or overlapping ranges do not count removed frames twice. `dup` skips dropped frames and copies surviving transformed frames, including truncated arguments. `error(status,index)` retains only surviving original positions below the index, even if its target was dropped or reordered. Fault kinds have a fixed application order; overlapping reorders within the same kind retain their written order.

Bake a scenario into a new fixture:

```bash
npx streamscope inject demo/traces/chat-ai-sdk.jsonl \
  --with "truncate_tool_args(6),error(429)" -o demo/traces/chat-ai-sdk.broken.jsonl
```

## CLI

```
streamscope record --target http://localhost:3000 [--port 8787] [--out .streams]
                   [--adapter auto|sse|ndjson|json] [--include <regex>] [--ignore <regex>] [--no-redact] [--quiet]

streamscope replay <trace|session-dir> [--port 8788] [--speed 1] [--inject "<dsl>"] [--no-ui]

streamscope inject <trace> --with "<dsl>" [-o out.jsonl] [--print]

streamscope inspect <trace> [--json] [--html viewer.html] [--frames]

streamscope --help | --version
```

- `record` is a reverse proxy: point the browser (or Playwright, or curl) at the proxy URL and every recordable response is streamed through unchanged while being parsed. Static assets are skipped; `--include`/`--ignore` take regexes. The same code is exported as `createMiddleware()` for an Express/Connect server. Credential headers (`authorization`, `cookie`, `set-cookie`, `x-api-key`, `proxy-authorization`) are stored as `[redacted]` in the trace — `--no-redact` records them verbatim and prints a warning. `http:` and `https:` targets are supported; other schemes are refused at startup.
- `replay` serves `GET /stream` (recorded timing, or `--speed 0` for instant), `GET /` (the panel) and `GET /trace.json` (plan + frames). A `disconnect_at` plan destroys the socket, an `error` plan that fails on frame 0 answers a plain HTTP error.
- `inspect` summarizes, or writes a standalone HTML panel you can attach to a bug report.

## Playwright fixture

```ts
import { test, expect } from '@playwright/test';
import { replayStream } from 'streamscope/playwright';

test('the UI does not lose the tool card when a chunk is dropped', async ({ page }) => {
  // Serve the recorded stream to the app's real /api/chat request.
  const stream = await replayStream(page, 'demo/traces/chat-ai-sdk.jsonl', {
    url: '**/api/chat*',
    inject: ['drop(3)', 'disconnect_at(0.62)'],
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('stream interrupted')).toBeVisible();
  await expect(page.getByRole('status', { name: /tracking/ })).toHaveCount(1);
  await stream.stop();
});
```

How it works: a local replay server streams the (injected) frames with their recorded timing, and the page's request is rerouted to it at the network layer with `route.continue({ url })`. The app still believes it is talking to its own endpoint, so streaming, mid-stream aborts and error frames behave like production. `transport: 'fulfill'` sends one body instead (no streaming); `abort: true` fails the request at the network level.

| Option | Default | |
|---|---|---|
| `url` | `'**/api/**'` | route pattern to intercept |
| `inject` | `[]` | DSL string(s) or parsed faults |
| `speed` | `0` | `1` = recorded timing, `10` = 10×, `0` = no waits |
| `transport` | `'continue'` | `'fulfill'` for a single body |
| `abort` | `false` | abort the request instead of replaying |

The handle exposes `plan` (frames + effects + outcome), `url`/`streamUrl`, `requests`, `done` and `stop()`. Only `page.route` / `page.unroute` are used, so the package has no Playwright dependency.

## Timeline panel

`replay` serves (and `inspect --html` writes) a single self-contained HTML file:

- frame list with `t_ms`, type badge and a one-line preview, keyboard `←`/`→`, space to play;
- scrubber that reconstructs the UI state *at that frame*: accumulated text, tool-call argument assembly with a JSON-valid / incomplete marker, approvals, results;
- the break point: the error frame, or a stream that ended without `finish`;
- the selected frame's wire text, so you can see exactly what the app received;
- injected frames are labeled, and trace text is escaped (`</script>` in a delta cannot break out of the panel).

## Which failures this reproduces

- A token dropped or duplicated mid-message.
- Tool arguments cut mid-JSON, or delivered before their `tool-input-start`.
- A stream that closes without `finish` (spinner never clears, `aria-busy` stuck).
- An error frame after partial content (does the UI keep the partial text?).
- A slow gap between frames (stalled "typing" state, timeouts).
- Protocol drift: the same session replayed as SSE vs NDJSON vs AG-UI to compare what the UI does.

## Compatibility

| Works | Does not work |
|---|---|
| HTTP/1.1 streaming responses (SSE, NDJSON, JSON, text) | H2/H3 multiplexed streams |
| AI SDK UI message stream, legacy data stream, AG-UI, generic JSON deltas | protobuf/gRPC or binary frames |
| Node 20/22, any framework behind an HTTP server | browser-only apps with no Node server (use `--target` at whatever origin serves the stream) |
| Playwright (any version with `page.route`) | Cypress buffered responses / Vitest fetch fixtures |

## Limitations (on purpose, documented)

- **`raw` is normalized text, not byte-exact.** SSE frames are re-serialized from parsed fields; UTF-8 only. Byte-level fidelity (chunk sizes, compression) is not preserved — the tool is about stream *semantics*.
- **Unknown protocol fields survive only on untouched frames.** An injected or truncated frame is re-encoded from the normalized event, so protocol-specific extras not modeled here are omitted from *that* frame.
- **Timing is approximate.** `t_ms` comes from the proxy's arrival times; replay sleeps between frames and cannot reproduce sub-millisecond jitter. `speed` and `maxDelayMs` deliberately change timing.
- **A dropped socket is a real TCP close.** Some clients auto-retry; streamscope does not simulate retries or reconnect logic.
- **Request/response bodies in meta are capped at 4 KB** and the proxy strips `accept-encoding`, so upstreams respond uncompressed while recording.
- **The panel models the common denominator of stream state** (text, tool args, results, approvals). It does not run your app's reducer, so app-specific derived state is not shown.
- **Not a security scanner.** Header redaction covers the built-in credential list only; bodies and custom headers are stored as sent. Review before committing a trace.

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # vitest: parsers, adapters, recorder, faults, replay, proxy, panel, CLI, fixture
npm run build         # tsup -> dist (index, playwright, cli)
npm run verify        # all of the above

npm run demo                        # demo app on :8790
node scripts/record-demo.mjs        # re-record demo/traces/*.jsonl through the real proxy
```

**Local E2E** (real Chromium): `npm run build && npm run test:e2e`. It drives `demo/app.html` through `replayStream()`, then checks the disconnect case and the panel. Set `PLAYWRIGHT_CHROMIUM=/path/to/chromium` if Playwright's own browser is not installed; on minimal Linux images you may also need `LD_LIBRARY_PATH` pointing at the bundled Chromium's `libs/` and the system `libnspr4`. The CI `e2e` job installs Chromium with `npx playwright install --with-deps chromium`.

## Roadmap

- `streamscope serve` — record + replay in one process (a session list panel).
- Custom header/body redaction rules for traces that get committed (the built-in credential mask ships in 0.1.1).

## License

MIT © jungingwon ([developjik](https://github.com/developjik))

## Runner fixtures and provider events (DEV-123)

The package name remains `streamscope`. These exports are available from source builds; this PR does not publish npm.

```ts
import { createTraceFetch, toMatchTrace } from 'streamscope/vitest';
import { interceptTrace } from 'streamscope/cypress';
expect.extend({ toMatchTrace });
// Load a recorded Trace with readTrace() in Node, or parse JSONL in your browser fixture.
vi.stubGlobal('fetch', createTraceFetch(trace, { url: '/api/chat' }));
// Unmatched calls reject unless you explicitly provide fallback: fetch.
// Call vi.unstubAllGlobals() in afterEach to restore the real fetch.
expect(actualTrace).toMatchTrace(trace); // Typed after importing streamscope/vitest.
interceptTrace(cy, '/api/chat', trace);
```

`createTraceFetch` returns a real Response/ReadableStream with recorded wire frames, optional timing (`speed: 1`) and AbortSignal support. `toMatchTrace` compares normalized events in order and reports the first zero-based mismatching frame. Timestamps/wire formatting are intentionally not compared. Cypress replies are buffered: they do not emulate per-frame timing or network disconnects. Use the Playwright replay server for those cases.

SSE provider adapters recognize OpenAI Assistants `thread.run.*`, `thread.message.delta`, and tool argument deltas, plus LangGraph SDK `metadata`, `messages`/`messages-tuple`, `end`, and `error` events. Message text, tool chunks, run completion and errors become normalized trace events. These adapters cover these documented stream forms, not every provider mode (for example LangGraph values/updates remain generic). Existing SSE and NDJSON framing remains supported.

Validation: `npm run verify && npm run test:e2e && npm run test:browser`. Runner tests read a recorded JSONL file, prove passing/failing frame comparisons, and import the built fixture in a real Chromium page. The Vitest browser-mode example in `e2e/fixtures.browser.test.ts` also reads the real recording and asserts both match and mismatch. No external provider API is called.

## Development baseline (DEV-128)

Use Node.js 22.18.0 (`.nvmrc`) for development and CI. Vitest 5.1.1 requires Node 22.12+ on its supported release lines; Node 20.19 is outside its declared development support range. It may execute there, but CI does not treat that as supported test-runner usage. This development requirement does not change the package engine declaration. Runtime compatibility must be checked using the built package, separately from the test runner. TypeScript 7.0.2 is the development compiler baseline.

Development minimum exception: tsup9 requires Node22.x from22.18.0. This does not change consumer runtime engines.

## Trace diff and regression gates

```sh
streamscope diff before.jsonl after.jsonl
streamscope diff before.jsonl after.jsonl --fail-on 'added,removed,payload,latency>200ms,count'
streamscope diff before.jsonl after.jsonl --json --html reports/diff.html
streamscope diff after.jsonl --baseline before.jsonl
```

With one trace and no explicit baseline, `.streams/baseline.json` is read:

```json
{"path":"main/events.jsonl","sha256":"<64-character SHA-256 of the trace file bytes>"}
```

The path is relative to the manifest directory. `sha` is accepted as an alias
for `sha256`. The hash is verified before comparing; no baseline is created or
updated implicitly. Get a hash with `sha256sum .streams/main/events.jsonl`.

Matching uses event type + event ID (including normalized tool-call IDs), or
native toolCallId/inputIndex/input_index/index when present, plus an occurrence
counter for repeated deltas. Without an identity, absolute frame ordinal is
used. Inserting an anonymous event can therefore appear as several payload
changes; this is positional alignment, not semantic inference. Reorder compares
the relative rank of matched events, so inserting an identified event alone
is not a reorder. Added and removed events report their own indices.

Payload changes compare normalized event objects recursively, including native
`data`, with JSON Pointer key paths. JSON object key order is ignored. Wire
whitespace and frame `seq` are not payload changes. Elapsed `t_ms` deltas are
reported per matched frame: these are cumulative stream times, not processing
durations. A latency gate fails only for a positive delta strictly greater
than its threshold. Equal or faster frames do not fail. Count compares total
frame counts, so one addition and one removal does not trigger count alone.

Different adapter/protocol/framing metadata, invalid frame metadata or truncated
JSONL is rejected. Identical traces print `no differences`. Exit codes are 0
for successful comparison with no gate violations (even if differences exist),
1 for gate violations or I/O errors, and 2 for invalid input/options. JSON
includes `violations`; HTML embeds sandboxed before/after timeline viewers.
The HTML contains trace payloads, so handle it like the source recordings.

See [`examples/ci/trace-diff.yml`](examples/ci/trace-diff.yml) for a two-job PR
workflow that downloads a base-commit recording artifact and fails on removed
frames. It uses the committed demo trace as a runnable placeholder; replace
both copy steps with the same deterministic application recording command.
It does not use elevated pull_request_target permissions or release packages.

Use stable seeded tool/message/run IDs in both recordings. If providers generate
new IDs on each run, normalize them consistently (including references inside
native data) before hashing/comparing; otherwise ID changes are additions and
removals by design. Provider fragment indices are scoped by step/message ID.
Completed valid JSON argument strings are compared structurally; partial argument
fragments stay byte-sensitive. HTML output may not overwrite either input trace
or the baseline manifest (symlink and hardlink aliases are also rejected).

Argument JSON numeric normalization is conservative: fractional, exponent-form and unsafe
integer values keep the original argument string, so rounding cannot hide a
payload change. Those strings may still flag whitespace/key-order changes.
