import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://10.0.0.14:8899';

// Helper: simulate Ctrl/Cmd+click via JS (Playwright's click doesn't reliably
// trigger our mousedown capture listener)
async function modClick(page, fn) {
  return page.evaluate(fn);
}

test.describe('In-app tabs', () => {

  // Enable in-app tabs before each test (default is browser tabs)
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE);
    await page.evaluate(() => localStorage.setItem('zimi_inapp_tabs', '1'));
  });

  test('1. First Ctrl+click from search opens article + tracks tab', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForTimeout(3000);
    await page.fill('[placeholder*="Search"]', 'pizza');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(12000);

    const result = await modClick(page, () => {
      var el = document.querySelector('.result[data-zim][data-path]');
      if (!el) return { error: 'no results' };
      _lastMouseEvent = { ctrlKey: true, metaKey: true, button: 0 };
      _lastMouseTime = Date.now();
      openArticle(el.getAttribute('data-zim'), el.getAttribute('data-path'), el.getAttribute('data-title'));
      return { readerOpen, tabCount: _tabs.length, activeTabId: _activeTabId };
    });
    console.log('First Ctrl+click:', result);
    expect(result.readerOpen).toBe(true);
    expect(result.tabCount).toBeGreaterThanOrEqual(1);
  });

  test('2. Second Ctrl+click while reading shows tab bar', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForTimeout(3000);
    await page.evaluate(() => openArticle('wikipedia', 'A/Sun', 'Sun'));
    await page.waitForTimeout(3000);

    const result = await modClick(page, () => {
      _lastMouseEvent = { ctrlKey: true, metaKey: true, button: 0 };
      _lastMouseTime = Date.now();
      openArticle('wikipedia', 'A/Water', 'Water');
      var bar = document.getElementById('tab-bar');
      return {
        tabCount: _tabs.length,
        visible: bar?.classList.contains('visible'),
        titles: _tabs.map(t => t.title)
      };
    });
    console.log('Second Ctrl+click:', result);
    expect(result.tabCount).toBeGreaterThanOrEqual(2);
    expect(result.visible).toBe(true);
  });

  test('3. Tab switching works', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForTimeout(3000);
    await page.evaluate(() => openArticle('wikipedia', 'A/Sun', 'Sun'));
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      _lastMouseEvent = { ctrlKey: true, metaKey: true, button: 0 };
      _lastMouseTime = Date.now();
      openArticle('wikipedia', 'A/Water', 'Water');
    });
    await page.waitForTimeout(2000);

    // Switch to first tab
    const result = await page.evaluate(() => {
      var firstTab = _tabs[0];
      _switchTab(firstTab.id);
      return {
        activeTitle: _tabs.find(t => t.id === _activeTabId)?.title,
        currentPath: currentArticle?.path
      };
    });
    console.log('After switch:', result);
    expect(result.activeTitle).toContain('Sun');
  });

  test('4. Closing tab works', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForTimeout(3000);
    await page.evaluate(() => openArticle('wikipedia', 'A/Sun', 'Sun'));
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      _lastMouseEvent = { ctrlKey: true, metaKey: true, button: 0 };
      _lastMouseTime = Date.now();
      openArticle('wikipedia', 'A/Water', 'Water');
    });
    await page.waitForTimeout(1000);

    const result = await page.evaluate(() => {
      var before = _tabs.length;
      _closeTab(_tabs[_tabs.length - 1].id);
      var bar = document.getElementById('tab-bar');
      return {
        before,
        after: _tabs.length,
        barVisible: bar?.classList.contains('visible')
      };
    });
    console.log('After close:', result);
    expect(result.after).toBe(result.before - 1);
    // Tab bar hides when only 1 tab left
    if (result.after <= 1) expect(result.barVisible).toBe(false);
  });

  test('5. Middle-click on search result works', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForTimeout(3000);
    await page.fill('[placeholder*="Search"]', 'water');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(12000);

    const result = await page.evaluate(() => {
      var el = document.querySelector('.result[data-zim][data-path]');
      if (!el) return { error: 'no results' };
      var e = new MouseEvent('auxclick', { button: 1, bubbles: true });
      el.dispatchEvent(e);
      return { readerOpen, tabCount: _tabs.length };
    });
    console.log('Middle-click:', result);
    expect(result.readerOpen).toBe(true);
  });

  test('6. Middle-click on Discover card works', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForTimeout(15000);

    const result = await page.evaluate(() => {
      var el = document.querySelector('.discover-card[data-zim][data-path]');
      if (!el) return { skip: true, reason: 'no discover cards with data-zim' };
      var e = new MouseEvent('auxclick', { button: 1, bubbles: true });
      el.dispatchEvent(e);
      return { readerOpen, tabCount: _tabs.length };
    });
    console.log('Discover middle-click:', result);
    if (!result.skip) {
      expect(result.readerOpen).toBe(true);
    }
  });

  test('7. Ctrl+click does NOT open browser tab (stays in-app)', async ({ page, context }) => {
    await page.goto(BASE);
    await page.waitForTimeout(3000);
    await page.fill('[placeholder*="Search"]', 'pizza');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(12000);

    const pagesBefore = context.pages().length;
    await page.evaluate(() => {
      var el = document.querySelector('.result[data-zim][data-path]');
      if (!el) return;
      _lastMouseEvent = { ctrlKey: true, metaKey: true, button: 0 };
      _lastMouseTime = Date.now();
      openArticle(el.getAttribute('data-zim'), el.getAttribute('data-path'), el.getAttribute('data-title'));
    });
    await page.waitForTimeout(1000);
    const pagesAfter = context.pages().length;
    console.log('Browser tabs:', pagesBefore, '->', pagesAfter);
    // Should NOT open new browser tab
    expect(pagesAfter).toBe(pagesBefore);
  });

  test('8. Closing all tabs returns to previous state', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForTimeout(3000);
    await page.evaluate(() => openArticle('wikipedia', 'A/Sun', 'Sun'));
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      _lastMouseEvent = { ctrlKey: true, metaKey: true, button: 0 };
      _lastMouseTime = Date.now();
      openArticle('wikipedia', 'A/Water', 'Water');
    });
    await page.waitForTimeout(1000);

    // Close all tabs
    const result = await page.evaluate(() => {
      while (_tabs.length > 0) _closeTab(_tabs[0].id);
      var bar = document.getElementById('tab-bar');
      return {
        tabCount: _tabs.length,
        barVisible: bar?.classList.contains('visible'),
        readerOpen
      };
    });
    console.log('After close all:', result);
    expect(result.tabCount).toBe(0);
    expect(result.barVisible).toBe(false);
  });
});
