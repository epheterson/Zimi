// The Create page, round 3: one shared panel, per-mode state that survives a
// switch, the live progress visualization, the done moment, and the two states
// that used to be a spinner forever (a server restart, a queued job).
//
// Round 2's complaint list, from Eric's field test, is the test plan:
//   "all the sections have the same Title and Advanced"      → one panel
//   "closing and opening one clears the stuff that was there" → state survives
//   "the tiny create button is right next to opening the next one" → geometry
//   "a better eye on progress instead of only spinner and text logs" → the viz
//   "the folder flow feels sketchy"                          → the tile is gone
//
// The crawl tests drive a REAL job against a fixture site this file serves
// itself, so the tree, the counters and the done card are built from the
// server's own events rather than from a fixture of what they might look like.
// The states that need a server to misbehave (a restart mid-job, a queue, an
// old build with no events at all) are driven by intercepting the status poll.
//
// Start a server first:
//   ZIM_DIR=/tmp/zimi-create-test python3 -m zimi serve --port 8892
// Run:
//   BASE_URL=http://localhost:8892 npx playwright test \
//     --config=tests/playwright.config.mjs tests/test_create_flow.spec.mjs

import { test, expect } from '@playwright/test';
import http from 'node:http';

const BASE = process.env.BASE_URL || 'http://localhost:8892';

// ── the fixture site ────────────────────────────────────────────────────────
// Three sections, each with an index and a few pages, so a crawl of it has a
// real shape to draw rather than a flat list of one.

const SECTIONS = {
  docs: ['install', 'configure', 'upgrade'],
  blog: ['hello-world', 'release-notes'],
  guides: ['offline'],
};

function fixturePage(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<title>${title}</title><link rel="stylesheet" href="/style.css"></head>` +
    `<body><h1>${title}</h1>${body}</body></html>`;
}

let fixture;
let fixtureUrl;

test.beforeAll(async () => {
  fixture = http.createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (path === '/style.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('body{font-family:sans-serif}\n');
      return;
    }
    let body = null;
    if (path === '/') {
      body = fixturePage('Fixture Site', Object.keys(SECTIONS)
        .map(s => `<a href="/${s}/">${s}</a>`).join(' '));
    }
    for (const [section, names] of Object.entries(SECTIONS)) {
      if (path === `/${section}/`) {
        body = fixturePage(section, names
          .map(n => `<a href="/${section}/${n}.html">${n}</a>`).join(' '));
      }
      for (const name of names) {
        if (path === `/${section}/${name}.html`) body = fixturePage(name, '<p>Fixture.</p>');
      }
    }
    if (body === null) { res.writeHead(404); res.end('no'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;
});

// A second fixture whose ASSETS are slow, and where every page carries its own.
// This is the shape that produced Eric's hang: the site engine's write pass
// fetches each page's images behind what used to be a single line of output, so
// packaging was the longest phase and the one that looked frozen. Slow assets
// are the only way to hold the Package step on screen long enough to prove the
// counter moves.
const SLOW_SECTIONS = ['docs', 'blog'];
const SLOW_PER_SECTION = 28;
const SLOW_ASSET_MS = 120;
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
  '1f15c4890000000d4944415478da63f8ffff3f0005fe02fea6b7d3e400' +
  '00000049454e44ae426082', 'hex');

let slowFixture;
let slowUrl;

test.beforeAll(async () => {
  slowFixture = http.createServer(async (req, res) => {
    const path = (req.url || '/').split('?')[0];
    const html = body => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    if (path.startsWith('/img/')) {
      await new Promise(r => setTimeout(r, SLOW_ASSET_MS));   // the whole point
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG);
      return;
    }
    const fig = name => `<p><img src="/img/${name}.png" alt="fig"></p>`;
    if (path === '/') {
      html(fixturePage('Slow Fixture',
        SLOW_SECTIONS.map(s => `<a href="/${s}/">${s}</a>`).join(' ') + fig('home')));
      return;
    }
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 1 && SLOW_SECTIONS.includes(parts[0])) {
      const rows = Array.from({ length: SLOW_PER_SECTION }, (_, n) =>
        `<a href="/${parts[0]}/p${n}.html">${n}</a>`).join(' ');
      html(fixturePage(parts[0], rows + fig(parts[0])));
      return;
    }
    if (parts.length === 2 && SLOW_SECTIONS.includes(parts[0])) {
      const name = parts[1].replace(/\.html$/, '');
      html(fixturePage(`${parts[0]} ${name}`, '<p>Fixture.</p>' + fig(parts[0] + '-' + name)));
      return;
    }
    res.writeHead(404); res.end('no');
  });
  await new Promise(resolve => slowFixture.listen(0, '127.0.0.1', resolve));
  slowUrl = `http://127.0.0.1:${slowFixture.address().port}/`;
});

