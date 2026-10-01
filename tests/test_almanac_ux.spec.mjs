// The Almanac's orrery and 3D Earth as laid out in a browser, at a phone's
// width and a desktop's: the pieces the UX pass moved, held where a person
// needs them. The logic half is tests/test_almanac_ux.cjs.
//
//   1. The orrery's tip lets the planets under it through: from Earth's tip
//      the pointer reaches Mars, and still reaches a tip's Fly button by
//      crossing the tip's text. On a phone its button is a finger's size.
//   2. The Earth view: a tapped satellite's card stands above the controls
//      however tall the note under them grows; the first-open hint stays
//      off the "You" dot; a place's dot sits on the place, whichever side
//      its label hangs, left to right or right to left; a tapped button does
//      not keep a hover look on a phone.
//
// Start a server first, on its own folders (no ZIMs needed):
//   ZIMI_TORRENT=0 ZIMI_OFFLINE=1 ZIM_DIR=/tmp/zimi-empty ZIMI_DATA_DIR=/tmp/zimi-empty-data \
//     python3 -m zimi serve --port 8877
// Run:
//   BASE_URL=http://localhost:8877 npx playwright test \
//     --config=tests/playwright.config.mjs --reporter=list tests/test_almanac_ux.spec.mjs

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:8877';
// The satellites route is stood in for below; a service worker's fetches
// would pass it by.
test.use({ serviceWorkers: 'block' });
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const SAN_FRANCISCO = { lat: 37.77, lon: -122.42, name: 'San Francisco' };
const DAY = 86400000;

async function openAlmanac(page, { lang } = {}) {
  await page.addInitScript(([lg, loc]) => {
    try {
      if (lg) localStorage.setItem('zimi_ui_lang', lg);
      sessionStorage.setItem('zimi_almanac_location', JSON.stringify(loc));
    } catch (e) { /* private window: the defaults do */ }
  }, [lang || '', SAN_FRANCISCO]);
  await page.goto(`${BASE}/#almanac`);
  await page.waitForFunction(() => typeof window.openAlmanacEarth === 'function' && document.getElementById('almanac-orrery'));
  // Hold the orrery at now (1x) so the planets stay put under the pointer.
  await page.evaluate(() => {
    _orrerySnapToNow();
    document.getElementById('almanac-orrery').scrollIntoView({ block: 'center' });
  });
  // On a phone the header steps aside as the page scrolls: wait for the
  // canvas to settle before aiming at a planet.
  let last = null;
  for (let i = 0; i < 40; i++) {
    const top = await page.evaluate(() => document.getElementById('almanac-orrery').getBoundingClientRect().top);
    if (top === last) break;
    last = top;
    await page.waitForTimeout(150);
  }
}

// A body's place on the page (CSS px).
function bodyAt(page, name) {
  return page.evaluate((n) => {
    const r = document.getElementById('almanac-orrery').getBoundingClientRect();
    const q = n === 'Sun' ? _orrerySunPos : _orreryPlanetPositions.find((p) => p.name === n);
    const s = _orreryWorldToScreen(q.x, q.y);
    return { x: r.left + s.x, y: r.top + s.y };
  }, name);
}
const tipName = (page) => page.evaluate(() => document.getElementById('orrery-tooltip').innerText.split('\n')[0]);

