// Folder mode on the Create page, end to end: the tree under the create root,
// tri-state ticking, the preview's totals and sidecar facts, a real build of a
// mixed folder, and the one ZIM opened in the reader, the Bookshelf and
// ZimiTube. Desktop and a 390px phone.
//
// Eric (2026-09-30): "offer folder ... show the whole tree and allow selecting
// any subset ... large variety of compatible formats ... metadata as a text
// file beside."
//
// Needs a server whose create root holds the fixture folder:
//   python3 tests/make_folder_fixture.py <dir>      (prints root, zims)
//   ZIM_DIR=<dir>/zims ZIMI_CREATE_ROOT=<dir>/root ZIMI_TORRENT=0 ZIMI_OFFLINE=1 \
//     ZIMI_MANAGE=1 python3 -m zimi serve --port 8937
//   BASE_URL=http://localhost:8937 SHOTS=<dir>/shots npx playwright test \
//     --config=tests/playwright.config.mjs tests/test_create_folder.spec.mjs

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:8937';
const SHOTS = process.env.SHOTS || '';
const ATTIC = 'Family Attic';

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false });
}

async function openFolderMode(page, lang) {
  await page.goto(BASE);
  await page.waitForFunction(() => typeof window.openCreate === 'function');
  if (lang) await page.evaluate((l) => window.setLanguage(l), lang);
  await page.evaluate(() => window.openCreate());
  const chip = page.locator('.create-chip[onclick*="\'folder\'"]');
  await expect(chip).toHaveCount(1);
  await chip.click();
  const tree = page.locator('#create-folder-tree');
  await expect(tree).toBeVisible();
  await expect(tree.locator(`.create-ftree-row[data-path="${ATTIC}"]`)).toBeVisible();
  return tree;
}

const row = (tree, p) => tree.locator(`.create-ftree-row[data-path="${p}"]`);

async function pickTheAttic(page, tree) {
  await row(tree, ATTIC).locator('[data-act="open"]').click();
  await expect(row(tree, ATTIC + '/photos')).toBeVisible();
  await row(tree, ATTIC).locator('input.create-ftree-check').click();
  await expect(row(tree, ATTIC)).toHaveAttribute('aria-checked', 'true');
  // The preview counts the selection and reads its zimi.txt.
  const preview = page.locator('#create-preview');
  await expect(preview).toContainText('The Family Attic');
  await expect(preview).toContainText('Documents (Bookshelf)');
  await expect(preview).toContainText('Videos (ZimiTube)');
  await expect(preview).toContainText('Lee Press');
  await expect(preview).toContainText('budget.xlsx');
  return preview;
}

