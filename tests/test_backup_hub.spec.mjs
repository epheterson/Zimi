// Backup hub (v1.8.1): the two clearly-separated cards — "My data" and "Server
// backup" — each with their own Export + Import, scope-validated imports, and a
// signed-in user's Save-to / Restore-from-server round-trip.
//
// Start a password-protected server with a scratch data dir first:
//   ZIM_DIR=./zims ZIMI_DATA_DIR=/tmp/zimi-backup-hub ZIMI_MANAGE=1 \
//     python3 -m zimi serve --port 8877
// Run:
//   BASE_URL=http://localhost:8877 npx playwright test \
//     --config=tests/playwright.config.mjs tests/test_backup_hub.spec.mjs

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:8893';
const PW = 'hunter2';

test.beforeAll(async ({ request }) => {
  // Loopback client is private, so it may set the admin password.
  await request.post(`${BASE}/manage/set-password`, {
    headers: { 'Content-Type': 'application/json' },
    data: { password: PW },
  });
  // A named user for the signed-in My-data flow.
  await request.post(`${BASE}/manage/users`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PW}` },
    data: { action: 'create', name: 'kiddo', password: 'kidpw', role: 'user' },
  });
});

async function freshAdminServerPane(page) {
  await page.goto(BASE);
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(BASE);
  await page.waitForFunction(() => typeof enterManage === 'function');
  // Seed the admin token + enable manage directly so the test doesn't race the
  // boot probe; then enter manage and land on the Server pane.
  await page.evaluate((pw) => { manageEnabled = true; _manageToken = pw; _manageUser = 'admin'; enterManage(); }, PW);
  await expect.poll(() => page.evaluate(() => mode)).toBe('manage');
  // renderManage fetches /manage/status then lands on the Library pane; its
  // async switchMs('library') can clobber a one-shot switch, so re-apply
  // switchMs('server') each poll until the Server pane (and its cards) sticks.
  await expect.poll(() =>
    page.evaluate(() => { switchMs('server'); return !!document.querySelector('#ms-server-file'); })
  ).toBe(true);
}

test('admin Server pane renders both cards with separate controls', async ({ page }) => {
  await freshAdminServerPane(page);
  // My-data card controls.
  await expect(page.locator('#ms-mydata-file')).toHaveCount(1);
  await expect(page.locator('#ms-mydata-overwrite')).toHaveCount(1);
  await expect(page.locator('#ms-mydata-status')).toHaveCount(1);
  // Server-backup card controls — distinct ids, its own import/preview slot.
  await expect(page.locator('#ms-server-file')).toHaveCount(1);
  await expect(page.locator('#ms-server-overwrite')).toHaveCount(1);
  await expect(page.locator('#ms-server-import')).toHaveCount(1);
  // Admin (no named-user session) → the My-data card is file-only, no
  // Save/Restore-to-server buttons.
  await expect(page.locator('button', { hasText: 'Save to server' })).toHaveCount(0);
});

test('scope-mismatch imports fail clearly, pointing at the right card', async ({ page }) => {
  await freshAdminServerPane(page);
  // A My-data bundle dropped on the Server-backup card.
  await page.evaluate(() =>
    _previewServerBackup(JSON.stringify({ schema: 'zimi-backup', scope: 'my-data', bookmarks: [] }))
  );
  await expect.poll(() =>
    page.evaluate(() => document.getElementById('ms-server-status').textContent)
  ).toContain('My data card');
  // A server bundle dropped on the My-data card.
  await page.evaluate(() =>
    _applyMyDataFile(JSON.stringify({ schema: 'zimi-backup', scope: 'server' }))
  );
  await expect.poll(() =>
    page.evaluate(() => document.getElementById('ms-mydata-status').textContent)
  ).toContain('Server backup card');
});

test('signed-in user saves then restores My data from their server account', async ({ page }) => {
  await page.goto(BASE);
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(BASE);
  await page.waitForFunction(() => typeof openLoginModal === 'function');
  await page.evaluate(() => openLoginModal());
  await page.waitForSelector('#pw-overlay.open');
  await page.fill('#pw-username', 'kiddo');
  await page.fill('#pw-input', 'kidpw');
  await page.evaluate(() => submitPw());
  await expect.poll(() => page.evaluate(() => !!(_userSession && _userSession.name))).toBe(true);
  // The user's account view carries their My-data card (with server buttons).
  await expect.poll(() =>
    page.evaluate(() => { manageEnabled = true; enterManage(); return !!document.querySelector('#ms-mydata-file'); })
  ).toBe(true);
  await expect(page.locator('button', { hasText: 'Save to server' })).toHaveCount(1);
  // Seed a bookmark, save to server, wipe locally, restore — it comes back.
  await page.evaluate(() =>
    _setStorageJSON(SK.BOOKMARKS, [{ zim: 'w', path: '/a', timestamp: 1 }])
  );
  await page.evaluate(() => saveMyDataToServer());
  await expect.poll(() =>
    page.evaluate(() => document.getElementById('ms-mydata-status').textContent)
  ).toContain('account');
  await page.evaluate(() => _setStorageJSON(SK.BOOKMARKS, []));
  await page.evaluate(() => restoreMyDataFromServer());
  await expect.poll(() =>
    page.evaluate(() => _getStorageJSON(SK.BOOKMARKS, []).length)
  ).toBe(1);
});