test.describe('the orrery', () => {
  test('its tip lets the planets under it through, and its button is still reached', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openAlmanac(page);
    // Earth's tip is placed among the inner planets; stand it on Mars.
    const earth = await bodyAt(page, 'Earth');
    await page.mouse.move(earth.x, earth.y);
    await expect(page.locator('#orrery-tooltip')).toBeVisible();
    await page.evaluate(() => {
      const tip = document.getElementById('orrery-tooltip');
      const r = document.getElementById('almanac-orrery').getBoundingClientRect();
      const mars = _orreryPlanetPositions.find((p) => p.name === 'Mars');
      const s = _orreryWorldToScreen(mars.x, mars.y);
      const w = tip.parentElement.getBoundingClientRect();
      tip.style.left = (r.left - w.left + s.x - 4) + 'px';
      tip.style.top = (r.top - w.top + s.y - 4) + 'px';
    });
    const mars = await bodyAt(page, 'Mars');
    await page.mouse.move(mars.x, mars.y, { steps: 4 });
    expect(await tipName(page)).toContain('Mars');

    // From Mars to its Fly button, slowly, across the tip's own text.
    const btn = await page.locator('#orrery-tooltip [data-orr-fly]').boundingBox();
    await page.mouse.move(btn.x + btn.width / 2, btn.y + btn.height / 2, { steps: 25 });
    await page.mouse.down();
    await page.mouse.up();
    expect(await page.evaluate(() => _orreryRockets.length && _orreryRockets[0].target)).toBe('Mars');
  });

  test('on a phone its Fly button and sliders are a finger\'s size', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await openAlmanac(page);
    const mars = await bodyAt(page, 'Mars');
    await page.touchscreen.tap(mars.x, mars.y);
    const btn = await page.locator('#orrery-tooltip [data-orr-fly]').boundingBox();
    expect(btn.height).toBeGreaterThanOrEqual(32);
    const slider = await page.locator('#orrery-slider').boundingBox();
    expect(slider.height).toBeGreaterThanOrEqual(24);
    await ctx.close();
  });
});

// The view, opened at now with the satellites the server has.
async function openEarth(page) {
  await page.evaluate(() => window.openAlmanacEarth());
  await page.waitForFunction(() => _ae && _ae.gl && _ae.scene && _ae.sats && _ae.positions.length > 0, null, { timeout: 20000 });
}

// The dot of a place label against where the place projects.
function markOffset(page, id, latlon) {
  return page.evaluate(([id, ll]) => {
    const sc = _ae.scene;
    const p = _aeProject(_aeFixedToScene(_aeGeodeticToFixed(ll.lat, ll.lon), sc.gast));
    const c = document.getElementById('ae-canvas').getBoundingClientRect();
    const m = document.querySelector('#' + id + ' .ae-mark').getBoundingClientRect();
    return Math.hypot(m.left + m.width / 2 - (c.left + p.x), m.top + m.height / 2 - (c.top + p.y));
  }, [id, latlon]);
}

for (const lang of ['', 'he']) {
  test(`the Earth view on a phone${lang ? ' (' + lang + ')' : ''}: card, hint and the You dot`, async ({ browser }) => {
    test.setTimeout(120000);   // software WebGL: the first open builds the scene and loads the maps
    // "You" is the device's own position, shown when asked for (Show where I am).
    const ctx = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true, serviceWorkers: 'block',
      geolocation: { latitude: SAN_FRANCISCO.lat, longitude: SAN_FRANCISCO.lon }, permissions: ['geolocation'] });
    const page = await ctx.newPage();
    // ISS data three weeks old: the note under the controls grows a second line.
    await page.route('**/almanac-satellites', async (route) => {
      const res = await route.fetch();
      const data = await res.json();
      data.iss = Object.assign({}, data.iss, { EPOCH: new Date(Date.now() - 21 * DAY).toISOString().replace('Z', '') });
      await route.fulfill({ response: res, json: data });
    });
    await openAlmanac(page, { lang });
    await openEarth(page);
    await page.locator('#ae-locate').tap();
    await expect(page.locator('#ae-lbl-you')).toBeVisible();
    await page.waitForTimeout(1500);   // the turn to face it

    // The first-open hint stands clear of the You dot at the middle.
    const hint = await page.locator('#ae-hint').boundingBox();
    const you = await page.locator('#ae-lbl-you').boundingBox();
    expect(you, 'the You label is shown').not.toBeNull();
    expect(hint.y >= you.y + you.height || hint.y + hint.height <= you.y).toBe(true);

    // The dot sits on the place, whichever way the label hangs.
    expect(await markOffset(page, 'ae-lbl-you', SAN_FRANCISCO)).toBeLessThan(2);
    for (const turn of [0.05, -0.1]) {
      await page.evaluate((d) => { _aeTurnBy(d, 0); }, turn);
      await page.waitForTimeout(400);
      if (await page.locator('#ae-lbl-you').isVisible()) {
        expect(await markOffset(page, 'ae-lbl-you', SAN_FRANCISCO)).toBeLessThan(2);
      }
    }

    // A tapped satellite's card stands above the controls.
    await page.evaluate(() => {
      const p = _ae.positions.find((q) => !_ae.sats.list[q.idx].iss);
      _ae.selected = { norad: _ae.sats.list[p.idx].omm.NORAD_CAT_ID, tapMs: _aeDisplayMs() };
      _aeRenderCard();
    });
    await expect(page.locator('#ae-card')).toBeVisible();
    // The ISS's orbit-only line makes the note two lines (it was one that
    // the card's fixed offset had been measured against).
    await expect.poll(async () => (await page.locator('.ae-note').boundingBox()).height).toBeGreaterThan(20);
    const card = await page.locator('#ae-card').boundingBox();
    const views = await page.locator('#ae-views').boundingBox();
    expect(card.y + card.height).toBeLessThanOrEqual(views.y - 4);
    expect(card.y).toBeGreaterThan(0);

    // A tapped button keeps no hover look (it read as pressed).
    const idle = await page.locator('[data-ae-speed="60"]').evaluate((b) => getComputedStyle(b).backgroundColor);
    // (A software-rendered WebGL frame can be slow on a busy machine, and a
    // tap waits for the button to hold still across frames.)
    await page.locator('#ae-eclipse').tap({ timeout: 30000 });
    await page.waitForTimeout(300);
    const tapped = await page.locator('#ae-eclipse').evaluate((b) => getComputedStyle(b).backgroundColor);
    expect(tapped).toBe(idle);
    await ctx.close();
  });
}