test.afterAll(async () => {
  await new Promise(resolve => fixture.close(resolve));
  await new Promise(resolve => slowFixture.close(resolve));
});

// ── helpers ─────────────────────────────────────────────────────────────────

// Open Create and wait for the first status poll to have landed. openCreate()
// lazy-loads the module, so nothing on the page exists until it has.
async function openCreate(page) {
  await page.goto(BASE);
  await page.waitForFunction(() => typeof window.openCreate === 'function');
  await page.evaluate(() => window.openCreate());
  // Attached, not visible: when the server already has a job running, the
  // picker is hidden behind the run pane and that is the correct state.
  await page.waitForSelector('.create-chip', { state: 'attached' });
  await page.waitForFunction(() => window._createStatus !== undefined);
}

async function pickMode(page, mode) {
  await page.evaluate(m => window._createSelectMode(m), mode);
  await page.waitForFunction(m => window._createSelected === m, mode);
}

async function fieldValue(page, id) {
  return page.evaluate(i => {
    const el = document.getElementById(i);
    return el ? el.value : null;
  }, id);
}

// Start a crawl of the fixture site and wait for the job to finish.
async function runFixtureCrawl(page, { title = '', maxPages = 10 } = {}) {
  await pickMode(page, 'site');
  await page.fill('#create-source', fixtureUrl);
  await page.fill('#create-max-pages', String(maxPages));
  if (title) await page.fill('#create-title', title);
  await page.click('#create-start');
  await page.waitForFunction(() => window._createStatus && window._createStatus.active,
    null, { timeout: 15000 });
  await page.waitForFunction(() => window._createStatus && window._createStatus.done,
    null, { timeout: 120000 });
}

// ── D1: one panel, and the state that survives a switch ─────────────────────

