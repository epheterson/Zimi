// The Activity view: one list for everything that has happened to the library,
// each row saying WHO did it, with a filter over type and actor.
//
// Eric's ask, verbatim: "activity in manage should show all types of activity
// and segment by user or server even for similar items like user can update a
// zim or serve auto update... Some elegant simple view with like a filter
// button for types of activity and by whom."
//
// So the test plan is that sentence: every type renders, the same type from two
// different actors is two distinguishable rows, and the filter narrows by both.
//
// There is no API for writing a journal — every record is stamped by the
// operation it describes — so the fixture below is written straight into the
// server's data dir before the first test navigates. The server reads the file
// lazily, on the first /manage/activity-log request, which is what makes that
// legal.
//
//   mkdir -p /tmp/zimi-activity/zims /tmp/zimi-activity/data
//   cp zims/devdocs_en_lit_2026-07.zim /tmp/zimi-activity/zims/
//   ZIM_DIR=/tmp/zimi-activity/zims ZIMI_DATA_DIR=/tmp/zimi-activity/data \
//     ZIMI_MANAGE=1 python3 -m zimi serve --port 8931
//   BASE_URL=http://localhost:8931 ZIMI_DATA_DIR=/tmp/zimi-activity/data \
//     npx playwright test --config=tests/playwright.config.mjs \
//     tests/test_activity_view.spec.mjs

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:8931';
const DATA_DIR = process.env.ZIMI_DATA_DIR || '';

// One record of every type, both outcomes that matter, and the case the whole
// feature exists for: Stack Overflow updated by the auto-updater next to Lit
// updated by a person. Oldest first, the way the journal is stored.
const HOUR = 3600;
function seedRecords() {
  const now = Date.now() / 1000;
  const at = (hoursAgo, rest) => ({ ts: Math.round((now - hoursAgo * HOUR) * 1000) / 1000, ...rest });
  const user = (name) => ({ kind: 'user', name });
  const server = { kind: 'server', name: null };
  const unknown = { kind: 'unknown', name: null };
  return [
    at(50, { type: 'download', subject: 'Wikipedia (English, all)', outcome: 'ok', detail: '', actor: unknown, bytes: 102 * 1024 ** 3 }),
    at(49, { type: 'delete', subject: 'DevDocs React', outcome: 'ok', detail: '', actor: unknown, bytes: 5 * 1024 ** 2 }),
    at(30, { type: 'update', subject: 'Stack Overflow', outcome: 'ok', detail: '', actor: server, bytes: 78 * 1024 ** 3 }),
    at(28, { type: 'health', subject: '', outcome: 'ok', detail: '51/53', actor: user('admin') }),
    at(26, { type: 'create', subject: 'Field Notes', outcome: 'failed', detail: 'the host never answered', actor: user('priya') }),
    at(7, { type: 'create', subject: 'Field Notes', outcome: 'ok', detail: 'https://fieldnotes.example.com', actor: user('priya'), bytes: 41 * 1024 ** 2 }),
    at(5, { type: 'import', subject: 'Project Gutenberg', outcome: 'ok', detail: '', actor: user('admin'), bytes: 64 * 1024 ** 3 }),
    at(4, { type: 'export', subject: 'my_bookmarks', outcome: 'ok', detail: '', actor: user('eric'), count: 42 }),
    at(3, { type: 'update', subject: 'Lit', outcome: 'ok', detail: '', actor: user('eric'), bytes: 739061 }),
    at(2, { type: 'download', subject: 'Wiktionary (English)', outcome: 'cancelled', detail: '', actor: user('eric') }),
    at(1, { type: 'restore', subject: '', outcome: 'ok', detail: '', actor: user('admin'), count: 5 }),
    at(0.4, { type: 'update', subject: 'Wikiversity', outcome: 'failed', detail: 'all 3 mirror(s) failed', actor: server }),
    at(0.2, { type: 'delete', subject: 'Old Wikivoyage', outcome: 'ok', detail: '', actor: user('eric'), bytes: 3 * 1024 ** 3 }),
  ];
}

test.beforeAll(() => {
  if (!DATA_DIR) return;  // already-seeded server (CI runs it that way)
  fs.writeFileSync(path.join(DATA_DIR, 'activity.json'), JSON.stringify(seedRecords()));
});

async function enterActivity(page, theme) {
  await page.goto(BASE);
  await page.evaluate((t) => {
    localStorage.clear();
    sessionStorage.clear();
    if (t) localStorage.setItem('zimi_app_theme', t);
  }, theme);
  await page.goto(BASE);
  await page.waitForFunction(() => typeof enterManage === 'function');
  await page.evaluate(() => { manageEnabled = true; enterManage(); });
  await expect.poll(() => page.evaluate(() => mode)).toBe('manage');
  await page.evaluate(() => switchManageTab('history'));
  await expect.poll(() => page.locator('.act-row').count()).toBeGreaterThan(0);
}

function rowText(page, index) {
  return page.locator('.act-row').nth(index).innerText();
}

test('every kind of activity lands in one list', async ({ page }) => {
  await enterActivity(page);
  const list = page.locator('#manage-history');
  // The seeded journal covers all eight types.
  for (const verb of ['Downloaded', 'Updated', 'Created', 'Exported', 'Deleted',
                      'Imported', 'Restored', 'Checked']) {
    await expect(list).toContainText(verb);
  }
  // Newest first, grouped by day.
  await expect(page.locator('.act-day').first()).toBeVisible();
  await expect(await rowText(page, 0)).toContain('Old Wikivoyage');
});

