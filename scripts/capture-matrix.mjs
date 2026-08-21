#!/usr/bin/env node
/**
 * Every site, every engine, one table — does a capture actually work?
 *
 * capture-fidelity.mjs answers "is THIS page as good as the live one" with
 * pictures. This answers the cheaper question underneath it, across a spread
 * of sites, so a fix that helps CNN and breaks Wikipedia cannot pass: for each
 * (site, engine) it opens the produced ZIM in Zimi's reader with the network
 * SEALED to the Zimi host, and counts what rendered.
 *
 * The numbers that matter, and why each one is here:
 *
 *   loaded/total  images with pixels. The headline.
 *   absolute      references still pointing at the live internet — every one
 *                 is an image that will never load offline, and this is the
 *                 count that was 66 when the &amp; bug was live.
 *   leaked        requests to any host but Zimi's. Must be zero, or the shot
 *                 was flattered by the web being up.
 *   fragments     candidates that are a piece of somebody's query string. The
 *                 comma bug's signature, and it stays visible here forever.
 *
 * Usage:
 *   ZIMI=http://127.0.0.1:8877 node scripts/capture-matrix.mjs
 *
 * Reads the plan from CAPTURES (a JSON array of {label, zim}) so the capturing
 * half can be done by whatever made the ZIMs — the CLI locally, the container,
 * or a live server.
 */
import { chromium, devices } from 'playwright';
import fs from 'fs';

const ZIMI = process.env.ZIMI || 'http://127.0.0.1:8877';
const DEVICE = process.env.DEVICE || 'iPhone 13 Pro';
const OUT = process.env.OUT || '';
const CAPTURES = JSON.parse(process.env.CAPTURES || '[]');
const TOKEN = process.env.TOKEN || '';
const auth = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

const host = new URL(ZIMI).hostname;

async function mainPathOf(name) {
  const res = await fetch(ZIMI + '/list', { headers: auth });
  const body = await res.json();
  const items = Array.isArray(body) ? body : (body.zims || body.sources || []);
  const hit = items.find((z) => z && z.name === name);
  return hit ? (hit.main_path || 'A/index') : null;
}

/** What actually rendered, with nothing but Zimi allowed to answer. */
async function inspect(browser, name, shotPath) {
  const main = await mainPathOf(name);
  if (!main) return { error: 'not in the library' };
  const ctx = await browser.newContext({ ...devices[DEVICE] });
  const page = await ctx.newPage();
  const leaked = [];
  const notFound = [];
  await page.route('**/*', (r) => {
    const h = new URL(r.request().url()).hostname;
    if (h === host || h === '127.0.0.1' || h === 'localhost') return r.continue();
    leaked.push(r.request().url());
    return r.abort();
  });
  page.on('response', (r) => { if (r.status() === 404) notFound.push(r.url()); });
  await page.goto(`${ZIMI}/?a=${encodeURIComponent(name + '/' + main)}`,
    { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(5000);
  const frame = page.frames().find((f) => f !== page.mainFrame());
  const seen = frame ? await frame.evaluate(() => {
    const imgs = [...document.images];
    const src = (i) => i.getAttribute('src') || '';
    // A candidate that is a piece of a query string rather than an address.
    const fragments = [];
    for (const el of document.querySelectorAll('[srcset]')) {
      for (const part of (el.getAttribute('srcset') || '').split(/\s*,\s*(?=[^\s]+\s)/)) {
        const url = part.trim().split(/\s+/)[0];
        if (url && !/^(https?:|data:|\.\.?\/|\/)/.test(url)) fragments.push(url);
      }
    }
    return {
      total: imgs.length,
      loaded: imgs.filter((i) => i.naturalWidth > 0).length,
      absolute: imgs.filter((i) => /^https?:/.test(src(i))).length,
      fragments: fragments.length,
      consent: /By clicking .Agree.|Accept all cookies|We use cookies/i
        .test(document.body.innerText || ''),
      text: (document.body.innerText || '').trim().length,
    };
  }).catch((e) => ({ error: String(e).slice(0, 60) })) : { error: 'no reader frame' };
  if (shotPath) await page.screenshot({ path: shotPath }).catch(() => {});
  await ctx.close();
  return { ...seen, leaked: leaked.length, notFound: notFound.length };
}

const browser = await chromium.launch();
const rows = [];
for (const cap of CAPTURES) {
  const shot = OUT ? `${OUT}/${cap.label.replace(/[^\w.-]/g, '_')}.png` : '';
  const got = await inspect(browser, cap.zim, shot);
  rows.push({ label: cap.label, ...got });
  console.log(`${cap.label.padEnd(26)} ${JSON.stringify(got)}`);
}
await browser.close();

console.log('\n' + '─'.repeat(96));
console.log('capture                    images  loaded  absolute  frags  leaked  404s  consent  text');
let bad = 0;
for (const r of rows) {
  if (r.error) { console.log(`${r.label.padEnd(26)} ERROR: ${r.error}`); bad++; continue; }
  const flag = (r.absolute > 0 || r.fragments > 0 || r.leaked > 0 || r.consent) ? '  <-- ' : '';
  if (flag) bad++;
  console.log(
    `${r.label.padEnd(26)} ${String(r.total).padStart(6)} ${String(r.loaded).padStart(7)} ` +
    `${String(r.absolute).padStart(9)} ${String(r.fragments).padStart(6)} ` +
    `${String(r.leaked).padStart(7)} ${String(r.notFound).padStart(5)} ` +
    `${String(r.consent).padStart(8)} ${String(r.text).padStart(6)}${flag}`
  );
}
console.log('─'.repeat(96));
console.log(bad ? `${bad} capture(s) need work` : 'every capture is clean');
if (OUT) fs.writeFileSync(`${OUT}/matrix.json`, JSON.stringify(rows, null, 2));