for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  test.describe(`folder mode (${label})`, () => {
    test.use({ viewport, serviceWorkers: 'block' });

    test('the tree picks a folder, a subset, and says what each becomes', async ({ page }) => {
      const tree = await openFolderMode(page);
      // Nothing outside the root, nothing hidden: two folders at the top.
      const top = await tree.locator('.create-ftree-row[aria-level="2"]').evaluateAll(
        rows => rows.map(r => r.getAttribute('data-path')));
      expect(top).toEqual([ATTIC, 'Other things']);
      await pickTheAttic(page, tree);
      // Each file says what it becomes; left-out and sidecar rows cannot be ticked.
      await expect(row(tree, ATTIC + '/budget.xlsx')).toHaveClass(/is-off/);
      await expect(row(tree, ATTIC + '/zimi.txt')).toContainText('describes this folder');
      await expect(row(tree, ATTIC + '/notes.md')).toContainText('page');
      await shot(page, `folder-${label}-picked`);

      // Unticking one picture inside the ticked folder: the folder is partly ticked.
      await row(tree, ATTIC + '/photos').locator('[data-act="open"]').click();
      await expect(row(tree, ATTIC + '/photos/photo-2.png')).toBeVisible();
      await row(tree, ATTIC + '/photos/photo-2.png').locator('input').click();
      await expect(row(tree, ATTIC)).toHaveAttribute('aria-checked', 'mixed');
      await expect(row(tree, ATTIC + '/photos')).toHaveAttribute('aria-checked', 'mixed');
      expect(await row(tree, ATTIC).locator('input').evaluate(b => b.indeterminate)).toBe(true);
      await expect(page.locator('#create-preview')).toContainText('Pictures (gallery)');
      await shot(page, `folder-${label}-subset`);
      // And ticking it back is the whole folder again.
      await row(tree, ATTIC + '/photos/photo-2.png').locator('input').click();
      await expect(row(tree, ATTIC)).toHaveAttribute('aria-checked', 'true');

      // Keyboard: the tree is one tab stop; arrows move, space ticks.
      await row(tree, ATTIC).focus();
      await page.keyboard.press('ArrowDown');
      const focused = await page.evaluate(() => document.activeElement.getAttribute('data-path'));
      expect(focused).toBe(ATTIC + '/books');
      await page.keyboard.press(' ');
      await expect(row(tree, ATTIC)).toHaveAttribute('aria-checked', 'mixed');
      await page.keyboard.press(' ');
      await expect(row(tree, ATTIC)).toHaveAttribute('aria-checked', 'true');

      // No horizontal scroll on a phone.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });

    test('the tree reads right to left in Hebrew', async ({ page }) => {
      const tree = await openFolderMode(page, 'he');
      await row(tree, ATTIC).locator('[data-act="open"]').click();
      await expect(row(tree, ATTIC + '/photos')).toBeVisible();
      expect(await tree.evaluate(el => getComputedStyle(el).direction)).toBe('rtl');
      // Indented from the right: a child's checkbox sits left of its parent's.
      const parentBox = await row(tree, ATTIC).locator('input').boundingBox();
      const childBox = await row(tree, ATTIC + '/photos').locator('input').boundingBox();
      expect(childBox.x).toBeLessThan(parentBox.x);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await shot(page, `folder-${label}-rtl`);
    });
  });
}

test.describe('folder mode builds one ZIM every app reads', () => {
  test.use({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  test.setTimeout(120000);

  test('build, then the reader, the Bookshelf and ZimiTube', async ({ page }) => {
    const tree = await openFolderMode(page);
    await pickTheAttic(page, tree);
    await page.locator('#create-start').click();
    const done = await expect.poll(async () => page.evaluate(async () => {
      const r = await fetch('/manage/create/status');
      const b = await r.json();
      return b.done ? (b.ok ? 'ok' : 'failed: ' + (b.error || '')) : '';
    }), { timeout: 90000 }).toBe('ok');
    void done;
    const result = await page.evaluate(async () => (await (await fetch('/manage/create/status')).json()).result);
    expect(result.title).toBe('The Family Attic');
    await page.waitForTimeout(1500);
    await shot(page, 'folder-build-done');

    // The reader: the generated index, a text page, the gallery.
    const name = result.name;
    const reader = page.frameLocator('#reader-frame');
    await page.goto(`${BASE}/w/${encodeURIComponent(name)}/`);
    await expect(reader.locator('body')).toContainText('Pictures');
    await expect(reader.locator('body')).toContainText('letter-1962');
    await shot(page, 'folder-reader-index');
    await page.goto(`${BASE}/w/${encodeURIComponent(name)}/gallery`);
    await expect(reader.locator('figcaption').first()).toBeVisible();
    await expect(reader.locator('body')).toContainText('At the beach, 1961');
    expect(await reader.locator('img[src*="covers/"]').count()).toBe(0);
    await shot(page, 'folder-reader-gallery');
    await page.goto(`${BASE}/w/${encodeURIComponent(name)}/letter-1962.txt`);
    await expect(reader.locator('pre')).toContainText('The attic is full of boxes.');
    await shot(page, 'folder-reader-text');

    // The Bookshelf: the PDF, named and covered by its sidecar.
    await page.goto(BASE);
    await page.waitForFunction(() => typeof window.openBooks === 'function');
    await page.evaluate(() => window.openBooks());
    const books = page.frameLocator('iframe').first();
    await expect(books.locator('body')).toContainText('The Attic Book', { timeout: 30000 });
    await expect(books.locator('body')).toContainText('Ann Lee');
    // Its cover is the picture the sidecar named, not a typeset one.
    await expect(books.locator('img[src*="attic-book.png"]').first()).toBeVisible();
    await shot(page, 'folder-bookshelf');

    // ZimiTube: the film, named by its sidecar, and the song.
    await page.goto(BASE);
    await page.waitForFunction(() => typeof window.openTube === 'function');
    await page.evaluate(() => window.openTube());
    const tube = page.frameLocator('iframe').first();
    await expect(tube.locator('body')).toContainText('Home movie, 1962', { timeout: 30000 });
    await shot(page, 'folder-zimitube');
  });
});