// ── Eric's review on his phone, 2026-09-29 ──
// 3. Earth opening in 3D, and 5. a planet flying, are said under the orrery
//    until each has been done once, and Earth sends out a ring; a finger
//    reaches a planet a few pixels off, and the nearest body wins (the Sun's
//    margin swallowed Mercury). The tip's Fly there is filled and its width.
// 4. Away from now, Now stands lit under the date, the eclipse line below it.
// And "You" is drawn only where the device says it is, once asked.

const phoneCtx = (browser, extra) => browser.newContext(Object.assign({ viewport: PHONE, hasTouch: true, isMobile: true, serviceWorkers: 'block' }, extra || {}));
const hintText = (page) => page.evaluate(() => { const h = document.getElementById('orrery-hint'); return h.hidden ? '' : h.textContent; });

test.describe('what a tap on the orrery does', () => {
  test('on a phone it is said, until done, and Earth glows still', async ({ browser }) => {
    const ctx = await phoneCtx(browser);
    const page = await ctx.newPage();
    await openAlmanac(page);
    const fly = await page.evaluate(() => t('alm_orr_hint_fly'));
    const earth = await page.evaluate(() => t('alm_orr_hint_earth'));
    await expect(page.locator('#orrery-hint')).toBeVisible();
    expect(await hintText(page)).toBe(fly + ' · ' + earth);
    // Just under the orrery, on the screen.
    const hint = await page.locator('#orrery-hint').boundingBox();
    const orr = await page.locator('#almanac-orrery').boundingBox();
    expect(hint.y).toBeGreaterThanOrEqual(orr.y + orr.height - 1);
    expect(hint.x).toBeGreaterThanOrEqual(0);
    expect(hint.x + hint.width).toBeLessThanOrEqual(PHONE.width);
    // Earth's glow is still: the same pixels a moment apart (no breath, no
    // beacon; the hero Moon is the main way into the 3D view now).
    expect(await page.evaluate(() => !_orreryTried().earth)).toBe(true);
    const glowAt = () => page.evaluate(() => {
      const cv = document.getElementById('almanac-orrery'), d = _orreryDpr;
      _drawOrrery(cv, d);
      const p = _orreryPlanetPositions.find((x) => x.name === 'Earth');
      const s = _orreryWorldToScreen(p.x, p.y), r = Math.ceil(p.glowR * 1.2);
      return Array.from(cv.getContext('2d').getImageData((s.x - r) * d, (s.y - r) * d, 2 * r * d, 2 * r * d).data).join(',');
    });
    const glow0 = await glowAt();
    await page.waitForTimeout(900);
    expect(await glowAt()).toBe(glow0);

    // Earth opened once: that part goes, and stays gone.
    const e = await bodyAt(page, 'Earth');
    await page.touchscreen.tap(e.x, e.y);
    await page.waitForFunction(() => typeof _aeIsOpen !== 'undefined' && _aeIsOpen);
    await page.evaluate(() => _aeClose());
    expect(await hintText(page)).toBe(fly);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('zimi_orrery_tried')))).toEqual({ earth: 1 });

    // A flight: nothing left to say, now or on the next visit.
    await page.evaluate(() => _orrerySnapToNow());
    const m = await bodyAt(page, 'Mars');
    await page.touchscreen.tap(m.x, m.y);
    await page.locator('#orrery-tooltip [data-orr-fly]').tap();
    expect(await page.evaluate(() => _orreryRockets.length && _orreryRockets[0].target)).toBe('Mars');
    await expect(page.locator('#orrery-hint')).toBeHidden();
    await page.reload();
    await page.waitForFunction(() => document.getElementById('almanac-orrery') && typeof window.openAlmanacEarth === 'function');
    await expect(page.locator('#orrery-hint')).toBeHidden();
    await ctx.close();
  });

  test('with a mouse the line is not shown: hovering says it', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openAlmanac(page);
    await expect(page.locator('#orrery-hint')).toBeHidden();
  });

  test('a finger reaches a planet a little off it, and the nearest body wins', async ({ browser }) => {
    const ctx = await phoneCtx(browser);
    const page = await ctx.newPage();
    await openAlmanac(page);
    // Beside Mars, off its disc by more than the old reach.
    const m = await bodyAt(page, 'Mars');
    const marsR = await page.evaluate(() => _orreryPlanetPositions.find((p) => p.name === 'Mars').r * _orreryCam.zoom);
    await page.touchscreen.tap(m.x + marsR + 16, m.y);
    expect(await tipName(page)).toContain(await page.evaluate(() => _tp('Mars')));
    await page.touchscreen.tap(5, 300);
    // Just outside Mercury, toward the Sun: Mercury's, not the Sun's.
    const at = await page.evaluate(() => {
      const r = document.getElementById('almanac-orrery').getBoundingClientRect();
      const q = _orreryPlanetPositions.find((p) => p.name === 'Mercury'), s = _orrerySunPos;
      const d = Math.hypot(s.x - q.x, s.y - q.y), k = (q.r + 3) / d;
      const w = { x: q.x + (s.x - q.x) * k, y: q.y + (s.y - q.y) * k };
      const scr = _orreryWorldToScreen(w.x, w.y);
      return { x: r.left + scr.x, y: r.top + scr.y, sunGap: (Math.hypot(w.x - s.x, w.y - s.y) - s.r) * _orreryCam.zoom };
    });
    expect(at.sunGap).toBeLessThan(14);   // inside the Sun's old margin
    await page.touchscreen.tap(at.x, at.y);
    expect(await tipName(page)).toContain(await page.evaluate(() => _tp('Mercury')));
    await ctx.close();
  });

  test('the tip on a phone is whole, and Fly there is its loudest thing', async ({ browser }) => {
    const ctx = await phoneCtx(browser);
    const page = await ctx.newPage();
    await openAlmanac(page);
    for (const name of ['Mars', 'Jupiter', 'Venus', 'Neptune']) {
      const b = await bodyAt(page, name);
      await page.touchscreen.tap(b.x, b.y);
      const tip = await page.locator('#orrery-tooltip').boundingBox();
      const wrap = await page.locator('.almanac-orrery-wrap').boundingBox();
      expect(tip.x).toBeGreaterThanOrEqual(wrap.x);
      expect(tip.x + tip.width).toBeLessThanOrEqual(wrap.x + wrap.width + 0.5);
      expect(tip.y).toBeGreaterThanOrEqual(wrap.y);
      expect(tip.y + tip.height).toBeLessThanOrEqual(wrap.y + wrap.height + 0.5);
      const btn = page.locator('#orrery-tooltip [data-orr-fly]');
      const bb = await btn.boundingBox();
      expect(bb.height).toBeGreaterThanOrEqual(40);
      expect(bb.width).toBeGreaterThan(tip.width * 0.8);
      const look = await btn.evaluate((el) => { const s = getComputedStyle(el); return [s.backgroundColor, s.color]; });
      expect(look[0]).not.toBe('rgba(0, 0, 0, 0)');
      expect(look[1]).toBe('rgb(0, 0, 0)');
      await page.touchscreen.tap(5, 300);   // off the orrery: the tip goes
    }
    await ctx.close();
  });
});