test.describe('the shared panel', () => {
  test('there is exactly one Title field and one Advanced disclosure', async ({ page }) => {
    await openCreate(page);
    // Round 2 rendered these per mode; six copies of one control is the
    // complaint this layout exists to answer.
    for (const mode of ['page', 'site', 'video', 'import']) {
      await pickMode(page, mode);
      await expect(page.locator('#create-title')).toHaveCount(1);
      await expect(page.locator('.create-panel')).toHaveCount(1);
      expect(await page.locator('.create-adv').count()).toBeLessThanOrEqual(1);
    }
  });

  test('the chips are a selector, not six stacked forms', async ({ page }) => {
    await openCreate(page);
    // One chip per usable mode, and exactly one of them lit at any moment.
    const chips = await page.locator('.create-chip').count();
    expect(chips).toBeGreaterThanOrEqual(4);
    await expect(page.locator('.create-chip.active')).toHaveCount(1);
    await pickMode(page, 'video');
    await expect(page.locator('.create-chip.active')).toHaveCount(1);
    await expect(page.locator('.create-chip.active')).toContainText('Video');
  });

  test('every mode keeps its own answers across a switch', async ({ page }) => {
    await openCreate(page);

    await pickMode(page, 'page');
    await page.fill('#create-source', 'https://example.org/one\nhttps://example.org/two');
    await page.fill('#create-title', 'My Pages');

    await pickMode(page, 'site');
    await page.fill('#create-source', 'https://example.org/');
    await page.fill('#create-max-pages', '37');

    // Peek at two other modes, including the client-only one, then come back.
    await pickMode(page, 'video');
    expect(await fieldValue(page, 'create-source')).toBe('');
    await pickMode(page, 'bookmarks');

    await pickMode(page, 'page');
    expect(await fieldValue(page, 'create-source'))
      .toBe('https://example.org/one\nhttps://example.org/two');
    expect(await fieldValue(page, 'create-title')).toBe('My Pages');

    await pickMode(page, 'site');
    expect(await fieldValue(page, 'create-source')).toBe('https://example.org/');
    expect(await fieldValue(page, 'create-max-pages')).toBe('37');
  });

  test('an advanced value set back to the engine default stays that way', async ({ page }) => {
    await openCreate(page);
    await pickMode(page, 'site');
    // Site arrives with a 500M budget preselected. Choosing "engine default"
    // is a decision, and coming back to find 500M again would undo it.
    expect(await fieldValue(page, 'create-max-bytes')).toBe('500M');
    await page.locator('.create-adv > summary').click();
    await page.selectOption('#create-max-bytes', '');
    await pickMode(page, 'page');
    await pickMode(page, 'site');
    expect(await fieldValue(page, 'create-max-bytes')).toBe('');
  });

  test('Create is full width and far from the chips', async ({ page }) => {
    await openCreate(page);
    await pickMode(page, 'site');
    const panel = await page.locator('.create-panel').boundingBox();
    const button = await page.locator('#create-start').boundingBox();
    const chips = await page.locator('.create-modes').boundingBox();
    // Full width of the panel, give or take its padding.
    expect(button.width).toBeGreaterThan(panel.width - 40);
    // At the very bottom of the panel...
    expect(button.y + button.height).toBeGreaterThan(panel.y + panel.height - 30);
    // ...and nowhere near the chips. Eric reached for Create and hit the tile
    // that opened the next mode, which then wiped what he had typed.
    expect(button.y - (chips.y + chips.height)).toBeGreaterThan(120);
  });
});

// ── D4: folder retreats from the web ────────────────────────────────────────

test.describe('folder mode is CLI-only until a root is configured', () => {
  // The service worker would answer the status poll itself, and a request the
  // browser never makes is a request page.route cannot script.
  test.use({ serviceWorkers: 'block' });

  test('no chip at all when the server names no root', async ({ page }) => {
    await openCreate(page);
    const modes = await page.evaluate(() =>
      [...document.querySelectorAll('.create-chip')].map(c => c.textContent.trim()));
    expect(modes.join(' | ')).not.toMatch(/Folder/i);
    expect(await page.evaluate(() => window._createRoot)).toBe('');
  });

  test('the chip appears, rooted, when the server reports one', async ({ page }) => {
    // The client gate is cosmetic — the server enforces the confinement — so
    // this asserts what the page DRAWS when told a root exists.
    await page.route('**/manage/create/status*', async route => {
      const res = await route.fetch();
      const body = await res.json();
      body.create_root = '/srv/library-sources';
      await route.fulfill({ response: res, json: body });
    });
    await openCreate(page);
    await page.waitForFunction(() => window._createRoot === '/srv/library-sources');
    const modes = await page.evaluate(() =>
      [...document.querySelectorAll('.create-chip')].map(c => c.textContent.trim()));
    expect(modes.join(' | ')).toMatch(/Folder/i);
    await pickMode(page, 'folder');
    await expect(page.locator('.create-panel')).toContainText('/srv/library-sources');
  });

  test('a creator account never sees the two server-path modes', async ({ page }) => {
    // A signed-in user with the per-user create permission may capture the web
    // and package their bookmarks. Folder and import read the SERVER'S disk and
    // the server keeps them for the primary admin, so they are not drawn —
    // even with a root configured, which is the case that could tempt it.
    await page.route('**/manage/create/status*', async route => {
      const res = await route.fetch();
      const body = await res.json();
      body.create_root = '/srv/library-sources';
      await route.fulfill({ response: res, json: body });
    });
    await page.goto(BASE);
    await page.waitForFunction(() => typeof window.openCreate === 'function');
    // app.js keeps _userSession null for admins; a session carrying canCreate
    // is exactly a creator.
    await page.evaluate(() => {
      // `let _userSession` in app.js is a global LEXICAL binding, not a window
      // property, so `window._userSession = ...` would create an unrelated one
      // that create.js never reads. Unqualified assignment reaches the real it.
      _userSession = { name: 'maker', restricted: true, canCreate: true };
      window.openCreate();
    });
    await page.waitForSelector('.create-chip', { state: 'attached' });
    await page.waitForFunction(() => window._createRoot === '/srv/library-sources');
    await expect.poll(() => page.evaluate(() =>
      [...document.querySelectorAll('.create-chip')].map(c => c.textContent.trim()).join(' | ')
    )).not.toMatch(/Folder|Import/i);
    // And what remains is still a working picker, not an empty page.
    expect(await page.locator('.create-chip').count()).toBe(4);
    await expect(page.locator('.create-chip.active')).toHaveCount(1);
  });
});

