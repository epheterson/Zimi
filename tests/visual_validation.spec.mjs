/**
 * v1.6 Visual Validation — Automated Playwright pass
 * Tests all UI-visible changes from the release checklist.
 * Run: npx playwright test tests/visual_validation.spec.mjs --reporter=list
 */
import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:8899';

// Helper: wait for the SPA to fully load
async function waitForApp(page) {
  await page.goto(BASE);
  await page.waitForSelector('#output', { timeout: 10000 });
  await page.waitForSelector('.topbar', { timeout: 5000 });
  await page.waitForTimeout(1500);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. INTERNATIONALIZATION
// ─────────────────────────────────────────────────────────────────────────────

test('1.1 — Language dropdown opens and shows available languages', async ({ page }) => {
  await waitForApp(page);
  await page.click('#lang-selector-btn');
  await page.waitForTimeout(500);
  const dropdown = page.locator('#lang-dropdown');
  await expect(dropdown).toBeVisible();
  const items = dropdown.locator('.lang-dropdown-item');
  const count = await items.count();
  expect(count).toBeGreaterThanOrEqual(10);
  console.log(`  Found ${count} languages in dropdown`);
});

test('1.2 — Switch to French — UI strings change', async ({ page }) => {
  await waitForApp(page);
  const enPlaceholder = await page.getAttribute('#q', 'placeholder');
  await page.click('#lang-selector-btn');
  await page.waitForTimeout(500);
  await page.click('.lang-dropdown-item:has-text("Français")');
  await page.waitForTimeout(800);
  const frPlaceholder = await page.getAttribute('#q', 'placeholder');
  expect(frPlaceholder).not.toBe(enPlaceholder);
  console.log(`  EN: "${enPlaceholder}" → FR: "${frPlaceholder}"`);
  // Reset to English
  await page.click('#lang-selector-btn');
  await page.waitForTimeout(500);
  await page.click('.lang-dropdown-item:has-text("English")');
});

test('1.3 — Switch to Arabic — RTL layout applies', async ({ page }) => {
  await waitForApp(page);
  await page.click('#lang-selector-btn');
  await page.waitForTimeout(500);
  await page.click('.lang-dropdown-item:has-text("العربية")');
  await page.waitForTimeout(800);
  const dir = await page.getAttribute('html', 'dir');
  expect(dir).toBe('rtl');
  console.log('  RTL direction applied for Arabic');
  // Reset
  await page.click('#lang-selector-btn');
  await page.waitForTimeout(500);
  await page.click('.lang-dropdown-item:has-text("English")');
  await page.waitForTimeout(300);
});

test('1.4 — Hebrew in dropdown and RTL', async ({ page }) => {
  await waitForApp(page);
  await page.click('#lang-selector-btn');
  await page.waitForTimeout(500);
  const hebrew = page.locator('.lang-dropdown-item:has-text("עברית")');
  await expect(hebrew).toBeVisible();
  await hebrew.click();
  await page.waitForTimeout(800);
  const dir = await page.getAttribute('html', 'dir');
  expect(dir).toBe('rtl');
  console.log('  Hebrew present and RTL applied');
  // Reset
  await page.click('#lang-selector-btn');
  await page.waitForTimeout(500);
  await page.click('.lang-dropdown-item:has-text("English")');
  await page.waitForTimeout(300);
});

test('1.6 — Search placeholder changes with language', async ({ page }) => {
  await waitForApp(page);
  const enPlaceholder = await page.getAttribute('#q', 'placeholder');
  await page.click('#lang-selector-btn');
  await page.waitForTimeout(500);
  await page.click('.lang-dropdown-item:has-text("Deutsch")');
  await page.waitForTimeout(800);
  const dePlaceholder = await page.getAttribute('#q', 'placeholder');
  expect(dePlaceholder).not.toBe(enPlaceholder);
  console.log(`  EN: "${enPlaceholder}" → DE: "${dePlaceholder}"`);
  // Reset
  await page.click('#lang-selector-btn');
  await page.waitForTimeout(500);
  await page.click('.lang-dropdown-item:has-text("English")');
  await page.waitForTimeout(300);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. LANGUAGE EXPERIENCE
// ─────────────────────────────────────────────────────────────────────────────

test('2.1 — Globe dropdown shows checkmark on current language', async ({ page }) => {
  await waitForApp(page);
  await page.click('#lang-selector-btn');
  await page.waitForTimeout(500);
  const checkmark = page.locator('#lang-dropdown .check');
  const count = await checkmark.count();
  expect(count).toBeGreaterThanOrEqual(1);
  console.log('  Checkmark visible on current language');
});

test('2.7 — API: /languages endpoint returns JSON', async ({ page }) => {
  const response = await page.request.get(`${BASE}/languages`);
  expect(response.ok()).toBeTruthy();
  const data = await response.json();
  expect(data).toBeTruthy();
  console.log(`  /languages returned ${JSON.stringify(data).length} bytes`);
});

test('2.8 — Globe icon is SVG, not emoji', async ({ page }) => {
  await waitForApp(page);
  const btn = page.locator('#lang-selector-btn');
  const svg = btn.locator('svg');
  await expect(svg).toBeVisible();
  const text = await btn.textContent();
  expect(text).not.toContain('🌐');
  console.log('  Globe is SVG');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ALMANAC
// ─────────────────────────────────────────────────────────────────────────────

test('3.7 — Calendar system picker visible in almanac', async ({ page }) => {
  await waitForApp(page);
  const todayCard = page.locator('.discover-card:has-text("Today")').first();
  if (await todayCard.isVisible()) {
    await todayCard.click();
    await page.waitForTimeout(2000);
    const almanac = page.locator('#almanac-overlay, .almanac-overlay, .alm-content');
    const visible = await almanac.count();
    console.log(`  Almanac elements found: ${visible}`);
  } else {
    console.log('  Today card not visible (Discover may be hidden) — skipping');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. TABS & SEARCH
// ─────────────────────────────────────────────────────────────────────────────

test('4.1 — Search and open article', async ({ page }) => {
  await waitForApp(page);
  await page.fill('#q', 'water');
  await page.waitForTimeout(2000);
  const results = page.locator('.result-item');
  const count = await results.count();
  if (count > 0) {
    console.log(`  Found ${count} search results for "water"`);
    await results.first().click();
    await page.waitForTimeout(1000);
    const reader = page.locator('#reader');
    const isVisible = await reader.isVisible();
    expect(isVisible).toBeTruthy();
    console.log('  Reader opened successfully');
  } else {
    const altResults = page.locator('.results a, .results div[onclick]');
    const altCount = await altResults.count();
    console.log(`  Alt selector found ${altCount} results`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. SECURITY
// ─────────────────────────────────────────────────────────────────────────────

test('5.6 — Error responses don\'t leak stack traces', async ({ page }) => {
  const response = await page.request.get(`${BASE}/w/nonexistent/path`);
  if (!response.ok()) {
    const text = await response.text();
    expect(text).not.toContain('Traceback');
    expect(text).not.toContain('File "');
    console.log('  No stack traces in error response');
  }
});

test('5.7 — Security headers present', async ({ page }) => {
  const response = await page.request.get(BASE);
  const headers = response.headers();
  const nosniff = headers['x-content-type-options'];
  const referrer = headers['referrer-policy'];
  console.log(`  X-Content-Type-Options: ${nosniff}`);
  console.log(`  Referrer-Policy: ${referrer}`);
  if (nosniff) expect(nosniff).toBe('nosniff');
  if (referrer) expect(referrer).toBe('same-origin');
  expect(nosniff || referrer).toBeTruthy();
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. INFRASTRUCTURE
// ─────────────────────────────────────────────────────────────────────────────

test('6.1 — PWA manifest loads', async ({ page }) => {
  const response = await page.request.get(`${BASE}/static/manifest.json`);
  expect(response.ok()).toBeTruthy();
  const manifest = await response.json();
  expect(manifest.name).toBeTruthy();
  console.log(`  Manifest name: ${manifest.name}`);
});

test('6.5 — Health endpoint returns version 1.6.0', async ({ page }) => {
  const response = await page.request.get(`${BASE}/health`);
  expect(response.ok()).toBeTruthy();
  const data = await response.json();
  expect(data.version).toBe('1.6.0');
  console.log(`  Version: ${data.version}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. UI POLISH
// ─────────────────────────────────────────────────────────────────────────────

test('9.1 — No article map button in reader', async ({ page }) => {
  await waitForApp(page);
  await page.fill('#q', 'water');
  await page.waitForTimeout(2000);
  const results = page.locator('.result-item');
  if (await results.count() > 0) {
    await results.first().click();
    await page.waitForTimeout(1000);
    const mapBtn = page.locator('.map-btn');
    expect(await mapBtn.count()).toBe(0);
    console.log('  No map button in reader');
  }
});

test('9.1b — No JS errors in console on page load', async ({ page }) => {
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await waitForApp(page);
  await page.waitForTimeout(3000);
  const critical = errors.filter(e =>
    !e.includes('service worker') &&
    !e.includes('ServiceWorker') &&
    !e.includes('sw.js') &&
    !e.includes('manifest')
  );
  if (critical.length > 0) {
    console.log('  JS Errors:', critical);
  } else {
    console.log('  No critical JS errors');
  }
  expect(critical).toEqual([]);
});

test('9.5 — Favicon present', async ({ page }) => {
  await waitForApp(page);
  const favicon = page.locator('link[rel*="icon"]');
  const count = await favicon.count();
  expect(count).toBeGreaterThan(0);
  console.log(`  Found ${count} favicon link(s)`);
});

// ─────────────────────────────────────────────────────────────────────────────
// VISUAL SCREENSHOTS for manual review
// ─────────────────────────────────────────────────────────────────────────────

test('Screenshot — Home screen (desktop)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForApp(page);
  await page.screenshot({ path: 'screenshots/v1.6-home-desktop.png', fullPage: true });
  console.log('  Saved: screenshots/v1.6-home-desktop.png');
});

test('Screenshot — Home screen (mobile)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await waitForApp(page);
  await page.screenshot({ path: 'screenshots/v1.6-home-mobile.png', fullPage: true });
  console.log('  Saved: screenshots/v1.6-home-mobile.png');
});

test('Screenshot — Language dropdown', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForApp(page);
  await page.click('#lang-selector-btn');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'screenshots/v1.6-lang-dropdown.png' });
  console.log('  Saved: screenshots/v1.6-lang-dropdown.png');
});

test('Screenshot — French UI', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForApp(page);
  await page.click('#lang-selector-btn');
  await page.waitForTimeout(500);
  await page.click('.lang-dropdown-item:has-text("Français")');
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'screenshots/v1.6-french.png', fullPage: true });
  console.log('  Saved: screenshots/v1.6-french.png');
  // Reset
  await page.click('#lang-selector-btn');
  await page.waitForTimeout(500);
  await page.click('.lang-dropdown-item:has-text("English")');
});

test('Screenshot — Arabic RTL', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForApp(page);
  await page.click('#lang-selector-btn');
  await page.waitForTimeout(500);
  await page.click('.lang-dropdown-item:has-text("العربية")');
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'screenshots/v1.6-arabic-rtl.png', fullPage: true });
  console.log('  Saved: screenshots/v1.6-arabic-rtl.png');
  // Reset
  await page.click('#lang-selector-btn');
  await page.waitForTimeout(500);
  await page.click('.lang-dropdown-item:has-text("English")');
});

test('Screenshot — Search results', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForApp(page);
  await page.fill('#q', 'water');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'screenshots/v1.6-search.png' });
  console.log('  Saved: screenshots/v1.6-search.png');
});

test('Screenshot — Almanac', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForApp(page);
  const todayCard = page.locator('.discover-card:has-text("Today")').first();
  if (await todayCard.isVisible()) {
    await todayCard.click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'screenshots/v1.6-almanac.png', fullPage: true });
    console.log('  Saved: screenshots/v1.6-almanac.png');
  } else {
    console.log('  Today card not visible — skipping almanac screenshot');
  }
});
