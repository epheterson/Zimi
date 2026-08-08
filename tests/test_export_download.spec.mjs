// Download button on bookmark-export cards — the "save the .zim itself" half
// of sharing exports between devices.
//
// The button is ALWAYS rendered on export cards so the path stays
// discoverable; what the click does depends on the /dl/ gate:
//   sharing on  → the file downloads (Content-Disposition: attachment)
//   sharing off → a toast names the switch that opens it, nothing downloads
//
// Real servers (one per gate state), a REAL zimwriter-built export ZIM, and
// real browser download events — no route interception.
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

// The export card's download link on the home grid.
const DL_PILL = '.stat-card .card-dl-pill';

test.describe('export download button — sharing ON', () => {
  let srv;
  test.beforeAll(async () => {
    srv = await startServer(await freePort(), { ZIMI_PEER_SHARE: '1' });
  });
  test.afterAll(() => { if (srv) srv.proc.kill('SIGKILL'); });

  test('home card shows the button and the click saves the .zim', async ({ page }) => {
    await page.goto(srv.base);
    const pill = page.locator(DL_PILL).first();
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute('download', /^zimi-bookmarks.*\.zim$/);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      pill.click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^zimi-bookmarks.*\.zim$/);
    // The saved bytes must be the real ZIM, not a JSON error body.
    const stream = await download.createReadStream();
    const first4 = await new Promise((resolve, reject) => {
      stream.once('readable', () => resolve(stream.read(4)));
      stream.once('error', reject);
    });
    expect(first4.toString('latin1')).toBe('ZIM\x04'); // libzim magic
  });

  test('non-export cards carry no download pill', async ({ page }) => {
    await page.goto(srv.base);
    await expect(page.locator('.stat-card')).toHaveCount(2);
    await expect(page.locator(DL_PILL)).toHaveCount(1); // export only
  });
});

test.describe('export download button — sharing OFF (gated)', () => {
  let srv;
  test.beforeAll(async () => {
    srv = await startServer(await freePort(), { ZIMI_PEER_SHARE: '0' });
  });
  test.afterAll(() => { if (srv) srv.proc.kill('SIGKILL'); });

  test('button still renders; click explains instead of downloading', async ({ page }) => {
    await page.goto(srv.base);
    const pill = page.locator(DL_PILL).first();
    await expect(pill).toBeVisible(); // discoverable even while gated

    let downloaded = false;
    page.on('download', () => { downloaded = true; });
    await pill.click();
    // Toast copy from i18n key dl_needs_sharing.
    await expect(page.getByText(/Nearby sharing/)).toBeVisible();
    expect(downloaded).toBe(false);
  });
});
