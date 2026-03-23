// Password flow validation - run against a local server WITHOUT ZIMI_MANAGE_PASSWORD env var
// Start: ZIM_DIR=/tmp/zimi-test-zims ZIMI_DATA_DIR=/tmp/zimi-test-data ZIMI_MANAGE=1 python3 -m zimi serve --port 8877
// Run:   BASE_URL=http://localhost:8877 npx playwright test tests/test_password_flow.mjs

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:8877';

// Clear any password before each test
test.beforeEach(async ({ request }) => {
  // Try to clear password (may fail if no password set, that's fine)
  await request.post(`${BASE}/manage/set-password`, {
    headers: { 'Content-Type': 'application/json' },
    data: { password: '' }
  }).catch(() => {});
});

test('1. Manage opens without password when none set', async ({ page }) => {
  await page.goto(`${BASE}/?manage`);
  await page.waitForTimeout(2000);
  // Should see manage content, not a password prompt
  const pwOverlay = page.locator('#pw-overlay');
  await expect(pwOverlay).not.toHaveClass(/open/);
  // Should see the installed tab or library content
  await expect(page.locator('#manage-installed, #manage-status')).toBeVisible();
});

test('2. Set password via Preferences', async ({ page }) => {
  await page.goto(`${BASE}/?manage`);
  await page.waitForTimeout(2000);

  // Go to Preferences tab
  await page.click('[data-ms="preferences"]');
  await page.waitForTimeout(500);

  // Click Password button
  await page.click('#pw-btn');
  await page.waitForTimeout(500);

  // Modal should be open
  const pwOverlay = page.locator('#pw-overlay');
  await expect(pwOverlay).toHaveClass(/open/);

  // Type new password and submit
  await page.fill('#pw-input', 'mypassword');
  await page.click('.pw-primary');
  await page.waitForTimeout(1000);

  // Modal should close
  await expect(pwOverlay).not.toHaveClass(/open/);

  // Verify password is set via API
  const res = await page.request.get(`${BASE}/manage/has-password`);
  const data = await res.json();
  expect(data.has_password).toBe(true);
});

test('3. Password required after leaving and returning', async ({ page }) => {
  // First set a password via API
  await page.request.post(`${BASE}/manage/set-password`, {
    headers: { 'Content-Type': 'application/json' },
    data: { password: 'testpw' }
  });

  // Navigate to manage
  await page.goto(`${BASE}/?manage`);
  await page.waitForTimeout(2000);

  // Password modal should appear
  const pwOverlay = page.locator('#pw-overlay');
  await expect(pwOverlay).toHaveClass(/open/);

  // Enter wrong password
  await page.fill('#pw-input', 'wrongpw');
  await page.click('.pw-primary');
  await page.waitForTimeout(1000);

  // Error should show
  const pwError = page.locator('#pw-error');
  // Modal should still be open (wrong password)
  await expect(pwOverlay).toHaveClass(/open/);

  // Enter correct password
  await page.fill('#pw-input', 'testpw');
  await page.click('.pw-primary');
  await page.waitForTimeout(1000);

  // Should now see manage content
  await expect(pwOverlay).not.toHaveClass(/open/);
  await expect(page.locator('#manage-installed, #manage-status')).toBeVisible();
});

test('4. Remove password via modal', async ({ page }) => {
  // Set a password first
  await page.request.post(`${BASE}/manage/set-password`, {
    headers: { 'Content-Type': 'application/json' },
    data: { password: 'removeme' }
  });

  // Navigate and log in
  await page.goto(`${BASE}/?manage`);
  await page.waitForTimeout(2000);
  await page.fill('#pw-input', 'removeme');
  await page.click('.pw-primary');
  await page.waitForTimeout(1000);

  // Go to Preferences, click Password
  await page.click('[data-ms="preferences"]');
  await page.waitForTimeout(500);
  await page.click('#pw-btn');
  await page.waitForTimeout(500);

  // Remove button should be visible (password exists)
  const removeBtn = page.locator('#pw-remove-btn');
  await expect(removeBtn).toBeVisible();

  // Click Remove, accept confirm dialog
  page.on('dialog', dialog => dialog.accept());
  await removeBtn.click();
  await page.waitForTimeout(1000);

  // Verify password cleared
  const res = await page.request.get(`${BASE}/manage/has-password`);
  const data = await res.json();
  expect(data.has_password).toBe(false);
});

test('5. API token generate and revoke', async ({ page }) => {
  await page.goto(`${BASE}/?manage`);
  await page.waitForTimeout(2000);

  // Go to Server tab
  await page.click('[data-ms="server"]');
  await page.waitForTimeout(1000);

  // Click Generate token
  const genBtn = page.getByRole('button', { name: 'Generate' });
  await expect(genBtn).toBeVisible();
  await genBtn.click();
  await page.waitForTimeout(1000);

  // Token should be displayed
  await expect(page.locator('text=Copy this token')).toBeVisible();

  // Click Done
  await page.click('text=Done');
  await page.waitForTimeout(500);

  // Should now show Roll/Revoke buttons
  await expect(page.getByRole('button', { name: 'Revoke' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Roll' })).toBeVisible();

  // Revoke
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Revoke' }).click();
  await page.waitForTimeout(1000);

  // Should show Generate again
  await expect(page.getByRole('button', { name: 'Generate' })).toBeVisible();
});
