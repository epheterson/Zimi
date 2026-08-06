// An empty library because the server SAID so, and an empty library because we
// could not ASK, must never look the same.
//
// Field report: the service-worker-cached shell booted fine while the backend
// was unreachable, and home rendered its confident "No knowledge sources found /
// Add ZIM files to get started" — indistinguishable from a wiped library.
//
// These tests use real network conditions (a real server process that really
// dies, and real browser offline state), not route interception, because the
// bug lives in the seam between the cached shell and a dead backend.
//
//   npx playwright test --config=tests/playwright.config.mjs tests/test_offline_state.spec.mjs

import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ZIM = path.join(REPO, 'zims', 'devdocs_en_lit_2026-07.zim');

// A library with TWO ZIMs. One ZIM makes Zimi auto-enter that source on boot,
// so home (where the false "no sources" copy lives) would never render.
function multiZimDir() {
  const dir = path.join(REPO, 'test-results', 'offline-zims');
  mkdirSync(dir, { recursive: true });
  for (const name of ['devdocs_en_lit_2026-07.zim', 'devdocs_en_lit2_2026-07.zim']) {
    const dest = path.join(dir, name);
    if (!existsSync(dest)) copyFileSync(SRC_ZIM, dest);
  }
  return dir;
}

// Copy of the empty-library copy the app shows when the SERVER says "zero ZIMs".
// Its appearance during an outage is the bug, so it is asserted against by name.
const REAL_EMPTY_COPY = /No knowledge sources found|Add ZIM files to get started/;

