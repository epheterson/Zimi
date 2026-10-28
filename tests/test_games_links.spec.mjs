// ZimiGames and the encyclopedia, linked both ways (Eric: "each can link into
// its wiki page and maybe vice versa, any language reading about any game a
// play button shows up").
//
//   python3 -m tests.make_wiki_games_fixture /tmp/zimi-games-links
//   ZIM_DIR=/tmp/zimi-games-links/zims ZIMI_DATA_DIR=/tmp/zimi-games-links/data \
//     ZIMI_TORRENT=0 ZIMI_OFFLINE=1 python3 -m zimi serve --port 9072
//   BASE_URL=http://localhost:9072 npx playwright test \
//     --config=tests/playwright.config.mjs tests/test_games_links.spec.mjs
//
// The fixture's English and French "Wikipedia" each hold Chess (Q718, a game
// ZimiGames has) and Cat (Q146, not a game). SHOTS=<dir> saves the pictures.

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:9072';
const SHOTS = process.env.SHOTS || '';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function openArticle(page, zim, path) {
  await page.goto(BASE);
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(BASE + '/?a=' + encodeURIComponent(zim + '/' + path));
  await expect(page.locator('#reader')).toHaveClass(/open/);
}

const frameUrl = (page) => page.evaluate(() => document.getElementById('reader-frame').contentWindow.location.pathname);
async function shot(page, name) {
  if (!SHOTS) return;
  await expect(page.locator('#reader-loading')).toHaveClass(/hidden/); // the picture is of the page, not its spinner
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test('a game\'s wiki article shows Play, in every language, and Play opens the game', async ({ page }) => {
  for (const [zim, path] of [['wikipedia_en_test', 'Chess.html'], ['wikipedia_fr_test', 'Echecs.html']]) {
    await openArticle(page, zim, path);
    const play = page.locator('#game-play');
    await expect(play).toBeVisible();
    await expect(play).toContainText('Chess');
    await shot(page, 'play-' + zim);
  }
  await page.locator('#game-play').click();
  await expect.poll(() => frameUrl(page)).toBe('/w/zimi_games/chess.html');
  await expect(page.locator('#game-play')).toBeHidden();
  await shot(page, 'game-opened');
});

test('an article that is no game\'s has no Play', async ({ page }) => {
  await openArticle(page, 'wikipedia_en_test', 'Cat.html');
  await expect.poll(() => page.evaluate(() => _gamesLinks !== null)).toBe(true);
  await page.evaluate(() => _gamesLoad());
  await expect(page.locator('#game-play')).toBeHidden();
});

test('a game\'s About link opens the article in the reader\'s language, else the plain page', async ({ page }) => {
  await openArticle(page, 'zimi_games', 'chess.html');
  const about = page.frameLocator('#reader-frame').locator('.gm-about a');
  await expect(about).toHaveText('About Chess');
  await about.click();
  await expect.poll(() => frameUrl(page)).toBe('/w/wikipedia_en_test/Chess.html');
  await shot(page, 'about-opened-en');

  await openArticle(page, 'zimi_games', 'chess.html');
  await page.evaluate(() => { _currentLang = 'fr'; });
  await page.frameLocator('#reader-frame').locator('.gm-about a').click();
  await expect.poll(() => frameUrl(page)).toBe('/w/wikipedia_fr_test/Echecs.html');

  // Go has no article in this library: the game's own About page, never a dead link.
  await openArticle(page, 'zimi_games', 'go.html');
  await page.frameLocator('#reader-frame').locator('.gm-about a').click();
  await expect.poll(() => frameUrl(page)).toBe('/w/zimi_games/about.html');
  await expect(page.frameLocator('#reader-frame').locator('#ab-title')).toHaveText('Go');
  await expect(page.frameLocator('#reader-frame').locator('#ab-play')).toHaveAttribute('href', 'go.html');
  await shot(page, 'about-plain');
});
