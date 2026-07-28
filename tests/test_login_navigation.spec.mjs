// Admin sign-in must land in (and stay in) the manage view, and must not wipe
// the in-memory manage token.
//
// Regression: the sign-in modal's admin branch called toggleManage() on
// success. When the modal was opened from within the manage view
// (mode === 'manage'), toggleManage() TOGGLED OFF — it cleared _manageToken
// and dropped the user back on home right after a successful login, reading as
// both "post-login lands on home" and "remember-me didn't stick" (the live
// token was wiped even though the persisted copy survived). The handler now
// re-enters manage deterministically via enterManage().
//
// Start a password-protected server first:
//   ZIM_DIR=/tmp/zimi-empty ZIMI_DATA_DIR=/tmp/zimi-auth ZIMI_MANAGE=1 \
//     python3 -m zimi serve --port 8878
// Run:
//   BASE_URL=http://localhost:8878 npx playwright test --config=tests/playwright.config.mjs tests/test_login_navigation.spec.mjs

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:8878';
const PW = 'hunter2';

test.beforeAll(async ({ request }) => {
  // Loopback client is private, so it may set the password.
  await request.post(`${BASE}/manage/set-password`, {
    headers: { 'Content-Type': 'application/json' },
    data: { password: PW },
  });
});

async function fresh(page) {
  await page.goto(BASE);
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(BASE);
  // Wait for the app's manage probe to settle before driving auth.
  await page.waitForFunction(() => typeof mode !== 'undefined' && typeof submitPw === 'function');
}

async function signInAdmin(page) {
  await page.fill('#pw-username', 'admin');
  await page.fill('#pw-input', PW);
  await page.evaluate(() => submitPw());
}

test('admin sign-in from WITHIN manage stays in manage and keeps the token', async ({ page }) => {
  await fresh(page);
  await page.evaluate((pw) => { _manageToken = pw; _manageUser = 'admin'; enterManage(); }, PW);
  await expect.poll(() => page.evaluate(() => mode)).toBe('manage');
  // Re-authenticate via the sign-in modal while already in manage.
  await page.evaluate(() => openLoginModal());
  await page.waitForSelector('#pw-overlay.open');
  await signInAdmin(page);
  // Must NOT toggle off to home; the live token must survive.
  await expect.poll(() => page.evaluate(() => mode)).toBe('manage');
  await expect.poll(() => page.evaluate(() => !!_manageToken)).toBe(true);
});

test('admin sign-in from HOME lands in manage and persists across reload', async ({ page }) => {
  await fresh(page);
  await page.evaluate(() => openLoginModal());
  await page.waitForSelector('#pw-overlay.open');
  await signInAdmin(page);
  await expect.poll(() => page.evaluate(() => mode)).toBe('manage');
  await expect.poll(() => page.evaluate(() => !!localStorage.getItem('zimi_manage_pw'))).toBe(true);
  // Remember-me: a reload (localStorage survives) keeps the admin authenticated.
  await page.goto(BASE);
  await expect.poll(() => page.evaluate(() => !!_manageToken)).toBe(true);
});
