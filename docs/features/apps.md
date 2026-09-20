# Apps

Four views Zimi owns over the ZIMs in your library. Each is a page inside the reader with the library's search box on top, and each reads its ZIMs' own indexes rather than a copy, so nothing is rebuilt and nothing goes stale.

## How it works

The home page shows an **Apps** row above the sources when the library holds something an app can read, and on a fresh install the row still shows: each tile then says what it needs and opens the matching catalog category (or, for Reddot, the Create page).

- **Maps** opens the last map you visited at the place you left it. The box finds a place on the open map (StreetZim's own place index; Kiwix maps' place pages). The picker under the pin lists the installed maps that cover the spot on screen first, then the catalog's maps of here and of the whole world, then the rest folded away, then **Where I am** (asked for when tapped, never before) and **All maps in the catalog**. Switching maps keeps the position and zoom when the other map covers it. Random rolls a place; history and bookmarks record places.
- **ZimiTube** is one feed across every video ZIM (TED, YouTube, and the ones Zimi makes). Browsing is a shelf per source; a source, a query, or a library with one source is a list with an order of its own (Top, Title, Newest, Longest). A card plays in ZimiTube's own player with the page's subtitles, the rest of the list up next, and autoplay into it. The same talk carried by two ZIMs is one card. The original page is one tap away.
- **ZimiExchange** is every Stack Exchange site in the library as one place: a shelf per site of its most voted questions with its top tags, a site or a tag as a paged list, and a question with its answers, the accepted one first. The box searches question titles across the installed sites.
- **Reddot** reads subreddit ZIMs (ArcticZim's, and the ones Zimi makes): a shelf per subreddit, a subreddit as a list (Top, New), a post with its comment tree. To make one, paste a subreddit's reddit.com address into Create under Web page; see [making ZIMs](making-zims.md).

**One thing once.** When two ZIMs carry the same thing, an app shows it once, from the newest build (then the fullest): last month's file still beside this month's, a nopic beside a maxi of one site, the same region from the same map source, a subreddit in two bundles. The library itself lists every file; only the apps' views are deduplicated.

**Turning apps off.** `ZIMI_APPS=0` hides the row for the whole server; the Manage page's **Apps** switch does the same without a restart, and each account can hide the row for itself under its own settings. The pages and endpoints stay reachable by address for anyone allowed to read the ZIMs behind them.

## Configure

| Setting | Where | Effect |
| --- | --- | --- |
| `ZIMI_APPS=0` | environment | No apps row and no app tiles for anyone; overrides the saved switch. |
| Apps switch | Manage | The server's default, saved with the other server preferences. |
| Show apps | account settings | One account's own choice, kept with its bookmarks and history. |

## Troubleshoot

- **A video ZIM is missing from ZimiTube** — Zimi reads ted2zim, youtube2zim and its own index shapes. Another scraper's ZIM opens as a source but not in ZimiTube. Restart after installing one made by an older version so its kind is read again.
- **A site shows twice in ZimiExchange** — two ZIMs with different titles are two sites. Two builds with one title collapse to the newest.
- **"This video cannot be played here."** — the file inside the ZIM is in a container the browser does not play (some older TED ZIMs). The link under the message opens the video's own page, which may carry a player of its own.
- **The map picker does not offer a map of here** — the catalog's regions are approximate boxes; the row **All maps in the catalog** lists every one.