async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// A real `python3 -m zimi serve` process. stop() actually kills it, which is the
// only faithful way to reproduce "the shell is cached, the backend is gone".
async function startServer(port, { zimDir = null, env = {} } = {}) {
  zimDir = zimDir || multiZimDir();
  const proc = spawn('python3', ['-m', 'zimi', 'serve', '--port', String(port)], {
    cwd: REPO,
    env: { ...process.env, ZIM_DIR: zimDir, ...env },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(base + '/health');
      if (r.ok) return { proc, base, port };
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill('SIGKILL');
  throw new Error('server never became healthy on ' + port);
}

async function stopServer(srv) {
  if (!srv || srv.proc.killed) return;
  srv.proc.kill('SIGKILL');
  // Wait for the port to actually stop answering — otherwise the "dead backend"
  // assertions race a socket that is still draining.
  for (let i = 0; i < 80; i++) {
    try {
      await fetch(srv.base + '/health', { signal: AbortSignal.timeout(300) });
    } catch (e) { return; }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Reproduce a browser that has actually USED Zimi before: the service worker is
// installed AND controlling, so the network-first routes (/health, /manage/*)
// have real cache entries. The second load is essential — a worker only takes
// control on the next navigation, and until it does nothing gets cached, which
// silently turns an "offline" test into an online one.
async function primeServiceWorker(page, base) {
  await page.goto(base, { waitUntil: 'load' });
  // Installation and claim are asynchronous and occasionally need another
  // navigation, so reload until the worker is actually in control.
  for (let i = 0; i < 5; i++) {
    const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
    if (controlled) break;
    await page.waitForTimeout(1000);
    await page.reload({ waitUntil: 'load' });
  }
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  if (!controlled) throw new Error('service worker never took control');
  // Control and coverage are different milestones. claim() can land mid-load,
  // after this document's boot fetches already went straight to the network, so
  // a controlling worker does not imply it cached anything. One more full
  // navigation guarantees a whole load passed through it.
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
}

const banner = (page) => page.locator('#conn-banner');
const bannerMsg = (page) => page.locator('#conn-banner .conn-msg');

test.describe('offline honesty', () => {
  test.describe.configure({ mode: 'serial' });

  test('(a) cached shell + dead backend never claims the library is empty', async ({ page }) => {
    test.setTimeout(120000);
    const port = await freePort();
    let srv = await startServer(port);
    try {
      await primeServiceWorker(page, srv.base);
      await expect(page.locator('.stat-card').first()).toBeVisible();

      await stopServer(srv);
      await page.reload({ waitUntil: 'commit' });

      // The shell still boots (that is the PWA promise) …
      await expect(page.locator('#logo')).toBeVisible();
      // … and it says plainly that it could not ask.
      await expect(banner(page)).toBeVisible({ timeout: 15000 });
      await expect(bannerMsg(page)).toContainText("Can't reach your Zimi server");
      await expect(page.locator('#conn-banner .conn-retry')).toBeVisible();
      // The lie is gone.
      await expect(page.locator('#output')).not.toHaveText(REAL_EMPTY_COPY);
      await expect(page.locator('#output')).toContainText('Nothing has been lost');
      // Non-blocking: no modal over the content.
      await expect(page.locator('.pw-overlay.open')).toHaveCount(0);
      // The banner pushes rather than covers.
      const offset = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--conn-h').trim());
      expect(parseFloat(offset)).toBeGreaterThan(0);
    } finally {
      await stopServer(srv);
    }
  });

  test('(b) a cold boot against a dead backend never renders the empty-library copy', async ({ page }) => {
    test.setTimeout(120000);
    const port = await freePort();
    const srv = await startServer(port);
    try {
      await primeServiceWorker(page, srv.base);
      // Cold for the DATA: the library is never persisted client-side, so after
      // clearing web storage this navigation is a first-ever library load — with
      // no server to answer it. (context.setOffline is deliberately NOT used:
      // Chromium's offline emulation does not reach service-worker fetches, so
      // it silently fails to reproduce the outage at all.)
      await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
      await stopServer(srv);
      await page.goto(srv.base, { waitUntil: 'commit' });

      await expect(banner(page)).toBeVisible({ timeout: 20000 });
      await expect(page.locator('#output')).not.toHaveText(REAL_EMPTY_COPY);
      await expect(page.locator('#output')).toContainText('Nothing has been lost');
      // Pure-math and locally-stored surfaces stay reachable while offline.
      await expect(page.locator('#library-btn')).toBeVisible();
    } finally {
      await stopServer(srv);
    }
  });

  test('(c1) Retry repopulates the library with no manual reload', async ({ page }) => {
    test.setTimeout(150000);
    const port = await freePort();
    let srv = await startServer(port);
    try {
      await primeServiceWorker(page, srv.base);
      await stopServer(srv);
      await page.reload({ waitUntil: 'commit' });
      await expect(banner(page)).toBeVisible({ timeout: 15000 });

      // Same port, so the app's origin is unchanged — the server simply returns.
      srv = await startServer(port);
      await page.locator('#conn-banner .conn-retry').click();

      await expect(banner(page)).toHaveCount(0, { timeout: 20000 });
      await expect(page.locator('.stat-card').first()).toBeVisible();
      const offset = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--conn-h').trim());
      expect(parseFloat(offset)).toBe(0);
    } finally {
      await stopServer(srv);
    }
  });

  test('(c2) the automatic probe recovers with no user action at all', async ({ page }) => {
    test.setTimeout(180000);
    const port = await freePort();
    let srv = await startServer(port);
    try {
      await primeServiceWorker(page, srv.base);
      await stopServer(srv);
      await page.reload({ waitUntil: 'commit' });
      await expect(banner(page)).toBeVisible({ timeout: 15000 });

      srv = await startServer(port);
      // No click, no reload — the backoff probe alone must notice and repair.
      await expect(banner(page)).toHaveCount(0, { timeout: 60000 });
      await expect(page.locator('.stat-card').first()).toBeVisible();
    } finally {
      await stopServer(srv);
    }
  });

  test('(c3) regaining network fires an immediate recovery, ahead of the backoff', async ({ page, context }) => {
    test.setTimeout(180000);
    const port = await freePort();
    let srv = await startServer(port);
    try {
      await primeServiceWorker(page, srv.base);
      await stopServer(srv);
      await page.reload({ waitUntil: 'commit' });
      await expect(banner(page)).toBeVisible({ timeout: 15000 });

      srv = await startServer(port);
      // Cancel the pending backoff probe so the ONLY thing that can recover the
      // page is the window 'online' listener — otherwise a passing test proves
      // nothing about which path did the work.
      await page.evaluate(() => _stopConnProbe());
      await context.setOffline(true);
      await context.setOffline(false);   // real 'online' event

      await expect(banner(page)).toHaveCount(0, { timeout: 10000 });
      await expect(page.locator('.stat-card').first()).toBeVisible();
    } finally {
      await context.setOffline(false);
      await stopServer(srv);
    }
  });

  test('(f) a cached network-first response cannot fake a live server', async ({ page }) => {
    test.setTimeout(120000);
    const port = await freePort();
    const srv = await startServer(port);
    try {
      // Prime with a CONTROLLING worker so the network-first routes (/manage/*)
      // hold real cache entries — a worker that is merely installed caches
      // nothing, which quietly turns this into an online test.
      await primeServiceWorker(page, srv.base);
      await stopServer(srv);
      await page.reload({ waitUntil: 'commit' });
      await expect(banner(page)).toBeVisible({ timeout: 15000 });

      // /manage/has-password is network-FIRST: with the server dead the service
      // worker answers it from cache with a perfectly ordinary 200. Reading that
      // as "the server is up" promoted the state to connected and parked the
      // banner on "Reconnected. Reloading…" with the library never arriving.
      // Bounded poll, not a single sample: the entry is written by the worker
      // asynchronously. Waiting cannot mask a failure here, since a test whose
      // premise never materialises throws rather than silently passing.
      await page.waitForFunction(async () => {
        for (const k of await caches.keys()) {
          const c = await caches.open(k);
          if (await c.match('/manage/has-password')) return true;
        }
        return false;
      }, null, { timeout: 15000 }).catch(() => {
        throw new Error('the cached 200 this test turns on was never written');
      });

      await page.evaluate(() => _stopConnProbe());
      await page.evaluate(() => _probeManageAuth());
      await page.waitForTimeout(1500);

      // Sampled once, not polled: the invariant is that the cached response never
      // promotes the state, and a poll would just wait for the backoff to repair it.
      const after = await page.evaluate(() => ({ state: _connState, known: _libraryKnown }));
      expect(after.state, 'a cached 200 must not report the server as reachable').not.toBe('online');
      expect(after.known).toBe(false);
      await expect(page.locator('#output')).not.toHaveText(REAL_EMPTY_COPY);
    } finally {
      await stopServer(srv);
    }
  });

  test('(d) a genuinely empty server still shows the real empty state', async ({ page }) => {
    test.setTimeout(120000);
    const port = await freePort();
    const empty = path.join(REPO, 'test-results', 'empty-zims-' + port);
    mkdirSync(empty, { recursive: true });
    const srv = await startServer(port, { zimDir: empty });
    try {
      await page.goto(srv.base, { waitUntil: 'load' });
      await expect(page.locator('#output')).toContainText(REAL_EMPTY_COPY, { timeout: 15000 });
      // The server answered, so no connection banner and no offline copy.
      await expect(banner(page)).toHaveCount(0);
      await expect(page.locator('#output')).not.toContainText('Nothing has been lost');
    } finally {
      await stopServer(srv);
    }
  });

  test('(e) a private instance still shows the login gate, not the offline banner', async ({ page }) => {
    test.setTimeout(120000);
    const port = await freePort();
    const srv = await startServer(port, {
      env: { ZIMI_MANAGE_PASSWORD: 'secret123', ZIMI_PUBLIC_ACCESS: 'private' },
    });
    try {
      await page.goto(srv.base, { waitUntil: 'load' });
      await expect(page.locator('#pw-overlay')).toBeVisible({ timeout: 15000 });
      await expect(banner(page)).toHaveCount(0);
    } finally {
      await stopServer(srv);
    }
  });
});