test.describe('the Earth view', () => {
  for (const size of [PHONE, DESKTOP]) {
    test(`away from now, Now is lit under the date (${size.width}px)`, async ({ browser }) => {
      test.setTimeout(120000);
      const ctx = await browser.newContext({ viewport: size, serviceWorkers: 'block' });
      const page = await ctx.newPage();
      await openAlmanac(page);
      await openEarth(page);
      await expect(page.locator('#ae-now')).toBeHidden();
      await page.locator('#ae-eclipse').click();
      await expect(page.locator('#ae-now')).toBeVisible();
      const date = await page.locator('#ae-when b').boundingBox();
      const now = await page.locator('#ae-now').boundingBox();
      expect(now.y).toBeGreaterThanOrEqual(date.y + date.height);
      expect(now.y - (date.y + date.height)).toBeLessThan(16);
      expect(now.x + now.width).toBeGreaterThan(date.x);
      expect(date.height).toBeLessThan(24);   // the date keeps one line
      const look = await page.locator('#ae-now').evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]);
      expect(look[1]).toBe('rgb(0, 0, 0)');
      expect(look[0]).not.toMatch(/rgba\(18, 18, 20/);
      // The eclipse line stands below it, not under it.
      await expect(page.locator('#ae-status')).not.toBeEmpty();
      const status = await page.locator('#ae-status').boundingBox();
      expect(status.y).toBeGreaterThanOrEqual(now.y + now.height);
      await page.locator('#ae-now').click();
      await expect(page.locator('#ae-now')).toBeHidden();
      await ctx.close();
    });
  }

  test('"You" only where the device says, and only when asked', async ({ browser }) => {
    test.setTimeout(120000);
    const LONDON = { lat: 51.5, lon: -0.12 };
    const ctx = await phoneCtx(browser, { geolocation: { latitude: LONDON.lat, longitude: LONDON.lon }, permissions: ['geolocation'] });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.__geo = 0;
      const g = navigator.geolocation;
      for (const f of ['getCurrentPosition', 'watchPosition']) {
        const orig = g[f].bind(g);
        g[f] = function () { window.__geo++; return orig.apply(null, arguments); };
      }
    });
    await openAlmanac(page);   // with a city stored for the Almanac
    await openEarth(page);
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => window.__geo), 'opening asks nothing').toBe(0);
    await expect(page.locator('#ae-lbl-you'), 'a chosen city is not "You"').toBeHidden();

    await page.locator('#ae-locate').tap();
    await expect(page.locator('#ae-lbl-you')).toBeVisible();
    expect(await page.evaluate(() => window.__geo)).toBe(1);
    await expect(page.locator('#ae-locate')).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(1500);
    expect(await markOffset(page, 'ae-lbl-you', LONDON)).toBeLessThan(2);
    // Again: hidden, and nothing asked.
    await page.locator('#ae-locate').tap();
    await expect(page.locator('#ae-lbl-you')).toBeHidden();
    expect(await page.evaluate(() => window.__geo)).toBe(1);
    await ctx.close();

    // Denied: nothing drawn, and the hint says so.
    const denied = await phoneCtx(browser);
    const p2 = await denied.newPage();
    await openAlmanac(p2);
    await openEarth(p2);
    await p2.evaluate(() => {
      navigator.geolocation.getCurrentPosition = (ok, fail) => setTimeout(() => fail({ code: 1 }), 10);
    });
    await p2.locator('#ae-locate').tap();
    await expect(p2.locator('#ae-hint')).toHaveText(await p2.evaluate(() => t('alm_earth_where_unknown')));
    await expect(p2.locator('#ae-hint')).toHaveClass(/ae-show/);
    await expect(p2.locator('#ae-lbl-you')).toBeHidden();
    await expect(p2.locator('#ae-locate')).toHaveAttribute('aria-pressed', 'false');
    await denied.close();
  });
});