// ── an offline server ───────────────────────────────────────────────────────

test.describe('offline', () => {
  test.use({ serviceWorkers: 'block' });

  test('the lit chip is one that can actually run', async ({ page }) => {
    // The chips are drawn before the first poll answers, so the page always
    // opens on Web page and then learns it is offline. Leaving Web page lit
    // over a panel that says "this needs an internet connection" is a form
    // asking to be filled in and then refused.
    await page.route('**/manage/create/status*', async route => {
      const res = await route.fetch();
      const body = await res.json();
      body.offline = true;
      body.import_ready = false;
      await route.fulfill({ response: res, json: body });
    });
    await openCreate(page);
    await page.waitForFunction(() => window._createOffline === true);
    await expect.poll(() => page.evaluate(() => window._createSelected))
      .toBe('bookmarks');
    const lit = page.locator('.create-chip.active');
    await expect(lit).toHaveCount(1);
    await expect(lit).not.toBeDisabled();
    // The modes that genuinely cannot run say so, rather than disappearing.
    expect(await page.locator('.create-chip[disabled]').count()).toBeGreaterThan(2);
  });
});

// ── D2: the live progress visualization, against a real crawl ───────────────

test.describe('watching a real crawl', () => {
  // A real crawl of a real site is slower than a unit test and that is the
  // point of it — the config's 60s default is a form-filling budget.
  test.describe.configure({ timeout: 180000 });

  test('the tree grows, the phases light, the counters move', async ({ page }) => {
    await openCreate(page);
    await pickMode(page, 'site');
    await page.fill('#create-source', fixtureUrl);
    await page.fill('#create-max-pages', '10');
    await page.click('#create-start');

    // The picker gets out of the way; the pane takes over.
    await expect(page.locator('#create-picker')).toBeHidden();
    await expect(page.locator('.create-phases')).toBeVisible();

    // Rows arrive as pages are captured, and they arrive as a TREE: the seed
    // page is the root, the section indexes hang off it, and their pages hang
    // off those.
    await page.waitForFunction(() => document.querySelectorAll('.create-node').length >= 4,
      null, { timeout: 60000 });
    await expect(page.locator('.create-step[data-state="active"], .create-step[data-state="done"]'))
      .not.toHaveCount(0);
    await expect(page.locator('.create-metric')).not.toHaveCount(0);

    await page.waitForFunction(() => window._createStatus && window._createStatus.done,
      null, { timeout: 120000 });

    const shape = await page.evaluate(() => {
      const depth = el => {
        let d = 0, p = el.parentElement;
        while (p && p.id !== 'create-tree') {
          if (p.classList.contains('create-node-kids')) d++;
          p = p.parentElement;
        }
        return d;
      };
      return [...document.querySelectorAll('.create-node')].map(n => depth(n));
    });
    expect(shape.filter(d => d === 0).length).toBe(1);   // one root: the seed
    expect(Math.max(...shape)).toBeGreaterThanOrEqual(2); // and real nesting
  });

  test('the done card assembles and offers a way in', async ({ page }) => {
    await openCreate(page);
    await runFixtureCrawl(page, { title: 'Fixture Handbook', maxPages: 6 });

    const card = page.locator('.create-done');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Fixture Handbook');
    await expect(card.locator('.create-done-open')).toBeVisible();
    // The strip finishes at Ready, and the phase caption stops narrating.
    await expect(page.locator('.create-step').last()).toHaveAttribute('data-state', 'done');
    await expect(page.locator('#create-phase-detail')).toHaveText('');
    // The byte total rolls UP: it must end at the real size, not at zero.
    await expect.poll(async () => page.evaluate(() => {
      const el = document.getElementById('create-done-bytes');
      return el ? el.textContent : '';
    }), { timeout: 5000 }).not.toMatch(/^0 B$/);
  });

  test('packaging visibly moves, which is the whole complaint', async ({ page }) => {
    // Eric, on the round-2 page: packaging hung forever. lane-jobs fixed the
    // engine (it reports and checkpoints per page now); this is the client half
    // of that fix — while the strip sits on Package, the entry counter has to
    // CLIMB, against a total, rather than sit still behind a spinner.
    await openCreate(page);
    await pickMode(page, 'site');
    await page.fill('#create-source', slowUrl);
    await page.fill('#create-max-pages', '60');
    await page.click('#create-start');

    await expect(page.locator('.create-step[data-state="active"]'))
      .toHaveText(/Package/, { timeout: 90000 });

    // Sample the counter while Package is lit. It must strictly increase, and
    // it must be a fraction — an indeterminate number is a spinner with digits.
    const seen = [];
    for (let i = 0; i < 12; i++) {
      const reading = await page.evaluate(() => {
        const c = window._createViz.counts.entries;
        const lit = document.querySelector('.create-step[data-state="active"]');
        return {
          n: c ? c.n : null,
          total: c ? c.total : null,
          onPackage: !!lit && lit.textContent.indexOf('Package') >= 0,
          shown: document.querySelector('.create-metric-n').textContent,
        };
      });
      if (reading.onPackage) seen.push(reading);
      if (!reading.onPackage && seen.length) break;
      await page.waitForTimeout(1200);
    }
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen[seen.length - 1].n).toBeGreaterThan(seen[0].n);
    expect(seen[0].total).toBeGreaterThan(0);
    // And the number on screen is the number in the model, not a stale paint.
    expect(seen[seen.length - 1].shown).toBe(String(seen[seen.length - 1].n));

    await page.waitForFunction(() => window._createStatus && window._createStatus.done,
      null, { timeout: 120000 });
    expect(await page.evaluate(() => window._createStatus.ok)).toBe(true);
  });

  test('assets land in the node that wanted them', async ({ page }) => {
    // The other half of Eric's picture: "then the fetching of assets filling in
    // each node". The crawler names the page each asset belongs to, so a page
    // row carries its own counter and its own fill.
    await openCreate(page);
    await pickMode(page, 'site');
    await page.fill('#create-source', slowUrl);
    await page.fill('#create-max-pages', '20');
    await page.click('#create-start');
    await page.waitForFunction(() => window._createStatus && window._createStatus.done,
      null, { timeout: 120000 });

    const bars = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.create-node')];
      const filled = rows.filter(n => {
        const bar = n.querySelector(':scope > .create-node-bar');
        return bar && !bar.hidden && bar.firstElementChild.style.width === '100%';
      });
      return {
        rows: rows.length,
        filled: filled.length,
        counter: filled.length ? filled[0].querySelector('.create-node-assets').textContent : '',
      };
    });
    expect(bars.rows).toBeGreaterThan(2);
    // Every page in this fixture carries its own image and the shared
    // stylesheet, so every row ends up complete. The exact count is the
    // fixture's business; what matters is that it is a landed-of-wanted pair
    // and that they agree.
    expect(bars.filled).toBe(bars.rows);
    expect(bars.counter).toMatch(/^(\d+)\/\1$/);
    expect(Number(bars.counter.split('/')[0])).toBeGreaterThan(0);
  });

  test('the log is still there, one click away', async ({ page }) => {
    await openCreate(page);
    await runFixtureCrawl(page, { maxPages: 4 });
    // Closed by default — the picture is what you watch — and full of the
    // engine's own lines when opened.
    await expect(page.locator('#create-log')).toBeHidden();
    await page.locator('.create-logbox > summary').click();
    await expect(page.locator('#create-log')).toBeVisible();
    expect(await page.locator('.create-log-line').count()).toBeGreaterThan(2);
  });

  test('the finished job turns up under Recent, with a way to open it', async ({ page }) => {
    await openCreate(page);
    await runFixtureCrawl(page, { title: 'For The Record', maxPages: 4 });
    await page.evaluate(() => window._createReset());
    await expect(page.locator('#create-picker')).toBeVisible();
    const row = page.locator('.create-hist[data-state="ok"]').first();
    await expect(row).toBeVisible();
    await expect(row.locator('button')).toBeVisible();
  });
});