test('the same event from two actors reads as two different things', async ({ page }) => {
  await enterActivity(page);
  // An auto-update and a person's update: same transfer, different rows.
  const auto = page.locator('.act-row', { hasText: 'Stack Overflow' });
  await expect(auto.locator('.act-chip')).toHaveText('Server');
  await expect(auto.locator('.act-chip')).toHaveClass(/act-chip-server/);
  const byHand = page.locator('.act-row', { hasText: 'Lit' }).first();
  await expect(byHand.locator('.act-chip')).toHaveText('eric');
  await expect(byHand.locator('.act-chip')).toHaveClass(/act-chip-user/);
});

test('failures and cancellations say so, successes stay quiet', async ({ page }) => {
  await enterActivity(page);
  const failed = page.locator('.act-row', { hasText: 'Wikiversity' });
  await expect(failed.locator('.act-verb.bad')).toContainText('Failed');
  await expect(failed).toContainText('all 3 mirror(s) failed');
  await expect(page.locator('.act-row', { hasText: 'Wiktionary' })
    .locator('.act-verb.bad')).toContainText('Cancelled');
  // The whole library and the server's own state are named, never left blank.
  await expect(page.locator('.act-row', { hasText: 'Whole library' })).toHaveCount(1);
  await expect(page.locator('.act-row', { hasText: 'Server backup' })).toHaveCount(1);
});

test('the filter narrows by type and by whom, and comes back', async ({ page }) => {
  await enterActivity(page);
  const rows = page.locator('.act-row');
  const total = await rows.count();

  // Both axes are on screen from the start — no box to open. Each row leads
  // with All, so the pill count is the vocabulary plus one.
  await expect(page.locator('.act-filter-row')).toHaveCount(2);
  const typeRow = page.locator('.act-filter-row').first();
  const actorRow = page.locator('.act-filter-row').last();
  const types = typeRow.locator('.act-pill');
  const actors = actorRow.locator('.act-pill');
  await expect(page.locator('.act-pill', { hasText: 'Server' })).toHaveCount(1);
  // Nothing filtered: every pill is lit, All included — "all" is a true
  // description of what is showing, not a fifth choice sitting unlit beside it.
  await expect(typeRow.locator('.act-pill.active')).toHaveCount(await types.count());

  // Expected counts come from the journal the page is holding, not from a
  // number written here — the seed can grow without the test going stale.
  const updates = await page.evaluate(() =>
    _act.records.filter(r => r.type === 'update').length);
  const priyaLeft = await page.evaluate(() =>
    _act.records.filter(r => r.type !== 'update' && r.actor.name === 'priya').length);

  // Every pill states its own count, over the whole journal.
  await expect(page.locator('.act-pill', { hasText: 'Update' }).locator('.pill-count'))
    .toHaveText(String(updates));

  // Turn one type off: fewer rows, and that pill alone goes dark.
  const update = page.locator('.act-pill', { hasText: 'Update' });
  await update.click();
  await expect(rows).toHaveCount(total - updates);
  await expect(update).not.toHaveClass(/active/);
  await expect(update).toHaveAttribute('aria-pressed', 'false');
  // All stops being true the moment it stops being true.
  await expect(types.first()).not.toHaveClass(/active/);

  // Turn off an actor too — the axes compose, and each row's All is its own.
  await page.locator('.act-pill', { hasText: 'priya' }).click();
  await expect(rows).toHaveCount(total - updates - priyaLeft);
  await expect(actors.first()).not.toHaveClass(/active/);

  // The vocabulary does not shrink with the results: a filter whose options
  // vanish as you use it is one you cannot get back out of.
  await expect(page.locator('.act-pill', { hasText: 'Update' })).toHaveCount(1);
  await expect(page.locator('.act-pill', { hasText: 'Update' }).locator('.pill-count'))
    .toHaveText(String(updates));

  // All on one row restores that row only — the other axis stays as it was.
  await types.first().click();
  await expect(rows).toHaveCount(total - priyaLeft);
  await expect(update).toHaveClass(/active/);
  await expect(actors.first()).not.toHaveClass(/active/);
  await actors.first().click();
  await expect(rows).toHaveCount(total);
});

test('an unrecorded actor says nothing rather than accusing anyone', async ({ page }) => {
  await enterActivity(page);
  // Pre-1.9 records have no actor. The chip is an em-dash with the reason on
  // hover, not the word "Unknown", which read as though somebody had done it
  // and Zimi were refusing to say who.
  const chip = page.locator('.act-chip-unknown').first();
  await expect(chip).toHaveText('\u2014');
  await expect(chip).toHaveAttribute('title', /before Zimi tracked/i);
  // "admin" is the password holder, not a person with an account by that name.
  await expect(page.locator('.act-chip', { hasText: /^admin$/ }).first())
    .toHaveAttribute('title', /admin password/i);
});

for (const theme of ['dark', 'light']) {
  test(`the list and its filter render in ${theme}`, async ({ page }) => {
    await enterActivity(page, theme);
    await expect.poll(() =>
      page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    ).toBe(theme);
    await page.screenshot({ path: `ui-review/activity-${theme}.png`, fullPage: true });
    // Filtered, so the lit/unlit contrast is what the screenshot shows.
    await page.locator('.act-pill', { hasText: 'Update' }).click();
    await page.screenshot({ path: `ui-review/activity-filter-${theme}.png` });
  });
}

test('the list survives a narrow phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enterActivity(page);
  // Two pill rows must scroll within themselves rather than push the page
  // sideways — the reason each row is its own overflow container.
  await expect(page.locator('.act-filter-row')).toHaveCount(2);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'ui-review/activity-mobile.png', fullPage: true });
});
