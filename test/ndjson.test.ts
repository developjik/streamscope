import { describe, expect, it } from 'vitest';
import { NdjsonParser } from '../src/adapters/ndjson.js';

describe('NdjsonParser', () => {
  it('splits lines across chunks and drops blank lines', () => {
    const parser = new NdjsonParser();
    expect(parser.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(parser.push(':2}\n\n')).toEqual(['{"b":2}']);
  });

  it('strips CR line endings', () => {
    const parser = new NdjsonParser();
    expect(parser.push('{"a":1}\r\n')).toEqual(['{"a":1}']);
  });

  it('flushes a trailing partial line', () => {
    const parser = new NdjsonParser();
    expect(parser.push('{"a":1}')).toEqual([]);
    expect(parser.flush()).toEqual(['{"a":1}']);
  });

  it('returns nothing for whitespace-only flushes', () => {
    const parser = new NdjsonParser();
    parser.push('\n');
    expect(parser.flush()).toEqual([]);
  });
});
