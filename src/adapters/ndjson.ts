/** Incremental NDJSON (`application/x-ndjson`) line splitter. */
export class NdjsonParser {
  private buffer = '';

  push(chunk: string): string[] {
    if (!chunk) return [];
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    const out: string[] = [];
    for (const line of lines) {
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (trimmed.trim() !== '') out.push(trimmed);
    }
    return out;
  }

  flush(): string[] {
    const rest = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer;
    this.buffer = '';
    return rest.trim() === '' ? [] : [rest];
  }
}
