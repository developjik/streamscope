/** No Vitest runtime dependency. Register with expect.extend({ toMatchTrace }). */
export { createTraceFetch, toMatchTrace } from './fixtures.js';
export type { TraceFetchOptions, TraceMatchResult } from './fixtures.js';

import type { Trace, TraceFrame } from './types.js';
import type {} from 'vitest';
declare module 'vitest' {
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> {
    toMatchTrace(expected: Trace | TraceFrame[]): R;
  }
}
