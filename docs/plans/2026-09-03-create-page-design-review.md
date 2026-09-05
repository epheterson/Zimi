# The create page — design review

Method: the six passes of the Jony Ive review (one job, hierarchy, inevitability, order, care in the unseen, honesty). Exercised on 2026-09-03 at 390 px and 1200 px against a scratch server: the cold form, a one-page job start to finish, a 40-page crawl, a failed video job, the Advanced disclosure. Screenshots in `scratchpad/survey/ui/`.

## 1. The one job

**Paste an address and have it in my library, right, without watching it.**

Everything below is measured against that sentence.

## 2. What is already right

Name it so it survives the next edit.

- **The four dots** (Discover · Fetch · Package · Ready) are one axis for every mode and every engine. That is the organising idea, and it holds.
- **The counters are facts** (pages, assets, size) and since today they end as the file's own size, so the number a person reads is the number the library will show.
- **The tree of pages** for a crawl, with per-host progress, is honest and legible; it is what "not watching it" is allowed to look like when a person does watch.
- **WHAT'S INSIDE** is the same bar the About panel draws; one component, no drift.
- **The failure sentence** is in the interface's own voice ("the site refused the download (HTTP 403). Sites throttle automated downloads; trying again later, or from a different network, often works.") and it names what the person can do.
- **Server log** is a disclosure at the bottom, closed. Correct place, correct weight.
- **"Create another"** after either outcome.

## 3. Defects

Each: the element, what the eye does, the pass it fails, the change.

**D1. The engine picker is the largest thing on the form.** Three radio cards, thirty words each, occupy more of the phone screen than the address field, on a decision most people cannot make ("Fast (no JavaScript) — Light — runs anywhere. Pages built by JavaScript come out empty."). Fails hierarchy, and inevitability: the choice is derivable. The probe already fetches the page for its title and robots; the fast fetch already knows whether a page is a JavaScript shell (`creator.py`'s SPA-shell test). *Change:* the probe decides. Under the address, one line: "Static page — Fast will do" or "Built by JavaScript — Rendered" (or Alive when installed and the site is an app). A quiet "Change" link opens the three options for the few who care. Fast stands until the probe answers.

**D2. The mode is asked before the address.** The first row is four chips (Web page · Whole site · Video or playlist · Bookmarks), which on a phone wrap into two uneven rows, and only then the address. But the address is the job; the mode follows from it. Video is already detected from the address (yt-dlp claims it); page-versus-site is the one real question, and it is a question about the address just typed. Fails order: the page's own organising idea (address → dots → result) is broken on its first screen. *Change:* address first. Under it, after the probe: "This page" | "The whole site" as one segmented control; "Bookmarks" stays as its own chip since it has no address. The four chips become two.

**D3. The finished card is below the page list.** On a 40-page crawl the tree grows to forty rows and the card with Open lands under all of them; on a phone that is two screens of scrolling to the one thing the person came for. Fails hierarchy (the result competes with the log of how it was made) and care (the ideal-state screenshot is a one-page job). *Change:* the card mounts above the tree the moment the file exists; the tree collapses to one line ("40 pages · show") under it.

**D4. The finished card fades in.** `create-done-anim` eases the card from invisible over a beat. The file already exists; the motion corresponds to nothing. The frame at 26 s of the crawl shows a card whose text cannot yet be read. Fails honesty (motion not tied to something real) and care (the first sighting of the result is its worst). *Change:* no fade. The only motion at the finish is the fourth dot filling, which is the one thing that actually changed.

**D5. The card says the name three ways.** "Added to the library / SQLite Home Page / www_sqlite_org_site-2.zim / 40 pages / 573.2 KB". The filename is a system concept the library manager already shows; here it is the second-loudest line on the card. Fails hierarchy and honesty (a label naming the system's concept, not the person's). *Change:* title, then one line: "40 pages · 573 KB · in your library", then Open. The filename lives in Manage.

**D6. A one-page job shows a tree of one row that repeats its heading.** Heading "sive.rs/n", below it a tree row "• /n". The row exists because the crawl renderer draws it. Fails order (one rule applied where it does not apply). *Change:* no tree for a single page; the heading takes the page's real title the moment the fetch has it.

**D7. The failure keeps the finished shape.** After "Creation failed" the four dots are all still the ready colour and "1 / 17 video" sits above the red text as if the job were mid-count. Fails honesty. *Change:* the dot of the phase that failed goes red and the later dots go hollow; the counter dims to the same grey as the labels.

**D8. The Whole-site address placeholder reads `https://example.org/article`.** A site address is a root. Fails honesty, in a small way that a person notices exactly when they are about to type. *Change:* `https://example.org/` on that tab.

**D9. "Max pages" with a placeholder of 200 sits outside Advanced.** Two hundred is a number someone picked; nothing on the page says why. Fails inevitability. *Change:* leave the control, derive the wording: "Up to 200 pages (about N minutes)" from the probe's page count when the site publishes a sitemap, else keep 200 and say "the first 200 pages". This is the least important item here.

## 4. The single most important change

**D1 with D2: the address is the first field, and the probe chooses the mode and the engine.** It removes the two decisions the person cannot make, shrinks the phone form from two screens to one, and makes the page read in the order the job happens. Cost: a probe field from the server (`built_by_script`, from the SPA-shell test already in `creator.py`), the form reordered in `create.js`, a segmented page/site control replacing two chips, and the picker becoming a disclosure. About a day, with the spec tests that already drive this page. Risk: the probe takes one to two seconds; until it answers the defaults stand and nothing moves.

## Order of work

D8, D4, D5, D3, D6, D7 are each an hour or less and land first. D1 lands next, as one commit with its probe field. D2 is the reorder and lands last, alone, because it is the change a person will notice most.

## Status

| item | state |
|---|---|
| D3 result above the list, list folds to "40 pages" | `38625de`, verified on a phone: card at the top of the pane, Open beside it |
| D4 no entrance animation | `38625de` |
| D5 the card names the page, not the file | `38625de`, the server hands back the title the capture found |
| D6 no tree for one page | `38625de` |
| D7 the failed phase's dot goes red | `38625de`, with `failed_phase` from the server |
| D8 site placeholder is a root | `38625de` |
| D1 the probe chooses the engine | `95a559c`; excalidraw.com picks Rendered with the note "This page builds itself in JavaScript, so the rendered engine is what will capture it."; sqlite.org and react.dev stay Fast; the picker reads "Capture engine · Rendered (runs a browser) · Change" |
| D2 address first | **done, late 09-03** (Eric: "Address first… sounds smart, maybe we are at UI polish now"): one address above the chips (`#create-address`, wired once, never stashed per mode); the chips sit under it as "what to make of this"; the probe answers as a video when yt-dlp claims the address and the chip moves to Video, and back to Web page for a plain page (`_probe_claims_video` in manage.py); Bookmarks hides the field. Spec `one address above the chips; every mode keeps its own answers` rewritten for the shared address; the two stale loops naming the removed import tile fixed. Seen at 390 px: address, chips, panel, in that order. |
| D9 "up to 200 pages" wording | open, least important |
| Report a site | done, late 09-03: the failed card and the thin-page warning carry "Tell us about this site", a GitHub issue link pre-filled with the address, mode and what the server said (`_createReportUrl`); nothing is sent by itself. CHANGELOG asks for failing sites in so many words. |
