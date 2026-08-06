import { defineConfig } from '@playwright/test';

export default defineConfig({
  // This config lives in tests/; specs sit beside it, artifacts stay at repo root.
  testDir: '.',
  testMatch: ['visual_validation.spec.mjs', 'test_password_flow.mjs', 'test_interlang.mjs', 'screenshots.mjs', 'test_tabs.mjs', 'test_almanac_hero_clock.spec.mjs', 'test_login_navigation.spec.mjs', 'test_private_mode_login.spec.mjs', 'test_admin_private_library.spec.mjs', 'test_backup_hub.spec.mjs', 'test_bookmarks_folders.spec.mjs', 'test_reader_captions.spec.mjs', 'test_manage_boot_race.spec.mjs', 'test_offline_state.spec.mjs'],
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false, // Run sequentially — some tests depend on server state
  retries: 0,
  reporter: [
    ['html', { open: 'always', outputFolder: '../test-results/html-report' }],
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
  outputDir: '../test-results/artifacts',
});
