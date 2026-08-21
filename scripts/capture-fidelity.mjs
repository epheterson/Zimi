#!/usr/bin/env node
/**
 * Capture fidelity harness — is a captured page as good as the live one?
 *
 * Renders the SAME url three ways and shoots each full-length, so the answer to
 * "is this good enough to ship" is four pictures side by side instead of an
 * argument:
 *
 *   1. the live site, in a real browser
 *   2. …then one shot per engine (fast / rendered / alive), each served BY ZIMI
 *      and loaded through Zimi's reader, exactly as a person would see it
 *
 * Every capture shot is taken with the network sealed to the Zimi host, so an
 * image that only appears because the live web filled it in cannot flatter the
 * result.
 *
 * Usage:
 *   ZIMI=http://10.0.0.14:8899 TOKEN=… node scripts/capture-fidelity.mjs https://www.cnn.com
 *
 * Captures run on the Zimi instance named by ZIMI (the NAS, normally), so what
 * is measured is what that machine actually produces — not a local dev build.
 */
import { chromium, devices } from 'playwright';
import fs from 'fs';
import path from 'path';

const URL_TO_CAPTURE = process.argv[2] || 'https://www.cnn.com';
const ZIMI = process.env.ZIMI || 'http://10.0.0.14:8899';
const TOKEN = process.env.TOKEN || '';
const OUT = process.env.OUT || './capture-fidelity';
const ENGINES = (process.env.ENGINES || 'builtin,rendered,alive').split(',');
const DEVICE = process.env.DEVICE || 'iPhone 13 Pro'; // where the bugs showed up
const POLL_TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15 * 60 * 1000);

const auth = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, init = {}) {
  const res = await fetch(ZIMI + pathname, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...auth, ...(init.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

/** Start a capture on the Zimi instance and wait for the ZIM to land. */
async function captureOn(engine) {
  const started = await api('/manage/create', {
    method: 'POST',
    body: JSON.stringify({ mode: 'page', source: URL_TO_CAPTURE, engine }),
  });
  if (started.status !== 200) {
    return { engine, error: `create refused (${started.status}): ${JSON.stringify(started.body).slice(0, 160)}` };
  }
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > POLL_TIMEOUT_MS) return { engine, error: 'timed out waiting for the capture' };
    await sleep(3000);
    const s = await api('/manage/create/status');
    const st = s.body || {};
    if (st.done || st.ok === true || st.state === 'done') {
      const name = (st.result && (st.result.name || st.result)) || null;
      if (!name) return { engine, error: 'finished without naming a result' };
      return { engine, name, seconds: Math.round((Date.now() - t0) / 1000), shape: st.result && st.result.shape };
    }
    if (st.error || st.state === 'failed') return { engine, error: String(st.error || 'failed') };
  }
}

/**
 * A browser session that Zimi will answer, or null when it needs no password.
 *
 * The Bearer token authenticates the API calls but a PAGE LOAD carries no
 * headers, so without this every capture shot is a photograph of the sign-in
 * wall — which is exactly what the first run of this harness produced: three
 * byte-identical login screens reported as three engines. GET /whoami mints
 * the zimi_session cookie from a valid Bearer, which is the one credential
 * this harness already has.
 */
async function sessionCookie() {
  if (!TOKEN) return null;
  const res = await fetch(ZIMI + '/whoami', { headers: auth });
  const raw = res.headers.get('set-cookie') || '';
  const hit = /zimi_session=([^;]+)/.exec(raw);
  if (!hit) return null;
  return { name: 'zimi_session', value: hit[1], domain: new URL(ZIMI).hostname,
           path: '/', httpOnly: true, secure: false, sameSite: 'Lax' };
}

/** Full-length shot of a captured ZIM, loaded through Zimi's own reader. */
async function shootZim(browser, name, file, cookie) {
  const ctx = await browser.newContext({ ...devices[DEVICE] });
  if (cookie) await ctx.addCookies([cookie]);
  const page = await ctx.newPage();
  const host = new URL(ZIMI).hostname;
  const leaked = [];
  // Seal the network to Zimi: anything else would be the live web propping up
  // the capture, which is exactly what we are trying to detect.
  await page.route('**/*', (r) => {
    const h = new URL(r.request().url()).hostname;
    if (h === host || h === '127.0.0.1' || h === 'localhost') return r.continue();
    leaked.push(r.request().url());
    return r.abort();
  });
  // The ZIM's own main path, not a guess: a warc2zim archive (the alive
  // engine) roots at "<host>/" while the others use "A/index", so hardcoding
  // one of them silently measures a 404 for the other.
  const main = await mainPathOf(name);
  await page.goto(`${ZIMI}/?a=${encodeURIComponent(name + '/' + main)}`, {
    waitUntil: 'networkidle', timeout: 90000,
  }).catch(() => {});
  await autoScroll(page);
  const stats = await imageStats(page);
  // A shot of the login wall is not a measurement, and it looks like a clean
  // zero — the failure mode this harness had on its first run.
  const walled = await page.evaluate(
    () => /sign in/i.test(document.body.innerText || '') && document.images.length === 0
  ).catch(() => false);

  // FULL LENGTH means the whole article, and the article is inside the
  // reader's iframe. `fullPage` on the SPA grows the OUTER document, which is
  // one screen of chrome around a fixed-height frame — so a 23,000px capture
  // was arriving as a 1,992px photograph of its own scroll box. Reopening the
  // frame's own URL at the top level is the same bytes from the same server,
  // rendered by the same browser, with nothing to clip it.
  const inner = await page.evaluate(() => {
    const f = [...document.querySelectorAll('iframe')].find(f => f.src);
    return f ? f.src : null;
  }).catch(() => null);
  const shot = inner ? await ctx.newPage() : page;
  if (inner) {
    await shot.goto(inner, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
    await autoScroll(shot);
  }
  await shot.screenshot({ path: file, fullPage: true });
  await ctx.close();
  return { ...stats, leakedRequests: leaked.length, framed: Boolean(inner),
           ...(walled ? { error: 'not signed in — the shot is the login wall' } : {}) };
}

/** Full-length shot of the live original, for the side-by-side. */
async function shootLive(browser, file) {
  const ctx = await browser.newContext({ ...devices[DEVICE] });
  const page = await ctx.newPage();
  await page.goto(URL_TO_CAPTURE, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
  await autoScroll(page);
  await page.screenshot({ path: file, fullPage: true });
  const stats = await imageStats(page);
  await ctx.close();
  return stats;
}

/** Where this ZIM says its front door is. Falls back to the common layout. */
async function mainPathOf(name) {
  const { body } = await api('/list');
  const items = Array.isArray(body) ? body : (body && (body.zims || body.sources)) || [];
  const hit = items.find((z) => z && z.name === name);
  return (hit && hit.main_path) || 'A/index';
}

/** Scroll to the bottom so lazy images load — otherwise every shot lies. */
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((done) => {
      let y = 0;
      const step = () => {
        window.scrollBy(0, 900);
        y += 900;
        if (y >= document.body.scrollHeight || y > 60000) return done();
        setTimeout(step, 120);
      };
      step();
    });
    window.scrollTo(0, 0);
  }).catch(() => {});
  await page.waitForTimeout(2500);
}

