// Downloading the raw .zim of an installed source.
//
// It is a rare, deliberate act, so it has NO card pill taking space (Eric:
// "no big buttons... it's rare to need it"). The only affordances are
// right-click → Download ZIM file on any card and the same item on the
// Manage row's ⋯ menu. This test pins the absence of the old pills and the
// presence of the context-menu item.
//
//   npx playwright test --config=tests/playwright.config.mjs tests/test_export_download.spec.mjs

import { test, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ZIM = path.join(REPO, 'zims', 'devdocs_en_lit_2026-07.zim');

// A library with a real bookmark export PLUS one ordinary ZIM. Two ZIMs keep
// Zimi on the home grid (a one-ZIM library auto-enters that source and the
// cards under test would never render).
function exportZimDir() {
  const dir = path.join(REPO, 'test-results', 'export-dl-zims');
  mkdirSync(dir, { recursive: true });
  if (!readdirSync(dir).some((f) => f.startsWith('zimi-bookmarks'))) {
    execFileSync('python3', ['-c', `
import sys; sys.path.insert(0, ${JSON.stringify(REPO)})
from zimi import zimwriter as zw
bms = [{"zim": "demo", "path": "A/Water", "title": "Water purification"}]
reader = lambda z, p: "<html><head><title>t</title></head><body><p>x</p></body></html>"
zw.build_bookmarks_zim(bms, ${JSON.stringify(dir)}, reader=reader,
                       asset_reader=lambda z, p: (None, None))
`], { cwd: REPO });
  }
  const dest = path.join(dir, 'devdocs_en_lit_2026-07.zim');
  if (!existsSync(dest)) copyFileSync(SRC_ZIM, dest);
  return dir;
}

async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function startServer(port, env = {}) {
  const proc = spawn('python3', ['-m', 'zimi', 'serve', '--port', String(port)], {
    cwd: REPO,
    env: { ...process.env, ZIM_DIR: exportZimDir(), ...env },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(base + '/health');
      if (r.ok) return { proc, base };
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill('SIGKILL');
  throw new Error('server never became healthy on ' + port);
}

test.describe('raw .zim download — no card pills, menu only', () => {
  let srv;
  test.beforeAll(async () => {
    // Sharing ON would be the state that used to reveal the pills; prove they
    // are gone even then, so it is a real removal, not a gated hide.
    srv = await startServer(await freePort(), { ZIMI_PEER_SHARE: '1' });
  });
  test.afterAll(() => { if (srv) srv.proc.kill('SIGKILL'); });

  test('no download pill renders on any card', async ({ page }) => {
    await page.goto(srv.base);
    await expect(page.locator('.stat-card')).toHaveCount(2);
    await expect(page.locator('.card-dl-pill, .card-dl-slot')).toHaveCount(0);
    // Cards are real links again, not the div workaround the pill forced.
    await expect(page.locator('a.stat-card').first()).toBeVisible();
  });

  test('right-click offers Download ZIM file', async ({ page }) => {
    await page.goto(srv.base);
    // Loopback client on a passwordless instance bootstraps as admin, so the
    // admin-gated Download item is present.
    await page.locator('.stat-card').first().click({ button: 'right' });
    const item = page.locator('.ctx-item[data-action="download-zim"]');
    await expect(item).toBeVisible();
  });
});
