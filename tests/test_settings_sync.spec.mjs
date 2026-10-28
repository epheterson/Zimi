// Settings follow the account (Eric, 2026-10-21: "Things a user changes while
// signed in should sync to all sessions all browsers"), on users.py's
// convention. Two browsers signed in to one account: a setting changed in one
// is in the other, for the admin and for a named user, and two browsers
// changing different settings keep both. A browser that changed nothing sends
// nothing, and boot waits on none of it. A second account on the same browser
// is never handed the first one's changes. The admin's saved things are its
// own and leave with it. With the password switched off nobody has an account
// and nothing is asked for.
//
// Start it on a brand-new data dir (beforeAll sets the password and users):
//   ZIM_DIR=<a few zims> ZIMI_DATA_DIR=<fresh dir> ZIMI_MANAGE=1 \
//     ZIMI_TORRENT=0 ZIMI_OFFLINE=1 python3 -m zimi serve --port 9701
//   BASE_URL=http://localhost:9701 npx playwright test \
//     --config=tests/playwright.config.mjs tests/test_settings_sync.spec.mjs

import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });
test.describe.configure({ mode: 'serial' });
const BASE = process.env.BASE_URL || 'http://localhost:9701';
const ADMIN_PW = 'sync-admin-pw';
const USER = 'reader';
const USER_PW = 'reader-pw';
const FRESH = 'fresh';

// Each browser keeps its own session: two per account, signed in once here
// (sign-ins are rate limited), each test's browsers made from them.
const states = {};
async function signIn(browser, who) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const res = await page.request.post(`${BASE}/login`, {
    headers: { 'Content-Type': 'application/json' },
    data: { username: who === 'admin' ? 'admin' : who, password: who === 'admin' ? ADMIN_PW : USER_PW, remember: true },
  });
  expect(res.status(), await res.text()).toBe(200);
  const j = await res.json();
  await page.goto(BASE);
  if (who === 'admin') await page.evaluate((tok) => { localStorage.setItem('zimi_manage_token', tok); }, j.token);
  const state = await context.storageState();
  await context.close();
  return state;
}

test.beforeAll(async ({ request, browser }) => {
  await request.post(`${BASE}/manage/set-password`, {
    headers: { 'Content-Type': 'application/json' },
    data: { password: ADMIN_PW },
  });
  const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ADMIN_PW };
  for (const name of [USER, FRESH]) {
    await request.post(`${BASE}/manage/users`, { headers: auth, data: { action: 'create', name, password: USER_PW } });
  }
  for (const who of ['admin', USER]) states[who] = [await signIn(browser, who), await signIn(browser, who), await signIn(browser, who)];
  states[FRESH] = [await signIn(browser, FRESH)];
});

// Browser ``slot`` of ``who``, on the home page, signed in.
async function signedIn(browser, who, slot) {
  const context = await browser.newContext({ storageState: states[who][slot] });
  const page = await context.newPage();
  await page.goto(BASE);
  await page.waitForFunction(() => typeof _savedSignedIn === 'function' && _savedSignedIn());
  return { context, page };
}
const account = (page) => page.evaluate(async () => (await (await fetch('/userdata/settings', { credentials: 'same-origin' })).json()).settings || {});
const value = async (page, k) => ((await account(page))[k] || {}).v;
const raw = (page, k) => page.evaluate((key) => localStorage.getItem(key), k);
// Comes back to the tab: the account's copy is fetched again.
const refocus = (page) => page.evaluate(() => { _savedPulledAt = 0; document.dispatchEvent(new Event('visibilitychange')); });