// ── the states that need the server to misbehave ────────────────────────────

// One scripted status reply, served to every poll until changed.
async function scriptStatus(page, next) {
  await page.route('**/manage/create/status*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(next()),
    });
  });
}

const RUNNING = {
  offline: false, import_ready: true, queue: [], history: [],
  id: 'job-1', active: true, done: false, mode: 'site', phase: 'fetch',
  lines: ['fetching /'], cursor: 1, events: [], event_cursor: 0,
  ok: false, cancelled: false, cancelling: false, error: '', result: null,
  cancellable: true,
};

test.describe('the states that used to be a spinner forever', () => {
  test.use({ serviceWorkers: 'block' });

  test('a server restart mid-job says so instead of spinning', async ({ page }) => {
    let phase = 'running';
    await scriptStatus(page, () => phase === 'running' ? RUNNING : {
      offline: false, queue: [], active: false, done: false,
      lines: [], cursor: 0, events: [], event_cursor: 0,
      history: [{
        id: 'job-1', mode: 'site', title: 'Doomed Crawl', state: 'interrupted',
        ok: false, error: 'interrupted: the server restarted during this job',
      }],
    });
    await openCreate(page);
    await expect(page.locator('.create-phases')).toBeVisible();

    // The server goes away and comes back with no job at all.
    phase = 'restarted';
    await expect(page.locator('.create-notice')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.create-notice')).toContainText('restarted');
    // No spinner, and the form is usable again.
    await expect(page.locator('#create-picker')).toBeVisible();
    await expect(page.locator('.spinner-inline')).toHaveCount(0);
    // The history entry is labelled as interrupted, never as a failure.
    const row = page.locator('.create-hist[data-state="interrupted"]');
    await expect(row).toBeVisible();
    await expect(row).toContainText('Doomed Crawl');
  });

  test('a queued job says where it is in line and can be dropped', async ({ page }) => {
    await scriptStatus(page, () => Object.assign({}, RUNNING, {
      queue: [{ id: 'job-2', mode: 'page', title: 'Waiting Its Turn', position: 2 }],
    }));
    await openCreate(page);
    const queued = page.locator('.create-queued');
    await expect(queued).toBeVisible();
    await expect(queued).toContainText('Waiting Its Turn');
    await expect(queued).toContainText('2');
    await expect(queued.locator('button')).toBeVisible();
  });

  test('a server with no events degrades to the log, silently', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await scriptStatus(page, () => {
      const old = Object.assign({}, RUNNING, { lines: ['fetching /', 'fetching /docs/'], cursor: 2 });
      delete old.events;
      delete old.event_cursor;
      delete old.phase;
      return old;
    });
    await openCreate(page);
    // No strip, no tree — an inert progress indicator is worse than none.
    await expect(page.locator('.create-phases')).toBeHidden();
    await expect(page.locator('#create-tree-wrap')).toBeHidden();
    // The log is still the truth, and it still works.
    await page.locator('.create-logbox > summary').click();
    expect(await page.locator('.create-log-line').count()).toBe(2);
    expect(errors).toEqual([]);
  });
});

