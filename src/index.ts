/** streamscope public API. */
export * from './types.js';

export { Recorder, createRecorder, recordStream } from './recorder.js';
export type { RecorderOptions } from './recorder.js';

export { startRecordingProxy, createMiddleware, handleProxyRequest } from './proxy.js';
export type { ProxyOptions, ProxyHandle } from './proxy.js';

export {
  FaultSyntaxError,
  applyFaults,
  defaultEncoder,
  formatScenario,
  parseScenario,
  truncateUtf8,
} from './faults.js';
export type { ApplyOptions, Fault, InjectedResult } from './faults.js';

export { frameDelayMs, prepareReplay, startReplayServer, streamReplay } from './replay.js';
export type { ReplayOptions, ReplayServerHandle, ReplayServerOptions } from './replay.js';

export {
  DEFAULT_STREAMS_DIR,
  TRACE_FILE,
  formatSummary,
  newSessionId,
  parseTrace,
  readTrace,
  resolveTracePath,
  summarize,
  traceToJsonl,
  writeTrace,
} from './trace.js';

export { escapeHtml, renderPanelHtml, safeJson, stateAt } from './ui/panel.js';
export type { PanelOptions, PanelState } from './ui/panel.js';

export { createAdapter, detectFraming } from './adapters/index.js';
export type { AdapterOptions, FramingChoice, ProtocolChoice, StreamAdapter } from './adapters/index.js';
export { classifyPayload, encodeEvent, encodeErrorPayload } from './adapters/protocols.js';
export { SseParser, formatSseMessage } from './adapters/sse.js';
export type { SseMessage } from './adapters/sse.js';
export { NdjsonParser } from './adapters/ndjson.js';

export { diffTraces, diffViolations, formatTraceDiff, parseDiffGates, renderDiffHtml } from './diff.js';
export type { TraceDiff, FrameChange, PayloadChange, DiffGate } from './diff.js';

export { startServe } from './serve.js';
export type { ServeOptions, ServeHandle } from './serve.js';