for (const who of ['admin', USER]) {
  test(`${who}: a setting changed in one browser is in the other, and the page follows it`, async ({ browser }) => {
    const a = await signedIn(browser, who, 0);
    const b = await signedIn(browser, who, 1);
    await a.page.evaluate(() => { _setPrefLanguages(['en', 'es']); _setReaderTheme('sepia'); });
    await expect.poll(() => value(a.page, 'zimi_pref_languages'), { timeout: 10000 }).toBe('["en","es"]');
    await refocus(b.page);
    await expect.poll(() => raw(b.page, 'zimi_pref_languages'), { timeout: 10000 }).toBe('["en","es"]');
    expect(await raw(b.page, 'zimi_reader_theme')).toBe('sepia');
    expect(await b.page.evaluate(() => _getPrefLanguages())).toEqual(['en', 'es']);
    await b.page.reload();
    expect(await b.page.evaluate(() => _getPrefLanguages())).toEqual(['en', 'es']);
    await a.context.close(); await b.context.close();
  });

  test(`${who}: two browsers changing different settings keep both`, async ({ browser }) => {
    const a = await signedIn(browser, who, 0);
    const b = await signedIn(browser, who, 1);
    await a.page.evaluate(() => _setLibraryView('tiles'));
    await b.page.evaluate(() => _setReaderFontStep(3));
    const font = await b.page.evaluate(() => String(READER_FONT_LEVELS[3]));
    await expect.poll(async () => [await value(a.page, 'zimi_library_view'), await value(a.page, 'zimi_reader_font_scale')], { timeout: 10000 }).toEqual(['tiles', font]);
    await refocus(a.page); await refocus(b.page);
    await expect.poll(() => raw(a.page, 'zimi_reader_font_scale'), { timeout: 10000 }).toBe(font);
    await expect.poll(() => raw(b.page, 'zimi_library_view'), { timeout: 10000 }).toBe('tiles');
    await a.context.close(); await b.context.close();
  });
}

test('live: a change reaches the other open browser while it stays on the page, and the one that made it re-reads nothing', async ({ browser }) => {
  const a = await signedIn(browser, USER, 0);
  const b = await signedIn(browser, USER, 1);
  // Each page holds its stream before anything changes.
  for (const x of [a, b]) await x.page.waitForFunction(() => _liveSource && _liveSource.readyState === 1 && _liveSince);
  const reads = [];
  a.page.on('request', (r) => { const u = new URL(r.url()); if (r.method() === 'GET' && u.pathname.startsWith('/userdata')) reads.push(u.pathname); });
  await a.page.evaluate(() => _setReaderTheme('dark'));
  // No refocus: the open page hears it.
  await expect.poll(() => raw(b.page, 'zimi_reader_theme'), { timeout: 10000 }).toBe('dark');
  await a.page.evaluate(() => { Saved.save({ zim: 'w', path: 'A/Live', title: 'Saved while the other watched' }); return _savedFlush(); });
  await expect.poll(() => b.page.evaluate(() => Saved.all().map((i) => i.title)), { timeout: 10000 }).toContain('Saved while the other watched');
  await a.page.waitForTimeout(1500);
  expect(reads, 'its own changes are not read back').toEqual([]);
  await a.context.close(); await b.context.close();
});