/** How much of the page actually rendered: images that have pixels, and any
 *  element still pulsing (a skeleton waiting for a server that never answers). */
async function imageStats(page) {
  const frames = page.frames();
  let best = { images: 0, loaded: 0, broken: 0, pulsing: 0, height: 0 };
  for (const f of frames) {
    try {
      const s = await f.evaluate(() => {
        const imgs = [...document.images];
        const loaded = imgs.filter((i) => i.naturalWidth > 0).length;
        let pulsing = 0;
        for (const el of document.querySelectorAll('*')) {
          const cs = getComputedStyle(el);
          if (cs.animationName !== 'none' && cs.animationIterationCount === 'infinite') pulsing++;
        }
        return { images: imgs.length, loaded, broken: imgs.length - loaded, pulsing,
                 height: document.body.scrollHeight };
      });
      if (s.images >= best.images) best = s;
    } catch { /* cross-origin frame */ }
  }
  return best;
}

const rows = [];
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();

console.log(`\nurl:    ${URL_TO_CAPTURE}\nzimi:   ${ZIMI}\ndevice: ${DEVICE}\n`);

const cookie = await sessionCookie();
if (TOKEN && !cookie) console.log('warning: no session cookie — shots may be the login wall\n');

const liveFile = path.join(OUT, 'live.png');
const live = await shootLive(browser, liveFile);
rows.push({ what: 'LIVE', ...live, seconds: '', file: liveFile });

for (const engine of ENGINES) {
  console.log(`capturing with ${engine} …`);
  const made = await captureOn(engine);
  if (made.error) { rows.push({ what: engine, error: made.error }); continue; }
  const file = path.join(OUT, `${engine}.png`);
  const shot = await shootZim(browser, made.name, file, cookie);
  rows.push({ what: engine, ...shot, seconds: made.seconds, name: made.name, file });
}
await browser.close();

console.log('\n' + '─'.repeat(78));
console.log('what      images  loaded  broken  pulsing   height   secs  notes');
for (const r of rows) {
  if (r.error) { console.log(`${String(r.what).padEnd(9)} ERROR: ${r.error}`); continue; }
  const leak = r.leakedRequests ? ` leaked=${r.leakedRequests}` : '';
  console.log(
    `${String(r.what).padEnd(9)} ${String(r.images).padStart(6)} ${String(r.loaded).padStart(7)} ` +
    `${String(r.broken).padStart(7)} ${String(r.pulsing).padStart(8)} ${String(r.height).padStart(8)} ` +
    `${String(r.seconds).padStart(6)}  ${r.name || ''}${leak}`
  );
}
console.log('─'.repeat(78));
console.log(`\nshots in ${path.resolve(OUT)} — open them side by side against live.png\n`);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ url: URL_TO_CAPTURE, device: DEVICE, rows }, null, 2));
