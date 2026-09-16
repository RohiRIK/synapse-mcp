import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: { browserName: 'chromium', headless: true, viewport: { width: 1440, height: 1100 } },
});