test('live: a page that was hidden hears what changed meanwhile as it shows again', async ({ browser }) => {
  const a = await signedIn(browser, USER, 0);
  const b = await signedIn(browser, USER, 1);
  await b.page.waitForFunction(() => _liveSource && _liveSince);
  // Hidden: the stream closes (a phone in a pocket holds nothing open).
  await b.page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  expect(await b.page.evaluate(() => _liveSource)).toBe(null);
  await a.page.evaluate(() => _setLibraryView('list'));
  await expect.poll(() => value(a.page, 'zimi_library_view'), { timeout: 10000 }).toBe('list');
  // Shown again before the pull-on-return interval: the stream resumes from
  // its place and the change arrives through it.
  await b.page.evaluate(() => { _savedPulledAt = Date.now(); Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => raw(b.page, 'zimi_library_view'), { timeout: 10000 }).toBe('list');
  await a.context.close(); await b.context.close();
});

test('the interface language and the reading speed follow, into the page that is open', async ({ browser }) => {
  const a = await signedIn(browser, USER, 0);
  const b = await signedIn(browser, USER, 1);
  await a.page.evaluate(() => { setLanguage('es'); _setStorageJSON(SK.TTS_RATE, 1.5); });
  await expect.poll(() => value(a.page, 'zimi_ui_lang'), { timeout: 10000 }).toBe('es');
  await refocus(b.page);
  await expect.poll(() => b.page.evaluate(() => document.documentElement.lang), { timeout: 10000 }).toBe('es');
  expect(await b.page.evaluate(() => _ttsRate())).toBe(1.5);
  await a.page.evaluate(() => setLanguage('en'));
  await expect.poll(() => value(a.page, 'zimi_ui_lang'), { timeout: 10000 }).toBe('en');
  await a.context.close(); await b.context.close();
});

test('a browser that changed nothing sends nothing, and boot waits on none of it', async ({ browser }) => {
  const context = await browser.newContext({ storageState: states[FRESH][0] });
  const page = await context.newPage();
  const seen = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/userdata') || u.pathname === '/list') seen.push([u.pathname, r.method()]); });
  await page.goto(BASE);
  await page.waitForFunction(() => _savedSignedIn());
  await page.waitForTimeout(3500); // past the push's wait
  expect(await account(page)).toEqual({});
  expect(seen.filter((s) => s[1] === 'POST'), 'nothing goes up').toHaveLength(0);
  const firstList = seen.findIndex((s) => s[0] === '/list'), firstData = seen.findIndex((s) => s[0].startsWith('/userdata'));
  expect(firstData, 'the account is fetched once the page is up').toBeGreaterThan(firstList);
  await context.close();
});

test('a second account on this browser is never handed the first one\'s changes', async ({ browser }) => {
  const a = await signedIn(browser, USER, 2);
  // a change that never got out (the server out of reach) when the next
  // account takes over this browser
  await a.page.route('**/userdata/settings', (route) => route.abort());
  await a.page.evaluate(() => _setReaderFamily('sans'));
  expect(await a.page.evaluate(() => _prefState().pending.zimi_reader_family)).toBe(1);
  await a.page.goto('about:blank');
  await a.page.unroute('**/userdata/settings');
  const fresh = states[FRESH][0].cookies.filter((c) => c.name === 'zimi_session');
  await a.context.addCookies(fresh);
  await a.page.goto(BASE);
  await a.page.waitForFunction(() => _savedSignedIn());
  await a.page.waitForTimeout(3500);
  expect(await a.page.evaluate(() => _prefState())).toEqual({ owner: 'fresh', pending: {}, seeded: true });
  expect(await value(a.page, 'zimi_reader_family'), 'the first account\'s change is not the second\'s').toBeUndefined();
  await a.context.close();
});

test('a tab left on one account never sends its things into the next one\'s', async ({ browser }) => {
  // Two tabs of one browser on the reader's account; the session becomes
  // another account's underneath the second (a sign-in elsewhere).
  const context = await browser.newContext({ storageState: states[USER][2] });
  const one = await context.newPage(), two = await context.newPage();
  for (const p of [one, two]) { await p.goto(BASE); await p.waitForFunction(() => typeof _savedSignedIn === 'function' && _savedSignedIn()); }
  await context.addCookies(states[FRESH][0].cookies.filter((c) => c.name === 'zimi_session'));
  // the second tab, still on the reader's account, saves and sends
  await two.evaluate(() => { Saved.save({ zim: 'w', path: 'A/Stale', title: 'From a stale tab' }); return _savedFlush(); });
  await expect.poll(() => two.evaluate(() => _accountId), { timeout: 10000 }).toBe('fresh');
  const freshSaved = await two.evaluate(async () => Object.values(((await (await fetch('/userdata?account=fresh')).json()).saved || {}).items || {}).map((i) => i.title));
  expect(freshSaved, 'refused (409), not written into the next account').not.toContain('From a stale tab');
  // the first tab learns from the second's switch at once (the storage event)
  await expect.poll(() => one.evaluate(() => _accountId), { timeout: 5000 }).toBe('fresh');
  await context.close();
});

test('the admin\'s saved things are its own, and leave with it', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(BASE);
  await page.evaluate(() => Saved.save({ zim: 'w', path: 'A/Anon', title: 'Saved signed out' }));
  const res = await page.request.post(`${BASE}/login`, { headers: { 'Content-Type': 'application/json' }, data: { username: 'admin', password: ADMIN_PW, remember: true } });
  const tok = (await res.json()).token;
  await page.evaluate((t) => localStorage.setItem('zimi_manage_token', t), tok);
  await page.reload();
  await page.waitForFunction(() => _savedSignedIn());
  expect(await page.evaluate(() => Saved.all().map((i) => i.title)), 'signed in, the signed-out things are not the admin\'s').not.toContain('Saved signed out');
  expect(await page.evaluate(() => Saved.legacyOffered() && Saved.offerKind()), 'they are offered instead').toBe('signedout');
  await page.evaluate(() => Saved.save({ zim: 'w', path: 'A/Admin', title: 'Saved as admin' }));
  await page.evaluate(() => _savedFlush());
  const kept = await page.evaluate(async () => Object.values(((await (await fetch('/userdata')).json()).saved || {}).items || {}).map((i) => i.title));
  expect(kept).toContain('Saved as admin');
  expect(kept, 'nothing saved signed out went to the admin\'s account').not.toContain('Saved signed out');
  await page.evaluate(() => manageLogout());
  await page.waitForURL(BASE + '/');
  await page.waitForFunction(() => typeof _savedSignedIn === 'function' && !_savedSignedIn());
  const after = await page.evaluate(() => ({ titles: Saved.all().map((i) => i.title), keys: Object.keys(localStorage).filter((k) => k.startsWith('zimi_saved') && k.includes(':admin')) }));
  expect(after.titles, 'signed out, the admin\'s things are gone from this browser').not.toContain('Saved as admin');
  expect(after.titles).toContain('Saved signed out');
  expect(after.keys).toEqual([]);
  await context.close();
});

