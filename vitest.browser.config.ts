import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
export default defineConfig({ server: { host: '127.0.0.1' }, test: { include: ['e2e/**/*.browser.test.ts'], browser: { enabled: true, provider: playwright(), instances: [{ browser: 'chromium' }], headless: true } } });
