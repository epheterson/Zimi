# What is going on with 1.9, and where the joy went

Eric, 2026-08-31, after his own gate run: "This release gives me really bad vibes. It should feel fun and free and easy and exciting, instead it's circling around the same goal forever. Loading was slow, somehow I got two headers going out and into PWA, CNN has no favicon and loading slow, I gave up. It was my last gen attempt. What's going on here."

This is the answer, in three parts: what you hit, why the release circles, and what to do about it.

## Part 1: what you hit, traced

I pulled the ZIM you made (`created/www_cnn_com.zim`, 14:30 on the 31st, 97 seconds, 442 assets), served it locally, and drove it in a browser at iPhone width.

**No favicon.** True, and a real bug. The ZIM's illustration was the real CNN logo (that is what the library tile shows), but the page itself declared its icon as `/media/sites/cnn/favicon.ico`, a root-relative address. The fast engine carried stylesheets and left every other `<link>` alone, so inside Zimi that address resolves against Zimi's own origin and 404s. The rendered engine had carried icon links all along. Fixed: both engines now read one list of link relations worth carrying, and a fresh capture serves both of CNN's icons with a 200. Commit `8e7d09c`.

**Two headers.** At phone width, directly under Zimi's topbar, the capture showed a 50 px band of near-black with nothing in it. That is CNN's header ad slot: a box the markup reserves for an advertisement that JavaScript would have served live. Offline the slot is always empty, and an empty dark bar under a real header reads as a second header. Fixed in the same commit: ad slots are hidden by class-token prefix in both engines. Verified on a fresh capture: 24 slots, all at zero height, one topbar. You then said Safari "eventually got there" and the home-screen app showed the issues, maybe caching. I re-ran the reader with `navigator.standalone` and the standalone display-mode forced on, at phone width, and still got exactly one Zimi topbar; the black band was there in every mode. The service worker serves `/` network-first and `/static/` stale-while-revalidate with a content-hash cache key, so a stale shell after a deploy is possible for one load but not two headers. If it happens again, a screenshot from the home-screen app is the thing I need.

**Slow.** Measured, at phone width, scrolled end to end:

| what | requests | bytes |
|---|---|---|
| the page itself | 1 | 3.86 MB raw, 387 KB gzipped |
| three autoplaying hero videos | 3 | 6.18 MB |
| images | 118 | 4.75 MB |
| fonts and CSS | 5 | 214 KB |
| total | 157 | 11.8 MB |

Over the Cloudflare tunnel to a phone that is a long wait, and half of it is video that CNN sets to autoplay, loop, and mute. The page is genuinely that heavy; the live site hides it behind a CDN, lazy loading, and the fact that you never scroll all of it. My change on the 31st, which loads every image eagerly, made the capture correct (115 of 115 images paint, up from 45) and made the first load heavier on a phone. That trade was right for correctness and it is part of what you felt. Nothing in the shell was slow: the app loads in 0.19 s over the tunnel.

One more thing your gate could not see: the CNN homepage is a JavaScript application. The fast engine does not run JavaScript, so it captures 6.8 KB of text where a Wikipedia article gives 64 KB. Every image paints now. The page is still a thin version of the live one, and it always will be through that engine.

## Part 2: why it circles

The numbers on the branch since 1.8.2:

| | |
|---|---|
| days | 25 |
| commits | 226 |
| of which fixes | 98 |
| about capture, images, or paint | 29 |
| CNN captures in the prod job history | 12 |

Three things are going on.

**We picked the hardest page on the web as the definition of done.** cnn.com's homepage is a JS app with 117 images in 4 variants each, autoplay video, a 2.4 MB inline stylesheet, an ad slot in the header, and a URL scheme with commas in it. Every one of the twelve captures fixed something real: attribute soup, evicted bodies, the srcset ceiling, lazy images, now the favicon and the ad band. None of them changed how the result felt, because a JS homepage without JS will never feel like the site. It was a test target and we let it become the release gate. That is the "circling".

