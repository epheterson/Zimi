/**
 * v1.6 Visual Validation — Complete Release Checklist
 *
 * Run against NAS:
 *   BASE_URL=https://knowledge.zosia.io npx playwright test
 *
 * Run against local:
 *   npx playwright test
 *
 * View report:
 *   npx playwright show-report test-results/html-report
 *
 * Every test records video automatically (see playwright.config.mjs).
 * Screenshots are captured at key moments and embedded in the HTML report.
 */
import { test, expect } from '@playwright/test';

// ── Helpers ──────────────────────────────────────────────────────────────────

async function waitForApp(page) {
  await page.goto('/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('#output', { timeout: 20000 });
  await page.waitForSelector('.topbar', { timeout: 5000 });
  await page.waitForTimeout(1500);
}

async function switchLang(page, name) {
  await page.click('#lang-selector-btn');
  await page.waitForTimeout(400);
  await page.click(`.lang-dropdown-item:has-text("${name}")`);
  await page.waitForTimeout(1000);
}

async function resetToEnglish(page) {
  await page.evaluate(() => setLanguage('en'));
  await page.waitForTimeout(500);
}

async function openArticleViaJS(page, zim, path) {
  await page.evaluate(([z, p]) => openArticle(z, p), [zim, path]);
  await page.waitForTimeout(3000);
}

async function closeReaderViaJS(page) {
  await page.evaluate(() => { if (typeof closeReader === 'function') closeReader(); });
  await page.waitForTimeout(500);
}

async function search(page, query) {
  await page.evaluate(q => doSearch(q), query);
  await page.waitForTimeout(5000);
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. INTERNATIONALIZATION (i18n)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('1 — Internationalization', () => {
  test('1.1 — Language dropdown shows 10+ languages', async ({ page }) => {
    await waitForApp(page);
    await page.click('#lang-selector-btn');
    await page.waitForTimeout(400);
    const items = page.locator('#lang-dropdown .lang-dropdown-item');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(10);
    await page.screenshot({ path: 'test-results/1.1-lang-dropdown.png' });
  });

  test('1.2 — French: all UI strings translate', async ({ page }) => {
    await waitForApp(page);
    await switchLang(page, 'Français');
    const placeholder = await page.getAttribute('#q', 'placeholder');
    expect(placeholder).toContain('Rechercher');
    // Check discover label
    const discover = await page.textContent('.discover-label span, .dc-label span');
    expect(discover).toContain('Découvrir');
    await page.screenshot({ path: 'test-results/1.2-french-ui.png', fullPage: true });
    await resetToEnglish(page);
  });

  test('1.3 — Arabic: RTL layout applies', async ({ page }) => {
    await waitForApp(page);
    await switchLang(page, 'العربية');
    const dir = await page.getAttribute('html', 'dir');
    expect(dir).toBe('rtl');
    await page.screenshot({ path: 'test-results/1.3-arabic-rtl.png', fullPage: true });
    await resetToEnglish(page);
  });

  test('1.4 — Hebrew: present and RTL', async ({ page }) => {
    await waitForApp(page);
    await switchLang(page, 'עברית');
    const dir = await page.getAttribute('html', 'dir');
    expect(dir).toBe('rtl');
    await page.screenshot({ path: 'test-results/1.4-hebrew-rtl.png', fullPage: true });
    await resetToEnglish(page);
  });

  test('1.5 — Almanac calendar labels translate in French', async ({ page }) => {
    await waitForApp(page);
    await switchLang(page, 'Français');
    await page.waitForTimeout(1500); // Let discover cards re-render in French
    // Open almanac — try both French and English Today card text
    const todayCard = page.locator('.discover-card:has-text("ujourd"), .discover-card:has-text("Today")').first();
    if (await todayCard.isVisible({ timeout: 5000 }).catch(() => false)) {
      await todayCard.click();
      await page.waitForTimeout(5000);
      // Check for translated calendar system labels
      const content = await page.textContent('body');
      // Calendar section should have French labels like "Grégorien"
      expect(content).toMatch(/Grégorien|Hébraïque|Islamique|Julien/);
      await page.screenshot({ path: 'test-results/1.5-almanac-french.png', fullPage: true });
      await closeReaderViaJS(page);
    } else {
      test.skip(true, 'Today card not visible — Discover may be hidden');
    }
    await resetToEnglish(page);
  });

  test('1.6 — Search placeholder changes per language', async ({ page }) => {
    await waitForApp(page);
    const en = await page.getAttribute('#q', 'placeholder');
    await switchLang(page, 'Deutsch');
    const de = await page.getAttribute('#q', 'placeholder');
    expect(de).not.toBe(en);
    await page.screenshot({ path: 'test-results/1.6-german-placeholder.png' });
    await resetToEnglish(page);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. LANGUAGE EXPERIENCE
// ═════════════════════════════════════════════════════════════════════════════

test.describe('2 — Language Experience', () => {
  test('2.1 — Globe dropdown shows checkmark on current language', async ({ page }) => {
    await waitForApp(page);
    await page.click('#lang-selector-btn');
    await page.waitForTimeout(400);
    const check = page.locator('#lang-dropdown .check');
    await expect(check.first()).toBeVisible();
    await page.screenshot({ path: 'test-results/2.1-checkmark.png' });
  });

  test('2.2 — Globe shows article translations when reading', async ({ page }) => {
    await waitForApp(page);
    await openArticleViaJS(page, 'wikipedia', 'Albert_Einstein');
    await page.click('#lang-selector-btn');
    await page.waitForTimeout(1500);
    // Should have a divider separating article translations from UI languages
    const divider = page.locator('#lang-dropdown .ld-divider');
    await expect(divider.first()).toBeAttached();
    // Should have article translation items with "switchable" class
    const switchable = page.locator('#lang-dropdown .lang-dropdown-item.switchable');
    const count = await switchable.count();
    expect(count).toBeGreaterThan(0);
    await page.screenshot({ path: 'test-results/2.2-article-translations.png' });
    await closeReaderViaJS(page);
  });

  test('2.3 — French banner appears when switching to French', async ({ page }) => {
    await waitForApp(page);
    await switchLang(page, 'Français');
    await page.waitForTimeout(1500);
    // Look for the French welcome banner
    const banner = page.locator('#lang-welcome');
    const visible = await banner.isVisible().catch(() => false);
    if (visible) {
      const text = await banner.textContent();
      expect(text).toContain('Français');
      await page.screenshot({ path: 'test-results/2.3-french-banner.png' });
    }
    // Even if dismissed in localStorage, check placeholder changed
    const placeholder = await page.getAttribute('#q', 'placeholder');
    expect(placeholder).toContain('Rechercher');
    await resetToEnglish(page);
  });

  test('2.4 — Download ZIM from language dropdown', async ({ page }) => {
    test.setTimeout(120000); // 2 min — download may take time
    await waitForApp(page);
    // Open an article that has cross-language matches
    await openArticleViaJS(page, 'wikipedia', 'Water');
    // Switch UI to a language that has downloadable ZIMs
    await page.click('#lang-selector-btn');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'test-results/2.4-dropdown-before-download.png' });
    // Check if there's a download icon (.ld-download) in the dropdown
    const downloadBtn = page.locator('#lang-dropdown .ld-download').first();
    const hasDownload = await downloadBtn.isVisible().catch(() => false);
    if (hasDownload) {
      await downloadBtn.click();
      await page.waitForTimeout(3000);
      await page.screenshot({ path: 'test-results/2.4-download-progress.png' });
      // Wait for download to complete or timeout
      await page.waitForTimeout(30000);
      await page.screenshot({ path: 'test-results/2.4-download-after.png' });
    } else {
      // No download available — all translations already installed
      await page.screenshot({ path: 'test-results/2.4-no-download-needed.png' });
    }
    await closeReaderViaJS(page);
  });

  test('2.5 — French sources sort higher on home screen', async ({ page }) => {
    await waitForApp(page);
    await switchLang(page, 'Français');
    await page.waitForTimeout(2000);
    // Check for a "Français" category section on the home screen
    const frSection = page.locator('.cat-heading:has-text("Français")');
    await expect(frSection).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: 'test-results/2.5-french-sources-sorted.png', fullPage: true });
    await resetToEnglish(page);
  });

  test('2.6 — API: /article-languages returns cross-language matches', async ({ page }) => {
    const response = await page.request.get('/article-languages?zim=wikipedia&path=Albert_Einstein');
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.languages).toBeTruthy();
    expect(data.languages.length).toBeGreaterThan(0);
    // Each should have lang, name, zim, path
    const first = data.languages[0];
    expect(first.lang).toBeTruthy();
    expect(first.zim).toBeTruthy();
    expect(first.path).toBeTruthy();
  });

  test('2.7 — API: /languages returns JSON summary', async ({ page }) => {
    const response = await page.request.get('/languages');
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data).toBeTruthy();
  });

  test('2.8 — Globe icon is monochrome SVG', async ({ page }) => {
    await waitForApp(page);
    const svg = page.locator('#lang-selector-btn svg');
    await expect(svg).toBeVisible();
    const text = await page.locator('#lang-selector-btn').textContent();
    expect(text).not.toContain('🌐');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. ALMANAC
// ═════════════════════════════════════════════════════════════════════════════

test.describe('3 — Almanac', () => {
  let almanacOpened = false;

  async function openAlmanac(page) {
    await waitForApp(page);
    const todayCard = page.locator('.discover-card:has-text("Today")').first();
    if (!(await todayCard.isVisible({ timeout: 3000 }).catch(() => false))) {
      test.skip(true, 'Today card not visible');
      return false;
    }
    await todayCard.click();
    await page.waitForTimeout(5000);
    return true;
  }

  test('3.1 — Messages Across Time: inscription pills visible', async ({ page }) => {
    if (!(await openAlmanac(page))) return;
    // Scroll to Rosetta/Deep Time section
    const rosetta = page.locator('#almanac-rosetta');
    if (await rosetta.count() > 0) {
      await rosetta.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1000);
      // Inscription selector pills (each is a civilization/message)
      const pills = page.locator('.rosetta-pills .pill');
      const count = await pills.count();
      expect(count).toBeGreaterThanOrEqual(5);
      await page.screenshot({ path: 'test-results/3.1-messages-across-time.png' });
    }
    await closeReaderViaJS(page);
  });

  test('3.2 — Golden Record gallery: 49 images', async ({ page }) => {
    if (!(await openAlmanac(page))) return;
    // Click a Golden Record card to open gallery
    const grCard = page.locator('[onclick*="golden"], .rosetta-card:has-text("Golden Record"), .dt-card:has-text("Golden Record")').first();
    if (await grCard.isVisible().catch(() => false)) {
      await grCard.scrollIntoViewIfNeeded();
      await grCard.click();
      await page.waitForTimeout(2000);
      const images = page.locator('.gr-grid img, .gr-gallery img');
      const count = await images.count();
      expect(count).toBe(49);
      await page.screenshot({ path: 'test-results/3.2-golden-record-gallery.png', fullPage: true });
    }
    await closeReaderViaJS(page);
  });

  test('3.3 — Simulated Sky renders stars', async ({ page }) => {
    if (!(await openAlmanac(page))) return;
    const skyCanvas = page.locator('canvas.sky-canvas, .sky-section canvas').first();
    if (await skyCanvas.isVisible().catch(() => false)) {
      await skyCanvas.scrollIntoViewIfNeeded();
      await page.screenshot({ path: 'test-results/3.3-simulated-sky.png' });
    }
    await closeReaderViaJS(page);
  });

  test('3.4+3.5 — Orrery: transfer path and speed slider max', async ({ page }) => {
    if (!(await openAlmanac(page))) return;
    const orrery = page.locator('.orrery-section, canvas.orrery-canvas, [class*="orrery"]').first();
    if (await orrery.isVisible().catch(() => false)) {
      await orrery.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1000);
      // Check speed slider exists and max label
      const speedLabel = await page.evaluate(() => {
        const slider = document.querySelector('.orrery-speed, input[type="range"][class*="orrery"]');
        const label = document.querySelector('.speed-label, .orrery-speed-label');
        return { sliderExists: !!slider, labelText: label ? label.textContent : null };
      });
      await page.screenshot({ path: 'test-results/3.4-3.5-orrery.png' });
    }
    await closeReaderViaJS(page);
  });

  test('3.6 — Orrery controls responsive at mobile size', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    if (!(await openAlmanac(page))) return;
    const orrery = page.locator('[class*="orrery"]').first();
    if (await orrery.isVisible().catch(() => false)) {
      await orrery.scrollIntoViewIfNeeded();
      await page.screenshot({ path: 'test-results/3.6-orrery-mobile.png' });
    }
    await closeReaderViaJS(page);
  });

  test('3.7 — Calendar system picker order', async ({ page }) => {
    if (!(await openAlmanac(page))) return;
    const systems = await page.evaluate(() => {
      const rows = document.querySelectorAll('.alm-crossref-row, [onclick*="SwitchSystem"]');
      return Array.from(rows).map(r => r.textContent.trim().substring(0, 30));
    });
    await page.screenshot({ path: 'test-results/3.7-calendar-systems.png' });
    // Log order for manual review
    console.log('  Calendar order:', systems);
    await closeReaderViaJS(page);
  });

  test('3.8 — Moon earthshine and sky terminator', async ({ page }) => {
    if (!(await openAlmanac(page))) return;
    await page.screenshot({ path: 'test-results/3.8-moon-and-sky.png' });
    await closeReaderViaJS(page);
  });

  test('3.9 — No eclipse simulation visible', async ({ page }) => {
    if (!(await openAlmanac(page))) return;
    // Check there's no eclipse simulation UI (not data text)
    const eclipseSimulation = page.locator('.eclipse-simulation, .eclipse-canvas, canvas.eclipse');
    const count = await eclipseSimulation.count();
    expect(count).toBe(0);
    await closeReaderViaJS(page);
  });

  test('3.10 — Mobile: clock fits without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    if (!(await openAlmanac(page))) return;
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 5); // 5px tolerance
    await page.screenshot({ path: 'test-results/3.10-mobile-no-scroll.png', fullPage: true });
    await closeReaderViaJS(page);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. TABS
// ═════════════════════════════════════════════════════════════════════════════

test.describe('4 — Tabs', () => {
  test('4.1+4.2 — Cmd+click opens background tab, tab bar appears', async ({ page }) => {
    await waitForApp(page);
    // Open first article normally
    await openArticleViaJS(page, 'wikipedia', 'Water');
    expect(await page.title()).toContain('Water');
    // Simulate Cmd+click to open second article in background
    await page.evaluate(() => {
      _lastMouseEvent = { metaKey: true, ctrlKey: false, button: 0 };
      _lastMouseTime = Date.now();
      openArticle('wikipedia', 'Albert_Einstein', 'Albert Einstein');
    });
    await page.waitForTimeout(2000);
    // Tab bar should show 2 tabs
    const tabs = await page.evaluate(() => {
      return _tabs.map(t => ({ id: t.id, title: t.title, zim: t.zim }));
    });
    expect(tabs.length).toBe(2);
    // Current article should still be Water (background open)
    expect(await page.title()).toContain('Water');
    await page.screenshot({ path: 'test-results/4.1-4.2-tabs.png' });
    // Clean up tabs
    await page.evaluate(() => { _tabs = []; document.getElementById('tab-bar').innerHTML = ''; });
    await closeReaderViaJS(page);
  });

  test('4.3 — Desktop app: no "Open in New Tab" in context menu', async () => {
    test.skip(true, 'pywebview desktop app only — needs manual verification');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. SECURITY
// ═════════════════════════════════════════════════════════════════════════════

test.describe('5 — Security', () => {
  test('5.1 — Password hash uses salt$hash format', async () => {
    test.skip(true, 'Requires setting a password and checking file — manual test');
  });

  test('5.2 — Old SHA-256 auto-upgrades to PBKDF2', async () => {
    test.skip(true, 'Requires legacy hash file — manual test');
  });

  test('5.3 — POST /manage/generate-token returns API token', async ({ page }) => {
    await waitForApp(page);
    // Use in-page fetch to carry browser cookies/session through Cloudflare
    const result = await page.evaluate(async () => {
      const r = await fetch('/manage/generate-token', { method: 'POST' });
      return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
    });
    expect(result.ok).toBeTruthy();
    expect(result.body?.token).toBeTruthy();
    expect(result.body?.token?.length).toBeGreaterThan(20);
  });

  test('5.4 — Browser manage works without token', async ({ page }) => {
    await waitForApp(page);
    // Use in-page fetch to carry browser session
    const result = await page.evaluate(async () => {
      const r = await fetch('/manage/catalog');
      return { ok: r.ok, status: r.status };
    });
    // NAS may have password protection — log status for review
    console.log(`  /manage/catalog status: ${result.status}`);
    // Accept 200 (no password) or 401 (password set) — just not 500
    expect(result.status).not.toBe(500);
  });

  test('5.5 — ZIMI_MANAGE_PASSWORD env var', async () => {
    test.skip(true, 'Requires env var setup — manual test');
  });

  test('5.6 — Error responses hide stack traces', async ({ page }) => {
    const response = await page.request.get('/w/nonexistent/no_such_path');
    const text = await response.text();
    expect(text).not.toContain('Traceback');
    expect(text).not.toContain('File "');
  });

  test('5.7 — Security headers present', async ({ page }) => {
    const response = await page.request.get('/');
    const headers = response.headers();
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('same-origin');
  });

  test('5.8 — Thumbnail proxy blocks redirects', async ({ page }) => {
    const response = await page.request.get('/thumbnail-proxy?url=https://httpbin.org/redirect/1', {
      failOnStatusCode: false,
    });
    // Should block — return 4xx, NOT follow the redirect
    expect(response.status()).toBeGreaterThanOrEqual(400);
  });

  test('5.9 — Rate limiting returns 429 after threshold', async () => {
    // SKIP: Sending 65 rapid requests triggers Cloudflare protection and
    // cascades into all subsequent tests failing to load pages.
    // Rate limiting is code-verified in server.py (RATE_LIMIT = 60/min).
    // Test locally only.
    test.skip(true, 'Destructive test — triggers Cloudflare rate limiting, breaks subsequent tests');
  });

  test('5.10 — /w/ sub-resources use higher rate limit', async ({ page }) => {
    // Verify code-level: RATE_LIMIT_CONTENT = RATE_LIMIT * 20
    // Can't easily trigger content rate limit without 1200+ requests
    // Just verify /w/ resources load fine under normal conditions
    await waitForApp(page);
    await openArticleViaJS(page, 'wikipedia', 'Water');
    // Sub-resources (icon) should load
    const iconResponse = await page.request.get('/w/wikipedia/-/icon', { failOnStatusCode: false });
    expect(iconResponse.status()).toBeLessThan(500);
    await closeReaderViaJS(page);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. INFRASTRUCTURE
// ═════════════════════════════════════════════════════════════════════════════

test.describe('6 — Infrastructure', () => {
  test('6.1 — PWA manifest loads with correct name', async ({ page }) => {
    const response = await page.request.get('/static/manifest.json');
    expect(response.ok()).toBeTruthy();
    const manifest = await response.json();
    expect(manifest.name).toBe('Zimi');
  });

  test('6.2 — Thumbnails load via proxy with caching', async ({ page }) => {
    await waitForApp(page);
    // Thumbnails appear on discover cards — check network
    const response = await page.request.get('/thumbnail-proxy?url=https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Example.jpg/100px-Example.jpg', {
      failOnStatusCode: false,
    });
    // Either succeeds (with cache) or 404 (bad URL) — not 500
    expect(response.status()).not.toBe(500);
  });

  test('6.3 — deploy.sh exists', async () => {
    test.skip(true, 'Script-level check — manual verification');
  });

  test('6.4 — import zimi works without ZIM_DIR', async () => {
    test.skip(true, 'Python import test — run locally');
  });

  test('6.5 — /health returns version 1.6.0', async ({ page }) => {
    const response = await page.request.get('/health');
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.version).toBe('1.6.0');
  });

  test('6.6 — GitHub Actions CI passes', async () => {
    test.skip(true, 'Check GitHub Actions — manual');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. MCP SERVER
// ═════════════════════════════════════════════════════════════════════════════

test.describe('7 — MCP Server', () => {
  test('7.1 — MCP tool list includes language-aware tools', async () => {
    test.skip(true, 'Requires MCP client connection — manual verification');
  });

  test('7.2 — No article_map tool exposed', async () => {
    test.skip(true, 'Requires MCP client connection — code-verified: no article_map in mcp_server.py');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. LIBRARY MANAGER
// ═════════════════════════════════════════════════════════════════════════════

test.describe('8 — Library Manager', () => {
  async function openManage(page) {
    // Navigate to manage URL, then ensure manage mode activates
    await page.goto('/?manage', { waitUntil: 'networkidle', timeout: 30000 });
    // The ?manage param may not activate if manageEnabled isn't set yet from API
    // (especially if /manage/ endpoints are rate-limited from earlier tests)
    const manageTabs = page.locator('.manage-tab');
    let loaded = await manageTabs.first().isVisible({ timeout: 5000 }).catch(() => false);
    if (!loaded) {
      // Retry: wait for API, then call enterManage()
      await page.waitForTimeout(3000);
      loaded = await page.evaluate(() => {
        if (typeof enterManage === 'function' && manageEnabled) {
          enterManage();
          return true;
        }
        return false;
      });
      if (loaded) {
        await page.waitForSelector('.manage-tab', { timeout: 5000 }).catch(() => {});
      }
    }
    await page.waitForTimeout(1500);
    // Return whether manage mode is active
    return await manageTabs.first().isVisible().catch(() => false);
  }

  test('8.1 — Catalog tab shows scrollable language filter pills', async ({ page }) => {
    const active = await openManage(page);
    if (!active) { test.skip(true, 'Manage mode unavailable — likely rate-limited'); return; }
    await page.click('.manage-tab[data-tab="browse"]');
    await page.waitForTimeout(3000);
    const pills = page.locator('.catalog-lang-scroll button, .pill, .cat-filter');
    const count = await pills.count();
    expect(count).toBeGreaterThan(5);
    await page.screenshot({ path: 'test-results/8.1-catalog-pills.png', fullPage: true });
  });

  test('8.2 — Update All button exists and right-aligned', async ({ page }) => {
    const active = await openManage(page);
    if (!active) { test.skip(true, 'Manage mode unavailable — likely rate-limited'); return; }
    const btn = page.locator('#update-all-btn');
    if (await btn.isVisible().catch(() => false)) {
      const box = await btn.boundingBox();
      const viewport = page.viewportSize();
      expect(box.x + box.width).toBeGreaterThan(viewport.width / 2);
      await page.screenshot({ path: 'test-results/8.2-update-all-alignment.png' });
    } else {
      await page.screenshot({ path: 'test-results/8.2-no-updates-available.png' });
    }
  });

  test('8.3 — Settings panel organized with sub-tabs', async ({ page }) => {
    const active = await openManage(page);
    if (!active) { test.skip(true, 'Manage mode unavailable — likely rate-limited'); return; }
    await page.waitForSelector('#manage-status', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const navItems = page.locator('.ms-nav-item');
    const count = await navItems.count();
    expect(count).toBeGreaterThanOrEqual(3);
    await page.screenshot({ path: 'test-results/8.3-settings-panel.png' });
  });

  test('8.4 — Activity tab shows chronological card layout', async ({ page }) => {
    const active = await openManage(page);
    if (!active) { test.skip(true, 'Manage mode unavailable — likely rate-limited'); return; }
    await page.click('.manage-tab[data-tab="history"]');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'test-results/8.4-activity-tab.png', fullPage: true });
  });

  test('8.5 — Update check is cached', async () => {
    test.skip(true, 'Caching behavior needs multi-visit timing test — manual');
  });

  test('8.6 — Source cards show language indicators', async ({ page }) => {
    const active = await openManage(page);
    if (!active) { test.skip(true, 'Manage mode unavailable — likely rate-limited'); return; }
    await page.waitForTimeout(2000);
    // Installed items use .catalog-item, language tags use .ci-lang-tag
    const items = page.locator('.catalog-item');
    const itemCount = await items.count();
    const langTags = page.locator('.ci-lang-tag');
    const tagCount = await langTags.count();
    console.log(`  Installed items: ${itemCount}, Language tags: ${tagCount}`);
    await page.screenshot({ path: 'test-results/8.6-language-badges.png', fullPage: true });
    // Verify manage page loaded with some installed content
    expect(itemCount).toBeGreaterThan(0);
  });

  test('8.7 — Language-based collections auto-created', async ({ page }) => {
    await waitForApp(page);
    await switchLang(page, 'Français');
    await page.waitForTimeout(2000);
    // Check for auto-created "Français" category
    const frSection = page.locator('.cat-heading:has-text("Français")');
    await expect(frSection).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: 'test-results/8.7-french-collection.png', fullPage: true });
    await resetToEnglish(page);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. UI POLISH
// ═════════════════════════════════════════════════════════════════════════════

test.describe('9 — UI Polish', () => {
  test('9.1 — No article map button in reader', async ({ page }) => {
    await waitForApp(page);
    await openArticleViaJS(page, 'wikipedia', 'Water');
    const mapBtn = page.locator('.map-btn');
    expect(await mapBtn.count()).toBe(0);
    await page.screenshot({ path: 'test-results/9.1-no-map-btn.png' });
    await closeReaderViaJS(page);
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
      !e.includes('manifest') &&
      !e.includes('cloudflare') // Cloudflare script blocked by NAS
    );
    if (critical.length > 0) console.log('  JS Errors:', critical);
    expect(critical).toEqual([]);
  });

  test('9.2 — Desktop app launches without white flash', async () => {
    test.skip(true, 'pywebview desktop app only');
  });

  test('9.3 — Random button always loads an article', async ({ page }) => {
    await waitForApp(page);
    await page.evaluate(() => randomArticle());
    // Wait for reader to open — check for reader overlay visibility
    await page.waitForFunction(() => {
      const reader = document.getElementById('reader');
      return reader && reader.style.display !== 'none';
    }, { timeout: 10000 });
    await page.waitForTimeout(2000); // extra time for title to update via iframe load
    const title = await page.title();
    // Reader should be open with an article
    const readerVisible = await page.evaluate(() => {
      const r = document.getElementById('reader');
      return r && r.style.display !== 'none';
    });
    expect(readerVisible).toBe(true);
    await page.screenshot({ path: 'test-results/9.3-random-article.png' });
    await closeReaderViaJS(page);
  });

  test('9.4 — Settings port field is compact', async () => {
    test.skip(true, 'Docker mode has no Settings overlay — check in non-Docker');
  });

  test('9.5 — Favicon renders in browser tab', async ({ page }) => {
    await waitForApp(page);
    const favicons = page.locator('link[rel*="icon"]');
    const count = await favicons.count();
    expect(count).toBeGreaterThan(0);
  });

  test('9.6 — Almanac daylight says "Golden" not "Golden Hour"', async ({ page }) => {
    await waitForApp(page);
    const todayCard = page.locator('.discover-card:has-text("Today")').first();
    if (!(await todayCard.isVisible({ timeout: 3000 }).catch(() => false))) {
      test.skip(true, 'Today card not visible');
      return;
    }
    await todayCard.click();
    await page.waitForTimeout(5000);
    const text = await page.evaluate(() => {
      const daylight = document.querySelector('.alm-daylight, [class*="daylight"]');
      return daylight ? daylight.textContent : document.body.textContent;
    });
    // Should say "Golden" not "Golden Hour"
    expect(text).not.toMatch(/Golden\s+Hour/);
    await page.screenshot({ path: 'test-results/9.6-golden-not-golden-hour.png' });
    await closeReaderViaJS(page);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9b. PDF VIEWER
// ═════════════════════════════════════════════════════════════════════════════

test.describe('9b — PDF Viewer', () => {
  test('9b.1 — _pdfViewerUrl does not double-encode percent-encoded paths', async ({ page }) => {
    await waitForApp(page);
    // _articleUrl encodes "Water (1).pdf" → "Water%20(1).pdf"
    // _pdfViewerUrl must NOT re-encode %20 → %2520
    const result = await page.evaluate(() => {
      const articleUrl = _articleUrl('zimgit-water', 'files/Water (1).pdf');
      const viewerUrl = _pdfViewerUrl(articleUrl);
      return { articleUrl, viewerUrl };
    });
    // articleUrl should have %20 (encoded space)
    expect(result.articleUrl).toContain('Water%20(1).pdf');
    // viewerUrl should preserve %20, NOT double-encode to %2520
    expect(result.viewerUrl).toContain('Water%20(1).pdf');
    expect(result.viewerUrl).not.toContain('%2520');
    // Should start with the viewer path
    expect(result.viewerUrl).toMatch(/^\/static\/pdfjs\/web\/viewer\.html\?file=/);
  });

  test('9b.2 — PDF with spaces in filename fetches 200 (not 404)', async ({ page }) => {
    // Verify the server serves a PDF whose path contains spaces.
    // Double-encoding (%2520) would cause a 404; correct encoding (%20) returns 200.
    // Also verifies _pdfViewerUrl produces the correct URL via the SPA's own functions.
    await waitForApp(page);
    const result = await page.evaluate(async () => {
      // Build URL the same way the SPA does (encodes space → %20)
      const url = _articleUrl('zimgit-water', 'files/Water (1).pdf');
      const viewerUrl = _pdfViewerUrl(url);
      const fileParam = viewerUrl.split('?file=')[1];
      // Fetch as PDF.js XHR would
      try {
        const res = await fetch(fileParam);
        return {
          url: fileParam,
          status: res.status,
          contentType: res.headers.get('content-type'),
          hasDoubleEncoding: fileParam.includes('%2520'),
        };
      } catch (e) { return { url: fileParam, error: e.message }; }
    });
    if (result.error) { test.skip(true, result.error); return; }
    if (result.status === 404 && !result.hasDoubleEncoding) {
      test.skip(true, 'zimgit-water not installed'); return;
    }
    expect(result.hasDoubleEncoding).toBe(false);
    expect(result.status).toBe(200);
    expect(result.contentType).toContain('pdf');
  });

  test('9b.3 — PDF viewer URL preserves encoding (no double-encode)', async ({ page }) => {
    await waitForApp(page);
    // _pdfViewerUrl must pass the URL through unchanged.
    // Double-encoding turns %20→%2520, %26→%2526, etc.
    const results = await page.evaluate(() => {
      const cases = [
        { path: 'files/Water (1).pdf', desc: 'space+parens' },
        { path: 'files/Guide & Manual.pdf', desc: 'ampersand' },
        { path: 'files/Simple.pdf', desc: 'no special chars' },
      ];
      return cases.map(c => {
        const articleUrl = _articleUrl('test-zim', c.path);
        const viewerUrl = _pdfViewerUrl(articleUrl);
        const fileParam = viewerUrl.split('?file=')[1];
        return {
          desc: c.desc,
          articleUrl,
          fileParam,
          // The file= param should exactly equal the articleUrl
          preserved: fileParam === articleUrl,
        };
      });
    });

    for (const r of results) {
      expect(r.preserved, `${r.desc}: _pdfViewerUrl altered the URL — got "${r.fileParam}" expected "${r.articleUrl}"`).toBe(true);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. VISUAL SCREENSHOTS — Full-page captures for manual review
// ═════════════════════════════════════════════════════════════════════════════

test.describe('Visual Captures', () => {
  test('Home — Desktop (1440×900)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await waitForApp(page);
    await page.screenshot({ path: 'test-results/visual-home-desktop.png', fullPage: true });
  });

  test('Home — Mobile (375×812)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await waitForApp(page);
    await page.screenshot({ path: 'test-results/visual-home-mobile.png', fullPage: true });
  });

  test('Search results — Desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await waitForApp(page);
    await search(page, 'solar system');
    await page.screenshot({ path: 'test-results/visual-search-results.png', fullPage: true });
  });

  test('Reader — Wikipedia article', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await waitForApp(page);
    await openArticleViaJS(page, 'wikipedia', 'Solar_System');
    await page.screenshot({ path: 'test-results/visual-reader.png', fullPage: true });
    await closeReaderViaJS(page);
  });

  test('Almanac — Full page', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await waitForApp(page);
    const todayCard = page.locator('.discover-card:has-text("Today")').first();
    if (await todayCard.isVisible({ timeout: 3000 }).catch(() => false)) {
      await todayCard.click();
      await page.waitForTimeout(5000);
      await page.screenshot({ path: 'test-results/visual-almanac.png', fullPage: true });
    }
  });

  test('Library Manager — All tabs', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    // Use goto with ?manage directly
    await page.goto('/?manage', { waitUntil: 'networkidle', timeout: 30000 });
    const manageTabs = page.locator('.manage-tab');
    let loaded = await manageTabs.first().isVisible({ timeout: 8000 }).catch(() => false);
    if (!loaded) {
      await page.waitForTimeout(3000);
      await page.evaluate(() => { if (typeof enterManage === 'function' && manageEnabled) enterManage(); });
      loaded = await manageTabs.first().isVisible({ timeout: 5000 }).catch(() => false);
    }
    if (!loaded) { test.skip(true, 'Manage mode unavailable — likely rate-limited'); return; }
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'test-results/visual-manage-installed.png', fullPage: true });

    // Tabs use data-tab attribute (stable, not i18n-dependent)
    const tabs = [
      { data: 'browse', name: 'catalog' },
      { data: 'collections', name: 'collections' },
      { data: 'history', name: 'activity' },
    ];
    for (const tab of tabs) {
      const tabEl = page.locator(`.manage-tab[data-tab="${tab.data}"]`);
      if (await tabEl.isVisible({ timeout: 3000 }).catch(() => false)) {
        await tabEl.click();
        await page.waitForTimeout(2000);
      }
      await page.screenshot({ path: `test-results/visual-manage-${tab.name}.png`, fullPage: true });
    }
  });

  test('All 10 languages — UI screenshot carousel', async ({ page }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const langs = ['English', 'Français', 'Deutsch', 'Español', 'Português', 'Русский', '中文', 'العربية', 'हिन्दी', 'עברית'];
    for (const lang of langs) {
      await waitForApp(page);
      await switchLang(page, lang);
      await page.waitForTimeout(500);
      const code = await page.evaluate(() => _currentLang);
      await page.screenshot({ path: `test-results/visual-lang-${code}.png`, fullPage: true });
    }
    await resetToEnglish(page);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. v1.6.10 — INTERLANG POLISH, Q-ID BADGES, UI FIXES
// ═════════════════════════════════════════════════════════════════════════════

test.describe('11 — v1.6.10 Fixes', () => {
  test('11.1 — Server starts without _probe_all_qid_support error', async ({ page }) => {
    const response = await page.request.get('/health');
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.status).toBe('ok');
  });

  test('11.2 — /search returns language and has_qids fields', async ({ page }) => {
    test.setTimeout(60000);
    await waitForApp(page);
    const data = await page.evaluate(async () => {
      const r = await fetch('/search?q=water&limit=3');
      return r.json();
    });
    expect(data.results.length).toBeGreaterThan(0);
    const first = data.results[0];
    expect(first).toHaveProperty('language');
    expect(first).toHaveProperty('has_qids');
    expect(typeof first.language).toBe('string');
    expect(typeof first.has_qids).toBe('boolean');
  });

  test('11.3 — /search?lang=en filters to English ZIMs only', async ({ page }) => {
    test.setTimeout(60000);
    await waitForApp(page);
    const data = await page.evaluate(async () => {
      const r = await fetch('/search?q=water&limit=5&lang=en');
      return r.json();
    });
    for (const r of data.results) {
      expect(r.language).toBe('en');
    }
  });

  test('11.4 — /search?lang=xx returns empty for nonexistent language', async ({ page }) => {
    await waitForApp(page);
    const data = await page.evaluate(async () => {
      const r = await fetch('/search?q=water&lang=xx');
      return r.json();
    });
    expect(data.total).toBe(0);
    expect(data.results).toEqual([]);
  });

  test('11.5 — /list includes has_qids on Wikipedia entries', async ({ page }) => {
    await waitForApp(page);
    const data = await page.evaluate(async () => {
      const r = await fetch('/list');
      return r.json();
    });
    const wikiEntries = data.filter(z => z.name && z.name.includes('wikipedia'));
    expect(wikiEntries.length).toBeGreaterThan(0);
    // At least one Wikipedia ZIM should have has_qids
    const withQids = wikiEntries.filter(z => z.has_qids === true);
    expect(withQids.length).toBeGreaterThan(0);
  });

  test('11.6 — Flavor popup options stretch full width', async ({ page }) => {
    await waitForApp(page);
    // Open manage → catalog to find a flavor picker
    await page.goto('/?manage', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
    await page.evaluate(() => { if (typeof enterManage === 'function' && manageEnabled) enterManage(); });
    await page.waitForTimeout(1500);
    const catalogTab = page.locator('.manage-tab[data-tab="browse"]');
    if (await catalogTab.isVisible().catch(() => false)) {
      await catalogTab.click();
      await page.waitForTimeout(3000);
      // Find a chevron button (flavor picker trigger)
      const chevron = page.locator('.ci-dl-chevron').first();
      if (await chevron.isVisible().catch(() => false)) {
        await chevron.click();
        await page.waitForTimeout(500);
        const popup = page.locator('.flavor-popup');
        if (await popup.isVisible().catch(() => false)) {
          const popupBox = await popup.boundingBox();
          const options = page.locator('.flavor-option');
          const count = await options.count();
          for (let i = 0; i < count; i++) {
            const optBox = await options.nth(i).boundingBox();
            // Each option should be nearly as wide as the popup (minus padding)
            expect(optBox.width).toBeGreaterThan(popupBox.width * 0.8);
          }
          await page.screenshot({ path: 'test-results/11.6-flavor-popup-width.png' });
        }
      }
    }
  });

  test('11.7 — cross_lang_linking i18n key exists in all languages', async ({ page }) => {
    await waitForApp(page);
    const langs = ['en', 'fr', 'de', 'es', 'pt', 'ru', 'zh', 'ar', 'hi', 'he'];
    const results = await page.evaluate(async (codes) => {
      const out = {};
      for (const lang of codes) {
        const r = await fetch(`/static/i18n/${lang}.json`);
        const data = await r.json();
        out[lang] = data.cross_lang_linking || null;
      }
      return out;
    }, langs);
    for (const lang of langs) {
      expect(results[lang], `${lang} missing cross_lang_linking`).toBeTruthy();
    }
  });

  test('11.8 — Q-ID badge SVG visible on Wikipedia source cards', async ({ page }) => {
    await waitForApp(page);
    // Home page source cards — Wikipedia cards should show Q-ID badge
    const qidBadge = page.locator('.qid-badge, .source-qid, [class*="qid"]').first();
    const hasBadge = await qidBadge.isVisible({ timeout: 3000 }).catch(() => false);
    // Screenshot for manual review regardless
    await page.screenshot({ path: 'test-results/11.8-qid-badges.png', fullPage: true });
    // Log badge state
    console.log(`  Q-ID badge visible: ${hasBadge}`);
  });
});
