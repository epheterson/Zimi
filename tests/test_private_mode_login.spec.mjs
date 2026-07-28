// Private (sign-in-required) mode: the boot gate must paint the login form as
// its FIRST frame (no empty library-chrome flash), and a sign-in must STICK
// across a reload over plain http — for BOTH a named user (session cookie) and
// the admin (Bearer token in client storage).
//
// Regression (1.8.1 private-mode field test):
//   1. Empty home rendered before the 401/whoami swapped in the login overlay.
//   2. Admin login "wouldn't stick": /whoami was probed WITHOUT the admin's
//      Bearer token, so the server saw anonymous+login_required and the client
//      re-gated a just-signed-in admin on reload. (The user/cookie path stuck;
//      the token-admin path did not.)
//
// Run against a private-mode server on plain http. Recommended engine: webkit
// (approximates private Safari, the reported environment).
//   ZIM_DIR=./zims ZIMI_DATA_DIR=/tmp/zimi-private ZIMI_MANAGE=1 \
//     python3 -m zimi serve --port 8877
//   BASE_URL=http://localhost:8877 npx playwright test --project=webkit \
//     --config=tests/playwright.config.mjs tests/test_private_mode_login.spec.mjs

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:8877';
const ADMIN_PW = 'adminpw';
const USER = 'alice';
const USER_PW = 'wonderland';

// Loopback is a private client, so it may set the password + seed a user while
// the instance is still passwordless/open, then flip to private mode.
test.beforeAll(async ({ request }) => {
  await request.post(`${BASE}/manage/set-password`, {
    headers: { 'Content-Type': 'application/json' },
    data: { password: ADMIN_PW },
  });
  const auth = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + ADMIN_PW,
  };
  await request.post(`${BASE}/manage/users`, {
    headers: auth,
    data: { action: 'create', name: USER, password: USER_PW },
  });
  await request.post(`${BASE}/manage/public-access`, {
    headers: auth,
    data: { mode: 'private' },
  });
});

// Sample every animation frame from first paint, recording whether library
// chrome (loading spinner / home output) is ever visible WITHOUT the opaque
// login gate covering the page — i.e. the "empty flash".
async function armFlashSampler(page) {
  await page.addInitScript(() => {
    window.__frames = [];
    const snap = () => {
      const out = document.getElementById('output');
      const gateCovering = !!document.querySelector('#pw-overlay.open') &&
                           document.body.classList.contains('login-gate');
      const outLen = ((out && out.innerText) || '').trim().length;
      window.__frames.push({ gateCovering, outLen, hasLoading: !!document.querySelector('.loading') });
      if (window.__frames.length < 300) requestAnimationFrame(snap);
    };
    requestAnimationFrame(snap);
  });
}

test('private boot paints the login form first — no empty library flash', async ({ page }) => {
  await armFlashSampler(page);
  await page.goto(BASE);
  await page.waitForFunction(() => window._loginRequired === true, { timeout: 8000 });
  await expect(page.locator('#pw-overlay.open')).toBeVisible();
  const frames = await page.evaluate(() => window.__frames || []);
  const flashes = frames.filter(f => (f.hasLoading || f.outLen > 0) && !f.gateCovering);
  expect(flashes, 'library chrome must never paint before the gate covers it').toHaveLength(0);
});

test('named-user sign-in sticks across reload (session cookie, plain http)', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window._loginRequired === true, { timeout: 8000 });
  await page.fill('#pw-username', USER);
  await page.fill('#pw-input', USER_PW);
  await page.evaluate(() => submitPw());
  // submitPw reloads on a gate sign-in; wait until the gate is gone.
  await expect.poll(() => page.evaluate(() => window._loginRequired), { timeout: 8000 }).toBeFalsy();
  await page.goto(BASE);  // explicit reopen
  await page.waitForFunction(() => typeof _loginRequired !== 'undefined', { timeout: 8000 });
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window._loginRequired)).toBeFalsy();
  await expect(page.locator('#pw-overlay.open')).toHaveCount(0);
});

test('admin sign-in sticks across reload (Bearer token, not re-gated)', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window._loginRequired === true, { timeout: 8000 });
  await page.fill('#pw-username', 'admin');
  await page.fill('#pw-input', ADMIN_PW);
  await page.evaluate(() => submitPw());
  await expect.poll(() => page.evaluate(() => window._loginRequired), { timeout: 8000 }).toBeFalsy();
  await page.goto(BASE);  // reload: boot gate must recognise the token-admin
  await page.waitForFunction(() => typeof _loginRequired !== 'undefined', { timeout: 8000 });
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window._loginRequired)).toBeFalsy();
  await expect(page.locator('#pw-overlay.open')).toHaveCount(0);
});