**Every gate measured something other than what you experience.** The suite checks bytes. The release gate imports modules. My paint gate runs in the container. You run the app on a phone, through the tunnel, in the home-screen PWA. Yesterday I reported green across the board and you found three defects in ten minutes, because nothing on my side had ever run your path. This has been the failure mode of the whole release: something reports success without checking the thing that matters.

**The surface is enormous.** 1.9 started as ops and packaging. ZIM creation became the hero, and the hero grew seven ways to make a ZIM: fast, rendered, singlefile, alive, whole site, video, and WARC import. Each has its own failure modes and its own fixture sites. Every fix is local to one engine and one site, so the fix count climbs while the feeling stays put.

## Part 3: what joy is, for this product

For you, making it: press +, paste an address, and inside a minute something you made appears in your library and looks like the thing. No babysitting, no counters that run backwards, no packaging phase that goes mute.

For someone using it: "I pulled all of sqlite.org onto a stick before the flight, and the links between pages work." Or "my kid's favorite blog is on the tablet, offline, with the pictures." That is the whole pitch, and the fast engine already delivers it on every static site I have tried.

What kills the joy is a showcase you can never win, and a gate that does not run where you live.

## Part 4: what I would do

1. **Demote CNN.** It stays in `scripts/paint-real-captures.py` as a regression target. It leaves the release gate and it leaves the examples. The create page's suggested targets become a static site (sqlite.org), a Wikipedia article, and a personal blog (sive.rs), because those are the captures that feel good and are the ones people will actually make.
2. **Re-run your gate on those, ten minutes, on the phone.** Capture sive.rs/n as one page and sqlite.org as a site with 25 pages. Open each, scroll, tap between pages. If that feels fun, tag 1.9.0. If not, tell me the first thing that felt wrong and we fix that one thing.
3. **Add the phone path to my gate.** Playwright at 390 px against prod, through the tunnel, opening the newest created ZIM and timing first paint. That is the instrument this release never had. It goes in before 1.9.1.
4. **Ship, then breathe.** The deferred list (#13, #22, #30, #34, #40, #41, #42, #51, #56, #70, #71) is 1.9.1. None of it is a reason to hold.

Two things I need from you: a go to deploy `8e7d09c` to the NAS so your next attempt has the fixes, and the screenshot if the two headers were not the black band.

## Part 5: the stars

You asked for the ambition laid out, so here it is, ordered by joy per week of work, with the reasoning.

**Keep this, from the share sheet.** On the phone, in Safari, share a page to Zimi and it is in your library when you get home. The PWA already has a service worker and a manifest; a share target is a manifest entry and one route that queues a capture job. This is the single most joyful thing Zimi could do, because it turns a chore at a desk into a tap on the couch. Two weeks.

**Chat with your library.** The 2.0 hero already in the plan: the `/chunks` endpoint and the MCP server exist, so the grounding layer is built. What is missing is the front door: a question box on the home screen that answers from the ZIMs you have, with citations that open in the reader. This is the thing that makes an offline library feel alive rather than archived, and it is what the Kiwix opportunity scan said Zimi's wedge is. Six weeks, and the first version can be an external model with a local fallback later.

**The moon in the real solar system.** Your vision from the almanac work: one simulation drives the phase, the sky, the orrery, and the deep links. It is pure joy with no ops, and it is the part of Zimi that makes people show it to someone else. Four weeks, and it is fun to build.

**Community ZIMs.** The BitTorrent plumbing exists. An index, not a CDN, so a ZIM you made of a site can be found by someone else who wants it. This is where the share-sheet capture becomes a gift to strangers. Eight weeks, after chat.

**The fleet.** Industry Edition: one package that runs on a stick in a bunker and on a hundred machines with a config file. Most of this is packaging and provenance work that 1.9 already did. It is the least joyful and the most fundable, which is why it comes after the things that make people love the product.

The order matters. Every item above the fleet makes someone smile the first time they use it. Build those first, and the release notes write themselves.
