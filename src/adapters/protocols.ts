/**
 * Protocol mapping: wire payload -> normalized event, and back.
 *
 * Three families are recognized:
 *
 *  - **AG-UI** (event names are UPPER_SNAKE: `TEXT_MESSAGE_CONTENT`,
 *    `TOOL_CALL_ARGS`, `RUN_ERROR`, ...), usually over SSE.
 *  - **Vercel AI SDK UI message stream** (`{"type":"text-delta","delta":"..."}`,
 *    `tool-input-delta`, `tool-output-available`, ...), usually over SSE.
 *  - **Vercel AI SDK legacy data stream** (`0:"text"`, `9:{...}`, `a:{...}`,
 *    `3:"error"`), usually NDJSON.
 *
 * Anything else degrades to `generic`: JSON payloads are mapped by common field
 * names, plain text becomes a `text-delta`.
 */
import type { NormalizedEvent, Protocol } from '../types.js';

export interface Classified {
  protocol: Protocol;
  events: NormalizedEvent[];
}

const AG_UI_TYPE = /^[A-Z][A-Z0-9_]+$/;
const LEGACY_LINE = /^([0-9a-z]):([\s\S]*)$/;

/** Parse a payload that may be JSON but often is not. */
export function tryJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false };
  const first = trimmed.charAt(0);
  if (first !== '{' && first !== '[' && first !== '"' && first !== 't' && first !== 'f' && first !== 'n' && !(first >= '0' && first <= '9') && first !== '-') {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Classify one payload (one SSE `data` field or one NDJSON line). */
export function classifyPayload(payload: string, hint: Protocol | 'auto' = 'auto'): Classified {
  const text = payload.trim();
  if (!text) return { protocol: hint === 'auto' ? 'generic' : hint, events: [] };

  const parsed = tryJson(text);
  if (parsed.ok) {
    const obj = asRecord(parsed.value);
    if (obj && typeof obj.type === 'string') {
      const type = obj.type;
      if (AG_UI_TYPE.test(type)) return { protocol: 'ag-ui', events: mapAgUi(type, obj) };
      if (type.includes('-') || type === 'start' || type === 'finish' || type === 'error' || type === 'abort') {
        return { protocol: 'ai-sdk', events: mapAiSdkUi(type, obj) };
      }
      if (hint === 'ag-ui') return { protocol: 'ag-ui', events: mapAgUi(type, obj) };
      if (hint === 'ai-sdk') return { protocol: 'ai-sdk', events: mapAiSdkUi(type, obj) };
      return { protocol: 'generic', events: mapGenericObject(obj) };
    }
    if (obj) return { protocol: hint === 'auto' ? 'generic' : hint, events: mapGenericObject(obj) };
    return { protocol: hint === 'auto' ? 'generic' : hint, events: [{ type: 'unknown', data: parsed.value }] };
  }

  // Legacy AI SDK data stream line: `0:"hello"`, `9:{...}`, `a:{...}`.
  const legacy = LEGACY_LINE.exec(text);
  if (legacy && legacy[2] !== undefined && /^["{[]/.test(legacy[2])) {
    return { protocol: 'ai-sdk-data', events: mapLegacyDataStream(legacy[1] as string, legacy[2]) };
  }

  // Plain text body.
  return { protocol: hint === 'auto' ? 'generic' : hint, events: [{ type: 'text-delta', delta: payload }] };
}

/** Map AG-UI events. */
function mapAgUi(type: string, obj: Record<string, unknown>): NormalizedEvent[] {
  const id = str(obj.messageId) ?? str(obj.toolCallId) ?? str(obj.runId);
  switch (type) {
    case 'RUN_STARTED':
      return [{ type: 'run-start', id: str(obj.runId), data: obj }];
    case 'RUN_FINISHED':
      return [{ type: 'finish', id: str(obj.runId), reason: 'stop', data: obj }];
    case 'RUN_ERROR':
      return [{ type: 'error', message: str(obj.message) ?? 'agent run failed', status: num(obj.code), data: obj }];
    case 'TEXT_MESSAGE_CONTENT':
      return [{ type: 'text-delta', id: str(obj.messageId), delta: str(obj.delta) ?? '', data: obj }];
    case 'TEXT_MESSAGE_START':
    case 'TEXT_MESSAGE_END':
    case 'TOOL_CALL_END':
    case 'STEP_STARTED':
    case 'STEP_FINISHED':
      return [{ type: 'lifecycle', id, name: type, data: obj }];
    case 'TOOL_CALL_START':
      return [
        { type: 'tool-call-delta', id: str(obj.toolCallId), name: str(obj.toolCallName), argsDelta: '', data: obj },
      ];
    case 'TOOL_CALL_ARGS':
      return [{ type: 'tool-call-delta', id: str(obj.toolCallId), argsDelta: str(obj.delta) ?? '', data: obj }];
    case 'TOOL_CALL_RESULT': {
      const content = obj.content;
      const result = typeof content === 'string' ? safeJsonOrString(content) : content;
      return [{ type: 'tool-result', id: str(obj.toolCallId), result, data: obj }];
    }
    case 'STATE_SNAPSHOT':
    case 'STATE_DELTA':
    case 'MESSAGES_SNAPSHOT':
    case 'ACTIVITY_SNAPSHOT':
    case 'ACTIVITY_DELTA':
    case 'THINKING_START':
    case 'THINKING_END':
    case 'THINKING_TEXT_MESSAGE_START':
    case 'THINKING_TEXT_MESSAGE_CONTENT':
    case 'THINKING_TEXT_MESSAGE_END':
    case 'RAW':
    case 'CUSTOM':
      return [{ type: 'unknown', id, name: type, data: obj }];
    default:
      return [{ type: 'unknown', name: type, data: obj }];
  }
}

/** Map Vercel AI SDK UI message stream chunks. */
function mapAiSdkUi(type: string, obj: Record<string, unknown>): NormalizedEvent[] {
  const toolCallId = str(obj.toolCallId);
  const messageId = str(obj.id) ?? str(obj.messageId);
  switch (type) {
    case 'text-delta':
      return [
        {
          type: 'text-delta',
          id: messageId,
          delta: str(obj.delta) ?? str(obj.textDelta) ?? '',
          data: obj,
        },
      ];
    case 'reasoning-delta':
      return [{ type: 'unknown', id: messageId, name: type, data: obj }];
    case 'tool-input-start':
      return [{ type: 'tool-call-delta', id: toolCallId, name: str(obj.toolName), argsDelta: '', data: obj }];
    case 'tool-input-delta':
      return [
        {
          type: 'tool-call-delta',
          id: toolCallId,
          argsDelta: str(obj.inputTextDelta) ?? str(obj.argsTextDelta) ?? str(obj.delta) ?? '',
          data: obj,
        },
      ];
    case 'tool-input-available': {
      const input = obj.input ?? obj.args;
      return [
        {
          type: 'tool-call-delta',
          id: toolCallId,
          name: str(obj.toolName),
          argsDelta: typeof input === 'string' ? input : JSON.stringify(input ?? {}),
          complete: true,
          data: obj,
        },
      ];
    }
    case 'tool-input-error':
    case 'tool-output-error':
      return [
        {
          type: 'error',
          id: toolCallId,
          message: str(obj.errorText) ?? str(obj.error) ?? 'tool failed',
          data: obj,
        },
      ];
    case 'tool-output-available':
      return [{ type: 'tool-result', id: toolCallId, result: obj.output ?? obj.result, data: obj }];
    case 'tool-approval-request':
      return [
        {
          type: 'approval',
          id: str(obj.approvalId) ?? toolCallId,
          decision: 'requested',
          data: obj,
        },
      ];
    case 'tool-approval-response':
      return [
        {
          type: 'approval',
          id: str(obj.approvalId) ?? toolCallId,
          decision: obj.approved === false ? 'denied' : 'approved',
          data: obj,
        },
      ];
    case 'error':
      return [{ type: 'error', message: str(obj.errorText) ?? str(obj.error) ?? 'stream error', data: obj }];
    case 'finish':
      return [{ type: 'finish', reason: str(obj.finishReason) ?? 'stop', data: obj }];
    case 'start':
    case 'start-step':
    case 'finish-step':
    case 'text-start':
    case 'text-end':
    case 'abort':
    case 'message-metadata':
      return [
        {
          type: type === 'start' ? 'run-start' : type === 'abort' ? 'error' : 'lifecycle',
          name: type,
          message: type === 'abort' ? 'stream aborted' : undefined,
          data: obj,
        },
      ];
    default:
      return [{ type: 'unknown', name: type, data: obj }];
  }
}

/** Map a legacy AI SDK data stream line (`code:body`). */
function mapLegacyDataStream(code: string, body: string): NormalizedEvent[] {
  const parsed = tryJson(body);
  const value = parsed.ok ? parsed.value : body;
  const obj = asRecord(value);
  switch (code) {
    case '0':
      return [{ type: 'text-delta', delta: typeof value === 'string' ? value : body }];
    case '3':
      return [
        {
          type: 'error',
          message: typeof value === 'string' ? value : str(obj?.message) ?? body,
          data: obj ?? value,
        },
      ];
    case '9':
      return [
        {
          type: 'tool-call-delta',
          id: str(obj?.toolCallId),
          name: str(obj?.toolName),
          argsDelta: typeof obj?.args === 'string' ? (obj.args as string) : JSON.stringify(obj?.args ?? {}),
          complete: true,
          data: obj ?? value,
        },
      ];
    case 'a':
      return [{ type: 'tool-result', id: str(obj?.toolCallId), result: obj?.result, data: obj ?? value }];
    case 'b':
      return [{ type: 'tool-call-delta', id: str(obj?.toolCallId), name: str(obj?.toolName), argsDelta: '', data: obj ?? value }];
    case 'c':
      return [
        {
          type: 'tool-call-delta',
          id: str(obj?.toolCallId),
          argsDelta: str(obj?.argsTextDelta) ?? '',
          data: obj ?? value,
        },
      ];
    case 'd':
      return [{ type: 'finish', reason: str(obj?.finishReason) ?? 'stop', data: obj ?? value }];
    case 'e':
      return [{ type: 'lifecycle', name: 'finish-step', data: obj ?? value }];
    case '1':
    case '2':
    case '8':
      return [{ type: 'unknown', name: `data-stream:${code}`, data: obj ?? value }];
    default:
      return [{ type: 'unknown', name: `data-stream:${code}`, data: obj ?? value }];
  }
}

/** Best-effort mapping for arbitrary JSON payloads. */
function mapGenericObject(obj: Record<string, unknown>): NormalizedEvent[] {
  if (typeof obj.delta === 'string') {
    return [{ type: 'text-delta', id: str(obj.id), delta: obj.delta, data: obj }];
  }
  if (typeof obj.text === 'string') {
    return [{ type: 'text-delta', id: str(obj.id), delta: obj.text, data: obj }];
  }
  if (typeof obj.content === 'string') {
    return [{ type: 'text-delta', id: str(obj.id), delta: obj.content, data: obj }];
  }
  if (typeof obj.error === 'string' || typeof obj.message === 'string') {
    return [{ type: 'error', message: str(obj.error) ?? str(obj.message) ?? 'error', data: obj }];
  }
  if (obj.done === true || obj.finishReason !== undefined) {
    return [{ type: 'finish', reason: str(obj.finishReason) ?? 'stop', data: obj }];
  }
  return [{ type: 'unknown', name: str(obj.type), data: obj }];
}

function safeJsonOrString(text: string): unknown {
  const parsed = tryJson(text);
  return parsed.ok ? parsed.value : text;
}

/** Wire payload for a normalized event (without SSE framing). */
export function encodeEvent(event: NormalizedEvent, protocol: Protocol): string {
  switch (protocol) {
    case 'ag-ui':
      return encodeAgUi(event);
    case 'ai-sdk':
      return encodeAiSdkUi(event);
    case 'ai-sdk-data':
      return encodeLegacy(event);
    default:
      return encodeGeneric(event);
  }
}

function encodeAgUi(event: NormalizedEvent): string {
  const base: Record<string, unknown> = {};
  switch (event.type) {
    case 'text-delta':
      return JSON.stringify({ type: 'TEXT_MESSAGE_CONTENT', messageId: event.id ?? 'msg-0', delta: event.delta ?? '' });
    case 'tool-call-delta':
      if (event.argsDelta === '') {
        return JSON.stringify({ type: 'TOOL_CALL_START', toolCallId: event.id ?? 'call-0', toolCallName: event.name });
      }
      return JSON.stringify({ type: 'TOOL_CALL_ARGS', toolCallId: event.id ?? 'call-0', delta: event.argsDelta ?? '' });
    case 'tool-result':
      return JSON.stringify({
        type: 'TOOL_CALL_RESULT',
        messageId: event.id ?? 'msg-0',
        toolCallId: event.id ?? 'call-0',
        content: typeof event.result === 'string' ? event.result : JSON.stringify(event.result ?? null),
        role: 'tool',
      });
    case 'error':
      return JSON.stringify({ type: 'RUN_ERROR', message: event.message ?? 'error', code: event.status });
    case 'finish':
      return JSON.stringify({ type: 'RUN_FINISHED', finishReason: event.reason ?? 'stop' });
    case 'approval':
      return JSON.stringify({
        type: 'CUSTOM',
        name: 'streamscope_approval',
        value: { id: event.id, decision: event.decision },
      });
    case 'run-start':
      return JSON.stringify({ type: 'RUN_STARTED', runId: event.id });
    default:
      base.type = 'CUSTOM';
      base.name = event.name ?? `streamscope_${event.type}`;
      base.value = { id: event.id, data: event.data };
      return JSON.stringify(base);
  }
}

function encodeAiSdkUi(event: NormalizedEvent): string {
  switch (event.type) {
    case 'text-delta':
      return JSON.stringify({ type: 'text-delta', id: event.id ?? 'text-0', delta: event.delta ?? '' });
    case 'tool-call-delta':
      if (event.complete) {
        return JSON.stringify({
          type: 'tool-input-available',
          toolCallId: event.id ?? 'call-0',
          toolName: event.name,
          input: safeJsonOrString(event.argsDelta ?? '{}'),
        });
      }
      return JSON.stringify({
        type: 'tool-input-delta',
        toolCallId: event.id ?? 'call-0',
        inputTextDelta: event.argsDelta ?? '',
      });
    case 'tool-result':
      return JSON.stringify({ type: 'tool-output-available', toolCallId: event.id ?? 'call-0', output: event.result });
    case 'error':
      return JSON.stringify({ type: 'error', errorText: event.message ?? 'error', statusCode: event.status });
    case 'finish':
      return JSON.stringify({ type: 'finish', finishReason: event.reason ?? 'stop' });
    case 'approval':
      return JSON.stringify({
        type: 'tool-approval-request',
        approvalId: event.id ?? 'approval-0',
        toolCallId: event.id ?? 'call-0',
        decision: event.decision,
      });
    case 'run-start':
      return JSON.stringify({ type: 'start' });
    default:
      return JSON.stringify({ type: 'data-streamscope', name: event.name ?? event.type, data: event.data });
  }
}

function encodeLegacy(event: NormalizedEvent): string {
  switch (event.type) {
    case 'text-delta':
      return `0:${JSON.stringify(event.delta ?? '')}`;
    case 'tool-call-delta':
      return `9:${JSON.stringify({
        toolCallId: event.id,
        toolName: event.name,
        // Legacy payloads carry whole arguments as JSON; a truncated fragment
        // is emitted as a raw string so the broken case stays reproducible.
        args: safeJsonOrString(event.argsDelta ?? '{}'),
      })}`;
    case 'tool-result':
      return `a:${JSON.stringify({ toolCallId: event.id, result: event.result })}`;
    case 'error':
      return `3:${JSON.stringify(event.message ?? 'error')}`;
    case 'finish':
      return `d:${JSON.stringify({ finishReason: event.reason ?? 'stop' })}`;
    case 'run-start':
      return `f:${JSON.stringify({})}`;
    default:
      return `2:${JSON.stringify({ type: event.type, name: event.name, data: event.data })}`;
  }
}

function encodeGeneric(event: NormalizedEvent): string {
  if (event.type === 'text-delta' && !event.id) return event.delta ?? '';
  const out: Record<string, unknown> = { type: event.type };
  if (event.id !== undefined) out.id = event.id;
  if (event.name !== undefined) out.name = event.name;
  if (event.delta !== undefined) out.delta = event.delta;
  if (event.argsDelta !== undefined) out.argsDelta = event.argsDelta;
  if (event.result !== undefined) out.result = event.result;
  if (event.decision !== undefined) out.decision = event.decision;
  if (event.message !== undefined) out.message = event.message;
  if (event.status !== undefined) out.status = event.status;
  if (event.reason !== undefined) out.reason = event.reason;
  return JSON.stringify(out);
}

/** Build an error payload for an injected `error(status)`. */
export function encodeErrorPayload(status: number, protocol: Protocol, message?: string): string {
  return encodeEvent(
    { type: 'error', message: message ?? `streamscope injected HTTP ${status}`, status },
    protocol,
  );
}

/** Protocol label for the meta line. */
export function adapterLabel(framing: string, protocol: Protocol): string {
  if (framing === 'ndjson') return protocol === 'ai-sdk-data' ? 'ai-sdk-data' : protocol === 'generic' ? 'ndjson' : protocol;
  return protocol === 'generic' ? framing : protocol;
}
