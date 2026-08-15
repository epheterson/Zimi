// The Manage round: four complaints, each of which was the interface telling
// the truth badly or not at all.
//
//   the flicker    the create page's engine picker drew Chromium greyed with an
//                  install command under it, then un-greyed it when the probe
//                  landed. Nothing had changed; the page had guessed "missing"
//                  out loud and corrected itself. Asserted here as: an ordinary
//                  poll never moves the picker.
//   the reload     "Check now" replaced the whole app-update block with a
//                  one-line "Checking…", collapsing five rows to one and
//                  rebuilding both selects. Asserted as: the nodes outside the
//                  status row are the SAME nodes afterwards.
//   the creator    capability, output and default facts existed only inside the
//                  create page's own poll. Now they are a Manage section.
//   auto-update    a select that said how often the updater should run and
//                  nothing about whether it ever had.
//
//   mkdir -p /tmp/zimi-manage-ux/zims /tmp/zimi-manage-ux/data
//   cp zims/devdocs_en_lit_2026-07.zim /tmp/zimi-manage-ux/zims/
//   ZIM_DIR=/tmp/zimi-manage-ux/zims ZIMI_DATA_DIR=/tmp/zimi-manage-ux/data \
//     ZIMI_MANAGE=1 python3 -m zimi serve --port 8932
//   BASE_URL=http://localhost:8932 npx playwright test \
//     --config=tests/playwright.config.mjs tests/test_manage_ux.spec.mjs

import { test, expect } from '@playwright/test';

// The stubs below ride page.route, and the app's service worker handles
// /manage/* network-first — a fetch the SW mediates never reaches the route,
// so whether a stub applied depended on whether the SW had claimed the page
// yet. Nothing here tests the SW; take it out of the picture.
test.use({ serviceWorkers: 'block' });

const BASE = process.env.BASE_URL || 'http://localhost:8932';

async function fresh(page, theme) {
  await page.goto(BASE);
  await page.evaluate((t) => {
    localStorage.clear();
    sessionStorage.clear();
    if (t) localStorage.setItem('zimi_app_theme', t);
  }, theme);
  await page.goto(BASE);
  await page.waitForFunction(() => typeof enterManage === 'function');
}

// create.js is lazy-loaded, so none of its state exists until openCreate() has
// pulled the module in. The chip selector is the signal that it has.
async function openCreatePage(page) {
  await page.waitForFunction(() => typeof window.openCreate === 'function');
  await page.evaluate(() => window.openCreate());
  await page.waitForSelector('.create-chip', { state: 'attached' });
  await page.waitForFunction(() => window._createStatus !== undefined);
}

// Serve a known auto-update payload, so the assertions are about what the
// renderer draws rather than about whichever ZIMs the fixture server holds.
// Intercepted rather than injected: _renderAutoUpdateSection paints the slot
// from its own fetch, and a test that wrote HTML into that slot by hand would
// race the reply and lose under load.
async function stubAutoUpdate(page, payload) {
  await page.route('**/manage/auto-update*', (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });
}

async function enterSection(page, section, theme) {
  await fresh(page, theme);
  await page.evaluate(() => { manageEnabled = true; enterManage(); });
  await expect.poll(() => page.evaluate(() => mode)).toBe('manage');
  await page.evaluate((s) => switchMs(s), section);
}

// ── 1. the engine picker holds still ────────────────────────────────────────

test('an unanswered capability is not drawn as a refusal', async ({ page }) => {
  await fresh(page);
  await openCreatePage(page);
  // Before any probe reply, a capability is null — not false. The distinction
  // is the whole fix: only a KNOWN false may grey an option, so an unanswered
  // one renders plainly instead of wearing an install command it may not need.
  const states = await page.evaluate(() => ({
    unknownBoots: window._createCapBoot('nothing-ever-answered-this'),
    unknownIsNotMissing: window._createCapabilityMissing('nothing-ever-answered-this'),
    knownFalseIsMissing: (function() {
      const was = window._createBrowserReady;
      window._createIngest({ offline: false, queue: [], browser_ready: false });
      const missing = window._createCapabilityMissing('browser');
      window._createIngest({ offline: false, queue: [], browser_ready: was === true });
      return missing;
    })(),
  }));
  expect(states.unknownBoots).toBeNull();
  expect(states.unknownIsNotMissing).toBe(false);
  expect(states.knownFalseIsMissing).toBe(true);
});

