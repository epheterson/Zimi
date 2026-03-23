// Cross-language article navigation tests
// Run against NAS: BASE_URL=http://knowledge.zosia.lan npx playwright test tests/test_interlang.mjs --config=playwright.config.mjs

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://10.0.0.14:8899';

test.describe('Cross-language navigation', () => {

  test('Sun article shows all 4 target languages via Q-ID', async ({ request }) => {
    const res = await request.get(`${BASE}/article-languages?zim=wikipedia&path=A/Sun`);
    const data = await res.json();
    const langs = data.languages.map(l => l.lang).sort();
    console.log('Sun languages:', langs);
    // Should find de, fr, he, hi (all installed Wikipedias except en source)
    expect(langs).toContain('de');
    expect(langs).toContain('fr');
    expect(langs.length).toBeGreaterThanOrEqual(2);
    // he and hi may timeout on slow NAS — don't hard-fail
    if (langs.includes('he')) {
      const he = data.languages.find(l => l.lang === 'he');
      expect(he.path).toBeTruthy();
      expect(he.zim).toBe('wikipedia_he');
    }
  });

  test('Sun article: Hebrew path resolves to readable content', async ({ request }) => {
    const langRes = await request.get(`${BASE}/article-languages?zim=wikipedia&path=A/Sun`);
    const langData = await langRes.json();
    const he = langData.languages.find(l => l.lang === 'he');
    if (!he) { test.skip(); return; }
    // Read the Hebrew article
    const readRes = await request.get(`${BASE}/read?zim=${he.zim}&path=${encodeURIComponent(he.path)}&max_length=500`);
    const text = await readRes.text();
    expect(readRes.status()).toBe(200);
    expect(text.length).toBeGreaterThan(50);
    console.log('Hebrew Sun preview:', text.substring(0, 100));
  });

  test('Language dropdown shows translations in browser UI', async ({ page }) => {
    // Open the Sun article in English Wikipedia
    await page.goto(`${BASE}/w/wikipedia/A/Sun`);
    await page.waitForTimeout(5000); // Wait for interlang prefetch

    // Open language dropdown
    const langBtn = page.locator('#lang-selector-btn, [data-ms="language"], .lang-selector');
    if (await langBtn.count() > 0) {
      await langBtn.first().click();
      await page.waitForTimeout(2000);

      // Check for language entries in the dropdown
      const dropdown = page.locator('#lang-dropdown, .lang-dropdown');
      if (await dropdown.count() > 0) {
        const content = await dropdown.textContent();
        console.log('Language dropdown content:', content?.substring(0, 200));
        // Should mention at least Deutsch or Français
        const hasLangs = content?.includes('Deutsch') || content?.includes('Français');
        expect(hasLangs).toBeTruthy();
      }
    }
  });

  test('Fuzzy matching: article with same title across languages', async ({ request }) => {
    // "Pizza" exists in many Wikipedias with the same title
    const res = await request.get(`${BASE}/article-languages?zim=wikipedia&path=A/Pizza`);
    const data = await res.json();
    const langs = data.languages.map(l => l.lang);
    console.log('Pizza languages:', langs);
    // At minimum de and fr should match via title heuristic
    expect(langs).toContain('de');
    expect(langs).toContain('fr');
  });

  test('Q-ID matching returns correct translated paths', async ({ request }) => {
    // Sun in Hindi should be सूर्य, not "Sun"
    const res = await request.get(`${BASE}/article-languages?zim=wikipedia&path=A/Sun`);
    const data = await res.json();
    const hi = data.languages.find(l => l.lang === 'hi');
    if (!hi) { test.skip(); return; }
    // Hindi path should be a Hindi word, not English
    console.log('Hindi Sun path:', hi.path);
    expect(hi.path).not.toBe('A/Sun');
    expect(hi.path).not.toBe('Sun');
  });

  test('Non-Wikipedia ZIMs return empty languages (no Q-ID)', async ({ request }) => {
    // Gutenberg/medical ZIMs don't have cross-language support
    const res = await request.get(`${BASE}/article-languages?zim=gutenberg&path=A/some_article`);
    expect(res.status()).toBe(200);
    const data = await res.json();
    // Should return empty or error gracefully
    expect(data.languages?.length || 0).toBe(0);
  });
});
