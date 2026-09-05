// About this ZIM — the context item, the panel, the timeline, and the badges.
//
// Eric's ask, verbatim: "why put (alive) in the ZIM title that's weird maybe it
// can be a type badge or available in zimi created metadata (about this zim on
// right-click for all zims?)".
//
// So the test plan is that sentence. A title never decides anything: the badge
// comes from metadata, every card has the right-click item, and a ZIM Zimi did
// not make shows its publisher's own fields and admits it has no history rather
// than borrowing one.
//
// Build the fixtures and start a server first:
//   python3 tests/make_about_fixtures.py /tmp/zimi-about/zims
//   ZIM_DIR=/tmp/zimi-about/zims ZIMI_DATA_DIR=/tmp/zimi-about/data \
//     python3 -m zimi serve --port 8933
// Run:
//   BASE_URL=http://localhost:8933 npx playwright test \
//     --config=tests/playwright.config.mjs tests/test_zim_about.spec.mjs

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:8933';

// The fixture library, and what each ZIM is here to prove.
const MADE = ['handbook', 'newsroom_alive', 'notes'];
const FOREIGN = 'found';

async function home(page, theme) {
  await page.goto(BASE);
  await page.evaluate((t) => {
    localStorage.clear();
    sessionStorage.clear();
    if (t) localStorage.setItem('zimi_app_theme', t);
  }, theme || '');
  await page.goto(BASE);
  await expect(page.locator('.stat-card').first()).toBeVisible();
  // Badges arrive after the first paint, on purpose — wait for the fetch that
  // brings them rather than for a fixed delay.
  await expect.poll(() => page.evaluate(() => _zimKinds !== null)).toBe(true);
}

function card(page, name) {
  return page.locator(`.stat-card[data-zim="${name}"]`);
}

async function openAbout(page, name) {
  await card(page, name).click({ button: 'right' });
  await expect(page.locator('.ctx-item[data-action="about"]')).toBeVisible();
  await page.locator('.ctx-item[data-action="about"]').click();
  await expect(page.locator('.zi-panel')).toBeVisible();
  // The loading line is replaced once the fetch lands. There are two .zi-rows
  // blocks on a fully-populated panel — the named fields and, at the bottom,
  // whatever fields this build has no row for — so the wait names the first.
  await expect(page.locator('.zi-rows').first()).toBeVisible();
}

test.describe('the fixture library is the one the assertions assume', () => {
  test('all four ZIMs are installed', async ({ page }) => {
    await home(page);
    for (const name of [...MADE, FOREIGN]) {
      await expect(card(page, name)).toHaveCount(1);
    }
  });
});

test.describe('type badges come from metadata', () => {
  test('each Zimi-made ZIM wears the badge its metadata earns', async ({ page }) => {
    await home(page);
    await expect(card(page, 'handbook').locator('.prov-badge')).toHaveText('Site');
    await expect(card(page, 'notes').locator('.prov-badge')).toHaveText('Folder');
    // The whole point of the change: the ZIM whose TAG says alive is the one
    // labelled Alive. Its title says "(replay)" and that changes nothing.
    await expect(card(page, 'newsroom_alive').locator('.prov-badge')).toHaveText('Alive');
    await expect(card(page, 'newsroom_alive').locator('.prov-badge')).toHaveClass(/prov-alive/);
  });

  test('a ZIM Zimi did not make stays clean', async ({ page }) => {
    await home(page);
    await expect(card(page, FOREIGN).locator('.prov-badge')).toHaveCount(0);
  });

  test('the badge tooltip is a one-line provenance summary', async ({ page }) => {
    await home(page);
    const tip = await card(page, 'handbook').locator('.prov-badge').getAttribute('title');
    expect(tip).toContain('Made with Zimi');
    expect(tip).toContain('edited 2 times since');
  });

  test('badges survive a re-render', async ({ page }) => {
    await home(page);
    await page.evaluate(() => _setLibraryView('tiles'));
    await expect(card(page, 'handbook').locator('.prov-badge')).toHaveText('Site');
    await page.evaluate(() => _setLibraryView('list'));
    await expect(card(page, 'handbook').locator('.prov-badge')).toHaveText('Site');
  });
});

test.describe('the context item is on every card', () => {
  for (const name of [...MADE, FOREIGN]) {
    test(`right-clicking ${name} offers About this ZIM`, async ({ page }) => {
      await home(page);
      await card(page, name).click({ button: 'right' });
      await expect(page.locator('.ctx-item[data-action="about"]')).toHaveText('About this ZIM');
    });
  }
});

