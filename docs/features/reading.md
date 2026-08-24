# Reading

Search across every ZIM at once, open an article, and read it — the part of Zimi you spend the most time in, and the only one that has to work with no network at all.

## How it works

**Search** runs across the whole library from one box. Results are ranked by title match, then by position within the source's own results, then by source authority (a bigger ZIM's hit outranks a tiny one's, on a log scale, capped so a large source cannot flood the page). A query with no hits gets a "did you mean" from a vocabulary and trigram pass rather than nothing. Search a single source by opening it first; the box narrows to it.

**The reader** opens an article in place. Titles, history and the address stay in step, so Back does what a browser's Back does and a link you share reopens the same article. `?a=<zim>/<path>` is the deep link; `/w/<zim>/<path>` serves the raw article.

**Reader View** re-renders an article as plain, readable prose — one column, your font and size, your theme (dark / light / sepia). It is per-article, and `zimi_reader_auto` opens every article straight into it.

**Bookmarks and history.** Bookmarks group into folders and survive restarts. History records what you opened. Both are stored per user server-side when you are signed in as a named account; an admin without a named user keeps them in the browser, which means they are per-browser and a private window starts empty. See [Users & access](users-and-access.md).

**Word lookup (Define).** Select a word — or double-tap it on a phone — and Zimi looks it up in an installed Wiktionary. It is dormant with no Wiktionary installed. There is no tooltip advertising it; it is found the way every other text gesture is found.

**The same article in another language.** Zimi matches articles across ZIMs by their Wikidata Q-ID rather than by title, so an article open in one language offers the same subject in every other installed language edition that has it. Titles differ, redirects differ, spelling differs — the Q-ID does not. Matching is on demand and cached; nothing is precomputed for a library you never read across.

**PDFs** open in an embedded PDF.js viewer, so a ZIM full of documents (the zimgit collections) reads without leaving the page.

**Offline and installable.** A service worker precaches the shell, so Zimi opens with no server round trip and works as an installed PWA. The cache key is the asset-bundle hash, so every deploy invalidates it and a new version takes over immediately rather than waiting for tabs to close.

**Accessibility.** Zimi scores 100/100 on Lighthouse a11y and targets WCAG 2.1 AA. Passing `?a11y=1` on a content URL additionally rewrites the article server-side: fills in a missing `<html lang>`, adds empty `alt` to unlabelled images (decorative by default, per WCAG 1.1.1), and promotes a leading title `div` to a real `<h1>` so heading navigation works.

### Pages captured without their JavaScript

A page captured by the **fast** engine keeps its markup and drops every script. That is what makes it fast and what makes the archive readable in twenty years — but on a modern site the *chrome* is JavaScript, and without it three things misbehave. The reader settles them:

| What you would see | Why | What the reader does |
| --- | --- | --- |
| A large blank gap above the content | An ad slot reserves its height in CSS and waits for a script to fill or collapse it | A reserved box with nothing in it is hidden |
| A header stranded in the middle of the article as you scroll | `position: sticky`, positioned by a scroll handler that is no longer there | Sticky elements return to `static`, the flow they were written for |
| Blocks pulsing forever | Skeleton placeholders animating until content arrives, which it never does | Animations run once and stop |

None of this is a bad capture — every one of those elements is stored faithfully. It is chrome that only ever made sense with a script behind it. Each rule fires only on the exact condition it names, so an encyclopedia article (no empty ad slots, nothing pulsing) is untouched.

A page captured by **alive** keeps its scripts and does not need this; see [Creating ZIMs](creation.md) for what each engine trades away.

## Configure

| Setting | Where | Default | Effect |
| --- | --- | --- | --- |
| Reader theme | reader menu | follows app theme | `dark` / `light` / `sepia` for article text |
| Reader font + size | reader menu | system | Typeface and scale inside Reader View |
| Auto Reader View | reader menu | off | Open every article straight into Reader View |
| `?a11y=1` | content URL | off | Server-side accessibility rewrite of the article |
| Word lookup | — | automatic | Active when any Wiktionary ZIM is installed; dormant otherwise |

## Troubleshoot

- **Bookmarks vanished / a private window shows none** — you are signed in as an admin without a named user, so they live in that browser only. Create a named account and they follow you. See [Users & access](users-and-access.md).
- **Selecting a word does nothing** — no Wiktionary is installed. Add one from the catalog and the gesture starts working; nothing else needs enabling.
- **An old version of the interface keeps loading** — a hard reload clears it. The service worker takes over on the next load after a deploy; a page left open from before will still be on the old bundle.
- **A captured page still shows a gap or a stranded header** — the settling rules run in Zimi's reader. Opening the same `.zim` in another reader will show the page as captured, gap and all.
- **A link in a captured page leads nowhere** — only pages inside the capture were saved. Zimi shows what the link pointed at and offers the live address rather than a raw error.
- **An image is missing in a captured page** — see [Creating ZIMs](creation.md); the engine you chose decides which image sizes the archive holds.
