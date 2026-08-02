// Bookmarks v2 — folder tree: render, collapse, inline create, context-menu
// actions (rename / move / delete) and pointer drag-and-drop move.
//
// Start a server first (no ZIMs needed — rows render from localStorage):
//   ZIM_DIR=/tmp/zimi-empty python3 -m zimi serve --port 8873
// Run:
//   BASE_URL=http://localhost:8873 npx playwright test \
//     --config=tests/playwright.config.mjs tests/test_bookmarks_folders.spec.mjs

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:8873';

// Seed two folders and three bookmarks, then open the bookmarks tab.
async function seedAndOpen(page, folders, bookmarks) {
  await page.goto(BASE);
  await page.evaluate(({ folders, bookmarks }) => {
    localStorage.setItem('zimi_bm_folders', JSON.stringify(folders));
    localStorage.setItem('zimi_bookmarks', JSON.stringify(bookmarks));
    localStorage.removeItem('zimi_bm_collapsed');
    // drop the in-memory caches so a fresh read picks up the seed
    if (typeof window._bmFolders !== 'undefined') window._bmFolders = null;
  }, { folders, bookmarks });
  // Reload so module-level caches re-read the seeded storage.
  await page.reload();
  await page.evaluate(() => toggleLibraryPanel('bookmarks'));
  await page.waitForSelector('#bm-tree');
}

const FOLDERS = [
  { id: 'med', name: 'Medical', parent: '', order: 0 },
  { id: 'card', name: 'Cardiology', parent: 'med', order: 0 },
  { id: 'res', name: 'Research', parent: '', order: 1 },
];
const BOOKMARKS = [
  { zim: 'wikipedia', path: 'A/Heart', title: 'Heart', folder: 'card', order: 0 },
  { zim: 'wikipedia', path: 'A/Aspirin', title: 'Aspirin', folder: 'med', order: 0 },
  { zim: 'wikipedia', path: 'A/Loose', title: 'Loose note', folder: '', order: 0 },
];

