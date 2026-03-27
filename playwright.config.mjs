import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: ['visual_validation.spec.mjs', 'test_password_flow.mjs', 'test_interlang.mjs', 'screenshots.mjs', 'test_tabs.mjs'],
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false, // Run sequentially — some tests depend on server state
  retries: 0,
  reporter: [
    ['html', { open: 'always', outputFolder: 'test-results/html-report' }],
    ['list'],
  ],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:8899',
    video: 'on',
    screenshot: 'on',
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
    actionTimeout: 10000,
  },
  outputDir: 'test-results/artifacts',
});
