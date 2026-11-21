/**
 * SSE framing parser (WHATWG `text/event-stream`): incremental, chunk-boundary
 * safe, tolerates `\n`, `\r\n` and lone `\r` line endings, comments and
 * multi-line `data:` fields.
 */

export interface SseMessage {
  event?: string;
  id?: string;
  retry?: number;
  /** All `data:` lines joined with `\n`, as the spec prescribes. */
  data: string;
  /** Wire form of the message (what streamscope stores as `raw`). */
  raw: string;
}

/** Render a message back to its wire form. */
export function formatSseMessage(msg: Omit<SseMessage, 'raw'>): string {
  let out = '';
  if (msg.id !== undefined) out += `id: ${msg.id}\n`;
  if (msg.event !== undefined) out += `event: ${msg.event}\n`;
  if (msg.retry !== undefined) out += `retry: ${msg.retry}\n`;
  for (const line of msg.data.split('\n')) out += `data: ${line}\n`;
  return `${out}\n`;
}

export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];
  private event: string | undefined;
  private id: string | undefined;
  private retry: number | undefined;

  push(chunk: string): SseMessage[] {
    if (!chunk) return [];
    this.buffer += chunk;
    const out: SseMessage[] = [];

    // A lone trailing CR may be the first half of CRLF that lands next chunk.
    let pendingCarriageReturn = '';
    let work = this.buffer;
    if (work.endsWith('\r')) {
      pendingCarriageReturn = '\r';
      work = work.slice(0, -1);
    }
    work = work.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = work.split('\n');
    const rest = lines.pop() ?? '';
    this.buffer = rest + pendingCarriageReturn;

    for (const line of lines) this.consumeLine(line, out);
    return out;
  }

  /** Flush a trailing partial line / message at end of stream. */
  flush(): SseMessage[] {
    const out: SseMessage[] = [];
    if (this.buffer) {
      const line = this.buffer.replace(/\r$/, '');
      this.buffer = '';
      this.consumeLine(line, out);
    }
    this.dispatch(out);
    return out;
  }

  private consumeLine(line: string, out: SseMessage[]): void {
    if (line === '') {
      this.dispatch(out);
      return;
    }
    if (line.startsWith(':')) return; // comment / heartbeat
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data':
        this.dataLines.push(value);
        break;
      case 'event':
        this.event = value;
        break;
      case 'id':
        this.id = value;
        break;
      case 'retry': {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n)) this.retry = n;
        break;
      }
      default:
        // Unknown field: the spec says ignore it.
        break;
    }
  }

  private dispatch(out: SseMessage[]): void {
    if (this.dataLines.length === 0 && this.event === undefined && this.id === undefined) {
      this.event = undefined;
      this.id = undefined;
      this.retry = undefined;
      return;
    }
    const data = this.dataLines.join('\n');
    const msg: Omit<SseMessage, 'raw'> = { data };
    if (this.event !== undefined) msg.event = this.event;
    if (this.id !== undefined) msg.id = this.id;
    if (this.retry !== undefined) msg.retry = this.retry;
    out.push({ ...msg, raw: formatSseMessage(msg) });
    this.dataLines = [];
    this.event = undefined;
    this.id = undefined;
    this.retry = undefined;
  }
}