test('signed out, nothing goes to any account and the browser keeps its settings', async ({ browser }) => {
  const a = await signedIn(browser, USER, 0);
  await a.page.evaluate(() => _setReaderTheme('light'));
  await expect.poll(() => value(a.page, 'zimi_reader_theme'), { timeout: 10000 }).toBe('light');
  await a.page.evaluate(() => userLogout());
  await a.page.waitForURL(BASE + '/');
  await a.page.waitForFunction(() => typeof _savedSignedIn === 'function' && !_savedSignedIn());
  expect(await raw(a.page, 'zimi_reader_theme')).toBe('light');
  await a.page.evaluate(() => _setReaderTheme('dark'));
  expect(await a.page.evaluate(() => _prefState())).toEqual({ owner: null, pending: {}, seeded: true });
  await a.context.close();
});

// Last: it switches the password off.
test('with the password switched off every browser is the admin\'s, and they sync', async ({ browser, request }) => {
  const off = await request.post(`${BASE}/manage/access`, {
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ADMIN_PW },
    data: { require_password: false, open_confirm: true, current_password: ADMIN_PW },
  });
  expect(off.status(), await off.text()).toBe(200);
  const open = async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const bad = [];
    page.on('response', (r) => { if (new URL(r.url()).pathname.startsWith('/userdata') && !r.ok()) bad.push(r.status() + ' ' + r.url()); });
    await page.goto(BASE);
    await page.waitForFunction(() => typeof _savedSignedIn === 'function' && _savedSignedIn());
    return { context, page, bad };
  };
  const a = await open(), b = await open();
  const me = await a.page.evaluate(async () => (await fetch('/whoami')).json());
  expect(me.role).toBe('admin');
  expect(me.account).toBe('admin');
  await a.page.evaluate(() => _setLibrarySort('size'));
  await expect.poll(() => value(a.page, 'zimi_library_sort'), { timeout: 10000 }).toBe('size');
  await refocus(b.page);
  await expect.poll(() => raw(b.page, 'zimi_library_sort'), { timeout: 10000 }).toBe('size');
  await a.page.evaluate(() => { Saved.save({ zim: 'w', path: 'A/Open', title: 'Kept with the password off' }); return _savedFlush(); });
  await refocus(b.page);
  await expect.poll(() => b.page.evaluate(() => Saved.all().map((i) => i.title)), { timeout: 10000 }).toContain('Kept with the password off');
  for (const x of [a, b]) {
    expect(await x.page.evaluate(() => _savedBehind), 'nothing reports being behind').toBe(false);
    expect(x.bad, 'no /userdata request fails').toEqual([]);
  }
  await a.context.close(); await b.context.close();
});