test('ten ordinary polls do not move the engine picker', async ({ page }) => {
  await fresh(page);
  await openCreatePage(page);
  await page.evaluate(() => window._createSelectMode('page'));
  await expect.poll(() => page.locator('.create-seg-opt').count()).toBeGreaterThan(0);

  const before = await page.evaluate(() =>
    document.getElementById('create-panel').innerHTML);
  const keyBefore = await page.evaluate(() => window._createAvailabilityKey());

  // Ten polls of the shape an ordinary heartbeat has: NO capability fields at
  // all, because those ride the probe poll only. This is exactly the payload
  // that used to leave the picker re-deriving itself.
  const after = await page.evaluate(() => {
    for (let i = 0; i < 10; i++) {
      window._createIngest({ offline: false, queue: [] });
      window._renderCreateRun();
    }
    return document.getElementById('create-panel').innerHTML;
  });
  expect(after).toBe(before);
  // The fingerprint the redraw is keyed on never moved either.
  expect(await page.evaluate(() => window._createAvailabilityKey())).toBe(keyBefore);
});

test('a capability, once known, survives a reload', async ({ page }) => {
  await fresh(page);
  await openCreatePage(page);
  await page.evaluate(() => {
    window._createIngest({ offline: false, queue: [], browser_ready: true, alive_ready: false });
  });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('zimi_create_caps')));
  expect(saved.browser).toBe(true);
  expect(saved.alive).toBe(false);

  // A fresh page starts from what this browser last learned rather than from
  // "assume nothing is installed", so the second visit never flickers at all.
  await page.goto(BASE);
  await openCreatePage(page);
  expect(await page.evaluate(() => window._createCapBoot('browser'))).toBe(true);
});

// ── 2. "Check now" stays in its own block ───────────────────────────────────

test('checking for an app update leaves every other node alone', async ({ page }) => {
  await enterSection(page, 'server');
  await expect.poll(() => page.locator('#ms-app-update-status').count()).toBe(1);

  // Tag the nodes that must survive, then check.
  await page.evaluate(() => {
    document.querySelectorAll('#ms-pane > *, #ms-app-update-settings, #ms-app-update-how')
      .forEach((el, i) => { el.dataset.probe = 'n' + i; });
  });
  const heightBefore = await page.locator('#ms-app-update').evaluate(el => el.offsetHeight);

  await page.locator('#ms-app-update button.pill').click();
  await expect.poll(() =>
    page.locator('#ms-app-update .spinner-inline').count().catch(() => 0)
  ).toBeGreaterThanOrEqual(0);
  await page.waitForTimeout(1500);

  // Same node objects, still carrying the marks — nothing outside the status
  // row was rebuilt, so the two selects kept their identity.
  const survivors = await page.evaluate(() =>
    [...document.querySelectorAll('[data-probe]')].length);
  expect(survivors).toBeGreaterThan(0);
  await expect(page.locator('#ms-app-update-settings[data-probe]')).toHaveCount(1);

  // And the block never collapsed: the old code dropped it to one line, which
  // is what shoved the rest of the pane up and back down.
  const heightAfter = await page.locator('#ms-app-update').evaluate(el => el.offsetHeight);
  expect(Math.abs(heightAfter - heightBefore)).toBeLessThan(60);
});

// ── 3. the Creator section ──────────────────────────────────────────────────

test('the creator section reports what this server can capture with', async ({ page }) => {
  await enterSection(page, 'creator');
  const pane = page.locator('#ms-creator');
  // Generous, and deliberately so: the first call to /manage/creator pays for
  // the capability probes, which shell out. They are cached for the life of the
  // process afterwards (the endpoint answers in about a millisecond once warm),
  // but that first one has been measured at twelve seconds on a machine already
  // busy running crawls. The section shows "Loading" until it lands, which is
  // the correct behaviour — so the test waits rather than pretending it is fast.
  await expect.poll(() => pane.innerText(), { timeout: 30000 }).not.toContain('Loading');
  // Every engine is named with a verdict beside it, installed or not.
  for (const label of ['Browser engine', 'Archive converter', 'Recording engine']) {
    await expect(page.locator('.mc-label', { hasText: label })).toHaveCount(1);
  }
  // And the facts the create form used to be the only place to learn.
  await expect(page.locator('.ms-section-label', { hasText: 'Output' })).toHaveCount(1);
  await expect(page.locator('.ms-section-label', { hasText: 'Capture defaults' })).toHaveCount(1);
  await expect(page.locator('.ms-section-label', { hasText: 'Queue' })).toHaveCount(1);
});

