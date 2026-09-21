# Apps

Four views Zimi owns over the ZIMs in your library. Each is a page inside the reader with the library's search box on top, and each reads its ZIMs' own indexes rather than a copy, so nothing is rebuilt and nothing goes stale.

## How it works

The home page shows an **Apps** row above the sources when the library holds something an app can read, and on a fresh install the row still shows: each tile then says what it needs and opens the matching catalog category (or, for Reddot, the Create page).

- **Maps** opens the last map you visited at the place you left it. A StreetZim map nobody has been on yet opens over its settlements rather than the middle of its region's box (Hawaii's box is mostly ocean). The box finds a place on the open map (StreetZim's own place index; Kiwix maps' place pages). The picker under the pin lists the installed maps that cover the spot on screen first, then the catalog's maps of here and of the whole world, then the rest folded away, then **Where I am** (asked for when tapped, never before) and **All maps in the catalog**. Switching maps keeps the position and zoom when the other map covers it. Random rolls a place; history and bookmarks record places.
- **ZimiTube** is one feed across every video ZIM (TED, YouTube, and the ones Zimi makes). Browsing is a shelf per source; a source, a query, or a library with one source is a list with an order of its own (Top, Title, Newest, Longest). A card plays in ZimiTube's own player with the page's subtitles, the rest of the list up next, and autoplay into it. Leave the player with a video playing and it docks in a corner while you browse; tap it to come back. Theater mode gives the stage the whole width, and Picture in picture appears where the browser has it. TED's videos are WebM, which iPhones cannot decode; on an iPhone or iPad ZimiTube plays them through the decoder the TED ZIM ships (ogv.js) from the start, and the talk's original page, read through Zimi, does the same. The same talk carried by two ZIMs is one card. The original page is one tap away.
- **ZimiExchange** is every Stack Exchange site in the library as one place: a shelf per site of its most voted questions with its top tags, a site or a tag as a paged list, and a question with its answers, the accepted one first. The box searches question titles across the installed sites.
- **Reddot** reads subreddit ZIMs (ArcticZim's, and the ones Zimi makes): a shelf per subreddit (a library with one subreddit opens on that subreddit's list), a subreddit as a list (Top, New), a post with its comment tree. Follow subreddits with the star on their shelves and **Home** lists their top posts in one place; followed shelves come first. What you follow is kept in your browser. To make one, paste a subreddit's reddit.com address into Create under Web page; see [making ZIMs](making-zims.md).

**Getting around.** The app's icon in the breadcrumb is the way to its front page. The arrow in Zimi's header is the only back there is, and it works inside an app as it does in an article: it appears once you are inside (a video, a question, a post, a list) and steps back to where you were; a list (a subreddit, a tag, a search) steps to the app's home; at the home there is no arrow, as on a ZIM's front page. **Open the original page** is a step too: the arrow returns to the video, the question or the post. A shared link to one of those has no home beneath it, so the arrow makes one in place. The dice stay inside the app: a video, a question or a post by chance. A shared link to a video, a question or a post is a query (`/?tube=…`, `/?exchange=…`, `/?reddot=…`), which survives a sign-in on the way in.

**One thing once.** When two ZIMs carry the same thing, an app shows it once, from the newest build (then the fullest): last month's file still beside this month's, a nopic beside a maxi of one site, the same region from the same map source, a subreddit in two bundles. The library itself lists every file; only the apps' views are deduplicated.

**Choosing apps.** Each app can be offered or not. `ZIMI_APPS=0` hides them all for the whole server and `ZIMI_APPS=maps,tube` keeps only those (the names are `maps`, `tube`, `exchange`, `reddot`); the **Apps offered to everyone** checkboxes under Preferences (beside Show Discover) do the same without a restart, and each account can untick apps for itself under its own settings. The pages and endpoints stay reachable by address for anyone allowed to read the ZIMs behind them.

## Configure

| Setting | Where | Effect |
| --- | --- | --- |
| `ZIMI_APPS` | environment | `0` offers no app to anyone; a comma list of `maps`, `tube`, `exchange`, `reddot` offers only those. Overrides the saved choice. |
| Apps offered to everyone | Manage, Preferences (beside Show Discover) | The server's choice, one checkbox per app, saved with the other server preferences. |
| Apps on my home page | account settings | One account's own choice among the apps the server offers, kept with its bookmarks and history. |

## Troubleshoot

- **A video ZIM is missing from ZimiTube** — Zimi reads ted2zim, youtube2zim and its own index shapes. Another scraper's ZIM opens as a source but not in ZimiTube. Restart after installing one made by an older version so its kind is read again.
- **A talk I can see in the ZIM is not in ZimiTube** — its file is not in the ZIM (the scraper wrote the page and skipped a download that failed), so the feed leaves it out. Its page still opens as an article and says so.
- **A site shows twice in ZimiExchange** — two ZIMs with different titles are two sites. Two builds with one title collapse to the newest.
- **"This video cannot be played here."** — the file is in the ZIM but this browser cannot decode it. When a page names a WebM and the ZIM also carries an MP4 of the same talk, the MP4 is played instead; Safari gets the ZIM's own decoder for a WebM, as an iPhone does. The link under the message opens the video's own page, which may carry a decoder of its own (TED's pages do). A ZIM Zimi makes from a video site takes H.264 first for this reason; one made before 1.10 may carry AV1, which no iPhone before the 15 Pro decodes.
- **"This video isn't in this ZIM."** — the video's page is there but its file never was: the scraper wrote the page and skipped a download that failed (the CRISPR talk in the 2023 TED technology ZIM). Nothing on your side is wrong; a newer build of the ZIM may carry it.
- **A place I can see on a Kiwix map is not in the search** — Kiwix's maps carry one place page per name, so "Danville" finds one Danville and a town that shares its name with a bigger one has no page of its own. A StreetZim map of the region carries every place and address.
- **The map picker does not offer a map of here** — the catalog's regions are approximate boxes; the row **All maps in the catalog** lists every one.
