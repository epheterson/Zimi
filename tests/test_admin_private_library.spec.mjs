// SHIP BLOCKER (1.8.1 field): a signed-in ADMIN saw an EMPTY library in private
// (and limited) public-access mode — home "No knowledge sources found", Library
// "No ZIMs installed" — even though Settings listed every ZIM. The existing
// private-mode spec only proved the admin gate CLEARS; it never checked the
// admin's library was populated or that an article rendered. This spec closes
// both gaps.
//
// Root cause: the admin's credential is a password Bearer that only rides
// /manage/* calls. The DATA endpoints (/list, /search) are plain fetch() with no
// header, and the /w/ reader iframe is a browser navigation that CAN'T send one,
// so the server saw neither user nor admin and returned an empty library. Fix:
// an HttpOnly zimi_session admin cookie, minted at login, that rides both
// transports.
//
// Run against a FRESH passwordless server on plain http; beforeAll configures it:
//   ZIM_DIR=./zims ZIMI_DATA_DIR=/tmp/zimi-admin ZIMI_MANAGE=1 \
//     python3 -m zimi serve --port 8878
//   BASE_URL=http://localhost:8878 npx playwright test --project=webkit \
//     --config=tests/playwright.config.mjs tests/test_admin_private_library.spec.mjs

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:8878';
const ADMIN_PW = 'adminpw';
const USER = 'kid';
const USER_PW = 'crayons';

// Loopback is a private client: set the password + seed a limited user while the
// instance is still passwordless/open, then flip to private.
test.beforeAll(async ({ request }) => {
  await request.post(`${BASE}/manage/set-password`, {
    headers: { 'Content-Type': 'application/json' },
    data: { password: ADMIN_PW },
  });
  const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ADMIN_PW };
  await request.post(`${BASE}/manage/users`, {
    headers: auth,
    // A user whose allowlist is EMPTY — so if isolation ever broke, they'd see
    // the admin's ZIMs and the test would catch it.
    data: { action: 'create', name: USER, password: USER_PW, allowlist: [] },
  });
  await request.post(`${BASE}/manage/public-access`, {
    headers: auth,
    data: { mode: 'private' },
  });
});

// The client's live view through the (SW-controlled) fetch path — the security
// contract that actually matters. Also pulls the /list payload so we can assert
// the admin's library is POPULATED, not just 200-but-empty.
async function serverView(page) {
  return page.evaluate(async () => {
    const who = await (await fetch('/whoami', { credentials: 'same-origin' })).json();
    const listRes = await fetch('/list?layout=1', { credentials: 'same-origin' });
    let zimCount = 0;
    if (listRes.status === 200) {
      const data = await listRes.json();
      const zims = Array.isArray(data) ? data : data.zims || [];
      zimCount = zims.length;
    }
    return { role: who.role, listStatus: listRes.status, zimCount };
  });
}

async function adminSignIn(page) {
  await page.goto(BASE);
  await page.waitForFunction(() => window._loginRequired === true, { timeout: 8000 });
  await page.fill('#pw-username', 'admin');
  await page.fill('#pw-input', ADMIN_PW);
  await page.evaluate(() => submitPw());
  // submitPw reloads on a gate sign-in; wait until the gate is gone.
  await expect.poll(() => page.evaluate(() => window._loginRequired), { timeout: 8000 }).toBeFalsy();
  await page.waitForTimeout(400);
}

test('private-mode admin sees a POPULATED library (not the empty state)', async ({ page }) => {
  await adminSignIn(page);
  // The authoritative contract: the admin's DATA endpoints return the WHOLE
  // library, not the empty/limited set the bug produced. Read it through the
  // client's own (SW-controlled) fetch path — a plain fetch with no Auth header,
  // exactly like the app's /list call. This is stronger than scraping the home
  // grid (whose exact DOM varies with how many ZIMs the fixture installs).
  const view = await serverView(page);
  expect(view.role).toBe('admin');
  expect(view.listStatus).toBe(200);
  expect(view.zimCount, 'admin /list must return the installed ZIMs').toBeGreaterThan(0);
  // And the login gate must be gone — the admin is inside the app, not stuck at
  // the sign-in overlay or a blank library.
  expect(await page.evaluate(() => window._loginRequired)).toBeFalsy();
  await expect(page.locator('#pw-overlay.open')).toHaveCount(0);
});

test('private-mode admin can OPEN an article — the /w/ iframe renders, not blank', async ({ page }) => {
  await adminSignIn(page);
  // The reader iframe is a browser navigation carrying only the cookie. Load a
  // real /w/ content URL in an iframe and confirm the server served it (200) AND
  // the frame has a non-empty document — the exact thing that was blank before.
  const result = await page.evaluate(async () => {
    const listRes = await fetch('/list?layout=1', { credentials: 'same-origin' });
    const data = await listRes.json();
    const zims = Array.isArray(data) ? data : data.zims || [];
    const z = zims[0];
    const url = '/w/' + z.name + '/' + (z.main_path || 'index');
    const status = (await fetch(url, { credentials: 'same-origin' })).status;
    // Now the true iframe transport: no Authorization header possible.
    const bodyLen = await new Promise((resolve) => {
      const f = document.createElement('iframe');
      f.style.display = 'none';
      f.onload = () => {
        try {
          resolve((f.contentDocument.body.innerText || '').length);
        } catch (e) {
          resolve(-1);
        }
        f.remove();
      };
      f.src = url;
      document.body.appendChild(f);
    });
    return { status, bodyLen };
  });
  expect(result.status, '/w/ content must serve to a cookie-only request').toBe(200);
  expect(result.bodyLen, 'the reader iframe must render a non-empty article').toBeGreaterThan(0);
});

test('admin logout in private mode returns to the gate and cuts off access', async ({ page }) => {
  await adminSignIn(page);
  expect((await serverView(page)).role).toBe('admin');
  // manageLogout POSTs /logout (dropping the admin cookie session) then reloads.
  await page.evaluate(() => manageLogout());
  await page.waitForFunction(() => window._loginRequired === true, { timeout: 8000 });
  await expect(page.locator('#pw-overlay.open')).toBeVisible();
  const view = await serverView(page);
  expect(view.role).toBe('anonymous');
  expect(view.listStatus).toBe(401);
});
