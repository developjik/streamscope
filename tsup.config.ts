import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    playwright: 'src/playwright.ts',
    cli: 'bin/cli.ts',
  },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  // Declarations are emitted by `tsc -p tsconfig.build.json` instead: tsup's
  // rollup-plugin-dts path needs the TypeScript JS compiler API, which
  // typescript 7 (native) no longer ships.
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: false,
});