test.describe('the panel', () => {
  test('shows the ZIM its own metadata', async ({ page }) => {
    await home(page);
    await openAbout(page, 'handbook');
    const panel = page.locator('.zi-panel');
    await expect(panel.locator('.zi-title')).toContainText('Field Handbook');
    const rows = await panel.locator('.zi-rows').first().innerText();
    expect(rows).toContain('handbook.zim');
    expect(rows).toContain('English');
    expect(rows).toContain('2026-08-05');
    expect(rows).toContain('Zimi 1.9.0');
    // A URL Source is a real link out.
    await expect(panel.locator('.zi-v a')).toHaveAttribute('href', 'https://handbook.example.org/');
    await expect(panel.locator('.zi-tag').first()).toBeVisible();
    // A field with no row of its own is still reported, under the file's own
    // spelling of its key.
    const other = await panel.locator('.zi-rows').last().innerText();
    expect(other).toContain('zimi_eng_handbook_example_org');
  });

  test('renders the provenance timeline from the records', async ({ page }) => {
    await home(page);
    await openAbout(page, 'handbook');
    const events = page.locator('.zi-timeline .zi-ev');
    await expect(events).toHaveCount(3);
    await expect(events.nth(0)).toContainText('Earlier records collapsed');
    await expect(events.nth(1)).toContainText('Created');
    await expect(events.nth(1)).toContainText('148 pages');
    // Exactly the line Eric's blocked-ads work is supposed to surface.
    await expect(events.nth(1)).toContainText('214 ad/tracker requests blocked (stevenblack-hosts)');
    await expect(events.nth(2)).toContainText('Edited');
    await expect(events.nth(2)).toContainText('chromium 138.0.7204.94');
  });

  test('a ZIM without Zimi history shows its publisher and says so', async ({ page }) => {
    await home(page);
    await openAbout(page, FOREIGN);
    const panel = page.locator('.zi-panel');
    const rows = await panel.locator('.zi-rows').first().innerText();
    expect(rows).toContain('DevDocs');
    expect(rows).toContain('openZIM');
    expect(rows).toContain('devdocs2zim v0.2.1');
    await expect(panel.locator('.zi-timeline')).toHaveCount(0);
    await expect(panel.locator('.zi-none')).toContainText('no Zimi history');
    // No badge in the panel either — the absence has to be consistent.
    await expect(panel.locator('.prov-badge')).toHaveCount(0);
  });

  test('a replay ZIM shows the tag-derived badge in the panel too', async ({ page }) => {
    await home(page);
    await openAbout(page, 'newsroom_alive');
    await expect(page.locator('.zi-panel .prov-badge')).toHaveText('Alive');
    // warc2zim writes the file, so there is no history — and the panel says
    // that plainly instead of inventing records for it.
    await expect(page.locator('.zi-panel .zi-none')).toContainText('no Zimi history');
  });

  test('closes on Escape, on the backdrop, and on the button', async ({ page }) => {
    await home(page);
    await openAbout(page, 'notes');
    await page.keyboard.press('Escape');
    await expect(page.locator('.zi-panel')).toHaveCount(0);

    await openAbout(page, 'notes');
    await page.locator('.zi-close').click();
    await expect(page.locator('.zi-panel')).toHaveCount(0);

    await openAbout(page, 'notes');
    await page.locator('.zi-overlay').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.zi-panel')).toHaveCount(0);
  });

  test('renders in both themes', async ({ page }) => {
    for (const theme of ['dark', 'light']) {
      await home(page, theme);
      await openAbout(page, 'handbook');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const panel = page.locator('.zi-panel');
      await expect(panel).toBeVisible();
      // The panel paints its own surface in either theme — a transparent one
      // would leave the timeline sitting on the page behind it.
      const bg = await panel.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).not.toBe('rgba(0, 0, 0, 0)');
      await page.screenshot({ path: `test-results/zim-about-${theme}.png` });
      await page.keyboard.press('Escape');
    }
  });

  test('fits a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await home(page);
    await openAbout(page, 'handbook');
    const panel = page.locator('.zi-panel');
    const box = await panel.boundingBox();
    expect(box.width).toBeLessThanOrEqual(390);
    // The close button has to stay reachable however long the metadata is.
    await expect(page.locator('.zi-close')).toBeInViewport();
    await page.screenshot({ path: 'test-results/zim-about-mobile.png' });
  });
});