// ── the visualization's own limits ──────────────────────────────────────────

test.describe('the tree at scale', () => {
  test.use({ serviceWorkers: 'block' });

  test('two hundred nodes render fast and stay bounded', async ({ page }) => {
    await scriptStatus(page, () => RUNNING);
    await openCreate(page);
    const result = await page.evaluate(() => {
      const events = [];
      let i = 0;
      // A shape a real crawl produces: twenty sections of twenty pages, each
      // page carrying assets that land one at a time.
      for (let s = 0; s < 20; s++) {
        events.push({ i: i++, t: 'node', kind: 'page', id: 's' + s, label: '/s' + s, state: 'done' });
        for (let p = 0; p < 19; p++) {
          const id = 's' + s + '/p' + p;
          events.push({ i: i++, t: 'node', kind: 'page', id: id, label: '/' + id, state: 'active' });
          for (let a = 0; a < 3; a++) {
            events.push({ i: i++, t: 'node', kind: 'asset', id: id + '#a' + a, parent: id, state: 'done' });
          }
          events.push({ i: i++, t: 'node', kind: 'page', id: id, state: 'done' });
        }
      }
      const started = performance.now();
      window._createVizChanges = window._createApplyEvents(window._createViz, events);
      window._createSyncTree(window._createStatus);
      const ms = performance.now() - started;
      return {
        ms: ms,
        pages: window._createViz.pages,
        rows: document.querySelectorAll('.create-node').length,
        cap: window.CREATE_TREE_MAX_NODES,
        elided: document.getElementById('create-tree-more').hidden === false,
        filled: document.querySelector('[data-nid="s0/p0"] > .create-node-bar > i').style.width,
      };
    });
    expect(result.pages).toBe(400);
    // Everything is counted; the DOM is capped and says how many it left out.
    expect(result.rows).toBeLessThanOrEqual(result.cap);
    expect(result.elided).toBe(true);
    // Applying four hundred nodes and twelve hundred assets is one pass, not a
    // rebuild — this is the budget that keeps a Pi's browser smooth.
    expect(result.ms).toBeLessThan(1500);
    // Assets fill the page they landed on.
    expect(result.filled).toBe('100%');
  });
});

// ── reduced motion ──────────────────────────────────────────────────────────

test.describe('with reduced motion', () => {
  test.describe.configure({ timeout: 180000 });

  test('the done moment is complete in one frame, not fast', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openCreate(page);
    expect(await page.evaluate(() => ({
      media: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      helper: window._createReduceMotion(),
    }))).toEqual({ media: true, helper: true });
    await runFixtureCrawl(page, { title: 'Quiet Please', maxPages: 4 });
    const card = page.locator('.create-done');
    await expect(card).toBeVisible();
    // The class that carries the assembly animation is not applied at all.
    await expect(card).not.toHaveClass(/create-done-anim/);
    // And the byte total is its final value immediately, never counting up.
    const first = await page.evaluate(() => {
      const el = document.getElementById('create-done-bytes');
      return el ? el.textContent : null;
    });
    if (first !== null) {
      expect(first).not.toMatch(/^0 B$/);
      await page.waitForTimeout(400);
      expect(await page.evaluate(() =>
        document.getElementById('create-done-bytes').textContent)).toBe(first);
    }
  });
});