test.describe('Bookmarks folder tree', () => {
  test('renders folders, nesting and recursive counts', async ({ page }) => {
    await seedAndOpen(page, FOLDERS, BOOKMARKS);
    // Three folder rows + three bookmark rows.
    await expect(page.locator('.bm-folder')).toHaveCount(3);
    await expect(page.locator('.bm-bk')).toHaveCount(3);
    // Medical's badge counts itself (Aspirin) + its subtree (Heart) = 2.
    const medCount = await page.locator('.bm-folder[data-fid="med"] .bm-count').textContent();
    expect(medCount.trim()).toBe('2');
    // Cardiology is nested one level deeper than Medical.
    const medDepth = await page.locator('.bm-folder[data-fid="med"]').getAttribute('data-depth');
    const cardDepth = await page.locator('.bm-folder[data-fid="card"]').getAttribute('data-depth');
    expect(Number(cardDepth)).toBe(Number(medDepth) + 1);
  });

  test('collapse hides descendants', async ({ page }) => {
    await seedAndOpen(page, FOLDERS, BOOKMARKS);
    await expect(page.locator('.bm-folder[data-fid="card"]')).toBeVisible();
    await page.locator('.bm-folder[data-fid="med"]').click();
    // Collapsing Medical removes Cardiology and Heart from the tree.
    await expect(page.locator('.bm-folder[data-fid="card"]')).toHaveCount(0);
    await expect(page.locator('.bm-bk[data-path="A/Heart"]')).toHaveCount(0);
  });

  test('inline new-folder creation', async ({ page }) => {
    await seedAndOpen(page, FOLDERS, BOOKMARKS);
    await page.getByRole('button', { name: 'New folder' }).click();
    await page.locator('.bm-newfolder-input').fill('Travel');
    await page.locator('.bm-newfolder-input').press('Enter');
    await expect(page.locator('.bm-folder', { hasText: 'Travel' })).toHaveCount(1);
    // Persisted to storage.
    const names = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('zimi_bm_folders')).map((f) => f.name));
    expect(names).toContain('Travel');
  });

  test('context-menu rename', async ({ page }) => {
    await seedAndOpen(page, FOLDERS, BOOKMARKS);
    await page.locator('.bm-folder[data-fid="res"]').click({ button: 'right' });
    await page.locator('.ctx-item', { hasText: 'Rename' }).click();
    const input = page.locator('.bm-rename-input');
    await input.fill('Studies');
    await input.press('Enter');
    await expect(page.locator('.bm-folder[data-fid="res"] .bm-name')).toHaveText('Studies');
  });

  test('context-menu move bookmark into folder', async ({ page }) => {
    await seedAndOpen(page, FOLDERS, BOOKMARKS);
    // Loose note is at root; move it into Research.
    await page.locator('.bm-bk[data-path="A/Loose"]').click({ button: 'right' });
    await page.locator('.ctx-item', { hasText: 'Move to' }).hover();
    await page.locator('.ctx-sub .ctx-item', { hasText: 'Research' }).click();
    const fid = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('zimi_bookmarks')).find((b) => b.path === 'A/Loose').folder);
    expect(fid).toBe('res');
  });

  test('delete non-empty folder keeps bookmarks (promote)', async ({ page }) => {
    await seedAndOpen(page, FOLDERS, BOOKMARKS);
    await page.locator('.bm-folder[data-fid="med"]').click({ button: 'right' });
    await page.locator('.ctx-item', { hasText: 'Delete' }).click();
    // Non-empty → the choice menu appears; keep the bookmarks.
    await page.locator('.ctx-item', { hasText: 'keep bookmarks' }).click();
    await expect(page.locator('.bm-folder[data-fid="med"]')).toHaveCount(0);
    // Cardiology (its child) and the bookmarks survive, lifted to root.
    const state = await page.evaluate(() => ({
      folders: JSON.parse(localStorage.getItem('zimi_bm_folders')),
      bookmarks: JSON.parse(localStorage.getItem('zimi_bookmarks')),
    }));
    expect(state.folders.find((f) => f.id === 'med')).toBeUndefined();
    expect(state.folders.find((f) => f.id === 'card').parent).toBe('');
    expect(state.bookmarks.length).toBe(3); // nothing deleted
    // The promoted bookmark must be written back pointing at the surviving
    // parent — keeping the dead folder id strands it in no folder at all.
    expect(state.bookmarks.find((b) => b.path === 'A/Aspirin').folder).toBe('');
  });

  test('promoted bookmarks are still in the tree after a reload', async ({ page }) => {
    await seedAndOpen(page, FOLDERS, BOOKMARKS);
    await page.locator('.bm-folder[data-fid="med"]').click({ button: 'right' });
    await page.locator('.ctx-item', { hasText: 'Delete' }).click();
    await page.locator('.ctx-item', { hasText: 'keep bookmarks' }).click();
    await expect(page.locator('.bm-bk')).toHaveCount(3);
    await page.reload();
    await page.evaluate(() => toggleLibraryPanel('bookmarks'));
    await page.waitForSelector('#bm-tree');
    await expect(page.locator('.bm-bk')).toHaveCount(3);
  });

  test('a bookmark pointing at a deleted folder shows at the top level', async ({ page }) => {
    // Data written by another device (or an older build) can reference a folder
    // that no longer exists; it must not vanish from every folder at once.
    await seedAndOpen(page, FOLDERS, [
      { zim: 'wikipedia', path: 'A/Ghost', title: 'Ghost', folder: 'gone', order: 0 },
    ]);
    await expect(page.locator('.bm-bk[data-path="A/Ghost"]')).toHaveCount(1);
    const fid = await page.locator('.bm-bk[data-path="A/Ghost"]').getAttribute('data-fid');
    expect(fid).toBe('');
  });

  test('a bookmark row is indented past the folder holding it', async ({ page }) => {
    await seedAndOpen(page, FOLDERS, BOOKMARKS);
    const folderIcon = await page.locator('.bm-folder[data-fid="card"] .bm-ficon').boundingBox();
    const bookmarkIcon = await page.locator('.bm-bk[data-path="A/Heart"] .bm-bicon').boundingBox();
    expect(bookmarkIcon.x).toBeGreaterThan(folderIcon.x);
  });

  test('drag a folder onto a bookmark row moves it into that bookmark\'s folder', async ({ page }) => {
    await seedAndOpen(page, FOLDERS, BOOKMARKS);
    const src = page.locator('.bm-folder[data-fid="res"]');
    const dst = page.locator('.bm-bk[data-path="A/Aspirin"]');  // lives in Medical
    const s = await src.boundingBox();
    const d = await dst.boundingBox();
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
    await page.mouse.down();
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2 - 10, { steps: 4 });
    await page.mouse.move(d.x + d.width / 2, d.y + d.height * 0.6, { steps: 6 });
    // The folder the drop resolves to is the one highlighted, not the row hovered.
    await expect(page.locator('.bm-folder[data-fid="med"].bm-drop-into')).toHaveCount(1);
    await page.mouse.up();
    await page.waitForTimeout(100);
    const parent = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('zimi_bm_folders')).find((f) => f.id === 'res').parent);
    expect(parent).toBe('med');
  });

  test('dropping into a collapsed folder expands it', async ({ page }) => {
    await seedAndOpen(page, FOLDERS, BOOKMARKS);
    await page.evaluate(() => {
      localStorage.setItem('zimi_bm_collapsed', JSON.stringify(['res']));
      _bmRerender();
    });
    const src = page.locator('.bm-bk[data-path="A/Loose"]');
    const dst = page.locator('.bm-folder[data-fid="res"]');
    const s = await src.boundingBox();
    const d = await dst.boundingBox();
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
    await page.mouse.down();
    await page.mouse.move(s.x + s.width / 2 + 12, s.y + s.height / 2 + 12, { steps: 4 });
    await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => _folIsCollapsed('res'))).toBe(false);
    await expect(page.locator('.bm-bk[data-path="A/Loose"][data-fid="res"]')).toHaveCount(1);
  });

  test('Save to ZIM opens with the whole library ticked', async ({ page }) => {
    await seedAndOpen(page, FOLDERS, BOOKMARKS);
    await page.getByRole('button', { name: 'Save to ZIM' }).click();
    await page.waitForSelector('#bm-export-tree');
    const boxes = page.locator('#bm-export-tree input[type=checkbox]');
    const total = await boxes.count();
    expect(total).toBeGreaterThan(0);
    expect(await boxes.evaluateAll((els) => els.filter((e) => e.checked).length)).toBe(total);
    // With everything ticked the shared button offers the other direction.
    await expect(page.locator('#bm-export-all')).toHaveText('Select none');
    await page.locator('#bm-export-all').click();
    expect(await boxes.evaluateAll((els) => els.filter((e) => e.checked).length)).toBe(0);
    await expect(page.locator('#bm-export-all')).toHaveText('Select all');
  });

  test('a folder menu export ticks only that subtree', async ({ page }) => {
    await seedAndOpen(page, FOLDERS, BOOKMARKS);
    await page.evaluate(() => _bmOpenExport('med'));
    await page.waitForSelector('#bm-export-tree');
    expect(await page.locator('#bm-export-tree input[data-fid="med"]').isChecked()).toBe(true);
    expect(await page.locator('#bm-export-tree input[data-fid="card"]').isChecked()).toBe(true);
    expect(await page.locator('#bm-export-tree input[data-fid="res"]').isChecked()).toBe(false);
    expect(await page.locator('#bm-export-tree input[data-fid="__unfiled__"]').isChecked()).toBe(false);
  });

  test('export selector builds one job per top-level folder with sections', async ({ page }) => {
    await seedAndOpen(page, FOLDERS, BOOKMARKS);
    await page.getByRole('button', { name: 'Save to ZIM' }).click();
    await page.waitForSelector('#bm-export-tree');
    // Select Medical (auto-checks its Cardiology subfolder).
    await page.locator('#bm-export-tree input[data-fid="med"]').check();
    const built = await page.evaluate(() => _bmBuildExportJobs());
    // One job (Medical); Cardiology's bookmark rides as a section, not its own ZIM.
    expect(built.jobs.length).toBe(1);
    expect(built.jobs[0].title).toBe('Medical');
    const sections = built.jobs[0].bookmarks.map((b) => b.section).sort();
    expect(sections).toContain('Cardiology'); // Heart, nested
    expect(sections).toContain('');           // Aspirin, directly in Medical
  });

  test('full export creates a ZIM and reveals it', async ({ page }) => {
    await seedAndOpen(page, FOLDERS, BOOKMARKS);
    await page.getByRole('button', { name: 'Save to ZIM' }).click();
    await page.waitForSelector('#bm-export-tree');
    await page.locator('#bm-export-tree input[data-fid="res"]').check();
    await page.getByRole('button', { name: 'Save to ZIM' }).nth(1).click();
    // Poll the server export status directly until done (bounded).
    await expect.poll(async () => {
      const st = await page.evaluate(async () => {
        const r = await fetch('/manage/export-bookmarks');
        return r.json();
      });
      return st.phase;
    }, { timeout: 15000, intervals: [400] }).toBe('done');
    const files = await page.evaluate(async () => {
      const r = await fetch('/manage/export-bookmarks');
      const st = await r.json();
      return st.files || [];
    });
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  test('drag a bookmark into a folder', async ({ page }) => {
    await seedAndOpen(page, FOLDERS, BOOKMARKS);
    const src = page.locator('.bm-bk[data-path="A/Loose"]');
    const dst = page.locator('.bm-folder[data-fid="res"]');
    const s = await src.boundingBox();
    const d = await dst.boundingBox();
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
    await page.mouse.down();
    // Move past the 4px lift threshold, then onto the folder's middle.
    await page.mouse.move(s.x + s.width / 2 + 12, s.y + s.height / 2 + 12, { steps: 4 });
    await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    const fid = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('zimi_bookmarks')).find((b) => b.path === 'A/Loose').folder);
    expect(fid).toBe('res');
  });
});