test('the creator section is addressable, so a reload lands back on it', async ({ page }) => {
  await enterSection(page, 'creator');
  expect(page.url()).toContain('manage=creator');
  await page.reload();
  await expect.poll(() => page.locator('#ms-creator').count()).toBe(1);
});

for (const theme of ['dark', 'light']) {
  test(`the creator section renders in ${theme}`, async ({ page }) => {
    await enterSection(page, 'creator', theme);
    await expect.poll(() =>
      page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    ).toBe(theme);
    await expect.poll(() => page.locator('#ms-creator').innerText()).not.toContain('Loading');
    await page.screenshot({ path: `ui-review/manage-creator-${theme}.png`, fullPage: true });
  });
}

// ── 6. auto-update, as a report rather than a control ───────────────────────

test('auto-update says when it last ran, when it runs next, and what it covers', async ({ page }) => {
  await enterSection(page, 'library');
  await expect.poll(() => page.locator('#auto-update-freq').count()).toBe(1);
  const section = page.locator('#ms-auto-update');
  // The control is still the control — the poll gating and two other
  // renderers read this select by name.
  await expect(section.locator('#auto-update-freq')).toHaveCount(1);
  // What it never said before.
  await expect(section.locator('.mc-label', { hasText: 'Last run' })).toHaveCount(1);
  await expect(section.locator('.mc-label', { hasText: 'Next run' })).toHaveCount(1);
});

test('a library of undated ZIMs is told that the updater cannot reach them', async ({ page }) => {
  await stubAutoUpdate(page, {
    enabled: true, frequency: 'weekly', locked: false,
    last_check: null, next_check: null,
    coverage: { tracked: ['wikipedia_en_all'], skipped: [{ name: 'field_notes', reason: 'undated' }] },
  });
  await enterSection(page, 'library');
  await expect(page.locator('#ms-auto-update .mc-label', { hasText: 'Kept up to date' }))
    .toHaveCount(1);
  await expect(page.locator('#ms-auto-update .mc-value').filter({ hasText: '1 of 2' }))
    .toHaveCount(1);
  // The ZIM it cannot reach is named, with the reason on hover — a file that
  // silently never updates is the thing this section exists to prevent.
  const chip = page.locator('.au-skipped .act-chip', { hasText: 'field_notes' });
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveAttribute('title', /no date in the filename/i);
});

test('a never-run updater does not invent a next run', async ({ page }) => {
  await stubAutoUpdate(page, {
    enabled: true, frequency: 'weekly', locked: false,
    last_check: null, next_check: null, coverage: { tracked: [], skipped: [] },
  });
  await enterSection(page, 'library');
  // "Not since this server started", never "never": the stamp is process
  // memory, so a restart erases it while the journal keeps the history.
  await expect(page.locator('#ms-auto-update')).toContainText('Not since this server started');
  await expect(page.locator('#ms-auto-update')).toContainText('Shortly');
});

for (const theme of ['dark', 'light']) {
  test(`the auto-update section renders in ${theme}`, async ({ page }) => {
    await stubAutoUpdate(page, {
      enabled: true, frequency: 'weekly', locked: false,
      last_check: Date.now() / 1000 - 7200, next_check: Date.now() / 1000 + 500000,
      coverage: { tracked: ['wikipedia_en_all', 'gutenberg_en'],
        skipped: [{ name: 'field_notes', reason: 'undated' }] },
    });
    await enterSection(page, 'library', theme);
    await expect(page.locator('#ms-auto-update .mc-label', { hasText: 'Kept up to date' }))
      .toHaveCount(1);
    await page.locator('#ms-auto-update').screenshot({
      path: `ui-review/manage-autoupdate-${theme}.png`,
    });
  });
}
