import { test } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://10.0.0.14:8899';

// Set Sec-Fetch-Site header so manage endpoints work
test.use({
  extraHTTPHeaders: {
    'Sec-Fetch-Site': 'same-origin',
  },
});

test('Screenshot: Homepage', async ({ page }) => {
  await page.goto(BASE);
  for (let i = 0; i < 45; i++) {
    await page.waitForTimeout(1000);
    const cards = await page.evaluate(() =>
      document.querySelectorAll('[class*="disc-card"], [class*="discover"] [cursor]').length
    );
    if (cards >= 5) break;
  }
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'screenshots/homepage.png', fullPage: false });
});

test('Screenshot: Search', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForTimeout(5000);
  await page.fill('[placeholder*="Search"]', 'pizza');
  await page.keyboard.press('Enter');
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(1000);
    const done = await page.evaluate(() =>
      !document.body.textContent.includes('Searching article content') &&
      !document.body.textContent.includes('Searching titles') &&
      document.body.textContent.includes('results')
    );
    if (done) break;
  }
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'screenshots/search.png', fullPage: false });
});

test('Screenshot: Language dropdown', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForTimeout(5000);
  await page.evaluate(() => openArticle('wikipedia', 'A/Sun', 'Sun'));
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    const loaded = await page.evaluate(() => {
      try { return document.getElementById('reader-frame')?.contentDocument?.title !== ''; }
      catch(e) { return false; }
    });
    if (loaded) break;
  }
  await page.waitForTimeout(8000);
  await page.evaluate(() => toggleLangDropdown(new Event('click')));
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    const arrows = await page.evaluate(() => document.querySelectorAll('.ld-interlang').length);
    if (arrows > 5) break;
  }
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'screenshots/language-dropdown.png', fullPage: false });
});

test('Screenshot: Installed library', async ({ page }) => {
  await page.goto(BASE + '/?manage');
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1000);
    const ready = await page.evaluate(() => {
      const items = document.querySelectorAll('.catalog-item');
      return items.length > 3;
    });
    if (ready) break;
  }
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'screenshots/browse-library.png', fullPage: false });
});
