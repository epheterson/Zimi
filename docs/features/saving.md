# Saving

One place for everything you keep: bookmarks, lists, Liked, and where you were in a book. Every app shows its own part of it, and the Saved panel shows all of it.

## How it works

**A saved item** is one thing kept: what it is (an article, a book, a video, a question, a post or a place on a map), its ZIM and page, a title, the app it belongs to, where you were in it (the section of an article, the place in a book, the time in a video, the view of a map) and when you saved it. The bookmark button in the header saves what is on screen, or lets it go; **B** does the same.

**Lists** are named groups, and an item can be in as many as you like: a "Portugal trip" list can hold a Wikivoyage guide, a place on a map and a TED talk. **Liked** is a list every library has. An item's menu has **Lists**, with a tick beside each list it is in and **New list** at the bottom.

**Continue** is where you were: the books you are reading, the latest first. It is not a list; it fills itself as you read, and **Remove from Continue** takes a book off it.

**Highlights** work the same in every reader: an article, Reader View, a book in pages or scrolling, an EPUB's chapters, Zimipedia. Select text (on a phone, with the usual handles) and a small bar offers **Highlight**, **Note** and **Copy** (and **Define** for one word when a Wiktionary is installed). Tap a highlight to change its color (yellow, green, blue or pink), write or edit its note, copy it or remove it; a highlight with a note is underlined. Highlighting a page saves the page too, so it can go in lists; removing the page from Saved keeps its highlights. A highlight is found again by what it says, so it comes back after the text is laid out again, in another font or size, on another page of a book, and in a newer build of the same ZIM as long as the passage is still there. One that is not in the page any more is never dropped: the page says how many are missing, and the Saved panel marks each one **Not found in this version**.

**The Saved panel** (the header's panel button, or **B** on the home page) shows Continue, Liked and your lists, each with its items (and a highlighted page's highlights under it), then what is in no list, then **Highlights**: every highlight, the latest first, each opening at its place in the text. Opened over an app, it shows that app's own first, with **All** beside it. Make a list with **New list**; rename, export or delete one from its menu (deleting a list keeps its items saved); drag a list to reorder the lists; drag an item into another list to move it, onto **Not in a list** to take it out, or along its list to reorder. Opening an item takes you back where you were: an article at its section, a book at its page, a place on its map, a video, question or post in its app.

**Export to ZIM** turns lists into one ZIM you can keep or share: each ticked list becomes a section of it. A list's own menu opens the export with that list alone ticked.

**In each app.** Bookshelf shows **Continue reading** (how far you are in each book) and **My shelf** (the books you keep: **Add to my shelf** on a book's page). ZimiTube, ZimiExchange, Reddot and Maps save videos, questions, posts and places with the same button; their own views of what you saved come later.

**Where it is kept.** Signed out, in this browser. Signed in with a named account, with the account on the server as well, so what you save on the phone is on the tablet and a book read on one continues on the other. Each device keeps working without the server and catches up when it can: the account's copy is fetched when a page is idle, a change goes up two seconds after it is made (a place in a book at most every twenty seconds), and leaving the tab sends what is waiting. A delete on one device holds when another device syncs later: every deletion is remembered for 90 days, so only a device away for longer than that can bring back something deleted meanwhile. Each account keeps its own copy in the browser, so signing out on a shared screen leaves nothing of yours for the next person.

**From earlier versions.** Bookmarks and their folders come in the first time a browser (or an account on it) opens 1.12: each folder becomes a list named by its path ("Travel / Portugal"), in the same order, with its bookmarks in their order; a bookmark at the top level is saved in no list; a map's bookmark keeps its place; Bookshelf's places become Continue. An account's bookmarks saved to the server by an earlier version come in the same way, once. The old keys stay in the browser for one release, so going back to 1.11 still finds them.

### For an app page

An app page (the pages under `zimi/static/`, shown in the reader) calls the shell's store directly: same origin, so `saved()` from `apps.js` returns `window.parent.Saved`, or `null` when the page is opened on its own. A change from anywhere (the page, the panel, another device) reaches the page as `window.__saved()`, which the page defines to redraw its part.

```js
var S = saved();
var key = S.save({ kind: 'book', app: 'books', zim: b.zim, path: b.path, title: b.title,
  meta: { id: b.id, author: b.author, cover: b.cover } });   // add or update; returns the key
S.has(key); S.get(key);          // {key, kind, zim, path, title, app, where, meta, added, lists}
S.remove(key);                   // from every list, on every device
S.itemsFor({ app: 'books' });    // this app's items, the latest first
S.itemsFor({ list: id });        // a list's items in its order ('' is the items in no list)
S.lists({ app: 'books' });       // [{id, name, builtin, count}], Liked first; name '' for Liked
S.createList(name); S.renameList(id, name); S.deleteList(id); S.moveList(id, beforeId);
S.addToList(keyOrItem, id, beforeKey); S.moveInList(key, id, beforeKey); S.removeFromList(key, id);
S.inList(key, id); S.LIKED;      // 'liked'
S.setPosition({ kind: 'video', app: 'tube', zim: z, path: p, title: t }, { t: 312, d: 900 });
S.position(key);                 // {key, kind, zim, path, app, title, meta, where, ts} or null
S.continued({ app: 'tube' });    // positions, the latest first
S.clearPosition(key);
window.__saved = function () { /* redraw what shows saved things */ };
```

A key is the ZIM's name and the page, `zim + '\n' + path`, and for a place the map view too (`+ '\n' + where.pos`), so one map can hold many places. The ZIM's name is its short name (`wikipedia`, `osm-hawaii`), the same across builds, so a new build of a ZIM keeps its saved things. `where` is a few short fields: `{s}` a section, `{f, c}` a book (share read, character), `{t, d}` a video (seconds), `{pos}` a map view. `meta` is what the app needs to draw a card without asking the server. Kinds: `article`, `book`, `video`, `question`, `post`, `place`; the app follows from the kind when not given.

### Highlights in a page's own text

A reader Zimi shows (an article, a book, an EPUB) gets highlights from the shell with nothing to do. A page that draws text of its own to read (Zimipedia's article) attaches the same engine to it. `highlights()` from `apps.js` returns the shell's `Highlights`, or `null` outside the shell. `attach` costs nothing on the page's first paint: the engine (`/static/highlights.js`) loads only when the page already has highlights or when text is selected in it.

```js
var H = highlights();
var hl = H && H.attach(document, { kind: 'article', app: 'wiki', zim: z, path: p, title: t },
  { root: articleEl });           // root: what holds the text (default: the body)
hl.refresh();                     // the text was drawn again (a re-render, a toggle): found again
hl.goTo(id);                      // bring one into view, flashed
hl.missing();                     // ids not found in this text ([] until the engine has looked)
hl.detach();                      // the page shows something else; attach again for the next
H.open(h);                        // open a highlight at its place, as the Saved panel does
S.highlights({ zim: z, path: p }); // a page's highlights, in the order of the text
S.highlights({ app: 'wiki' });     // an app's (or {} for all), the latest first
S.getHighlight(id); S.highlight({ id: id, note: 'why', color: 'green' }); S.removeHighlight(id);
```

`attach` takes one more option, `show(range)`: how to bring a passage into view when the page does not simply scroll (the book reader turns to its page). The ref is the saved item the page stands for, as `S.save` takes it: highlighting saves it. Call `attach` once per document shown, and `detach` before the text is replaced by another page's; a page that redraws the same text in place calls `refresh`. The bar, the note card and the colors are the shell's; nothing is injected into the page but one stylesheet. A highlight is `{id, zim, path, kind, app, title, exact, prefix, suffix, pos, color, note, added, ts}` (a passage longer than 600 characters keeps its first 300 in `exact` and its last in `end`, with `n` its length): `exact` is the passage as read, `prefix` and `suffix` a little of the text around it (lower case, without spaces), `pos` where it starts as a share of the page's text. It is found by comparing text without spaces and in lower case, the context around each match deciding between repeats of the same words and `pos` between repeats with the same context. Colors are `yellow`, `green`, `blue`, `pink`.

## Configure

Nothing to set. What is kept is stored under `zimi_saved` in the browser (`zimi_saved:<account>` for a signed-in account's copy) and, for a named account, in its data file under `ZIMI_DATA_DIR/userdata/`, which a server backup includes. The My data card's Export and Import carry it to and from a file.

## Troubleshoot

- **Saved things did not follow me to another device**: both must be signed in with the same named account; an admin without a named account keeps them in that browser only. See [Access](access.md). They arrive when the page is idle or when you come back to the tab after a minute.
- **Something I deleted came back**: a device that had not synced for more than 90 days can bring back what was deleted meanwhile. Delete it again.
- **A highlight says "Not found in this version"**: the page opened on this device no longer has its words (a newer build of the ZIM changed or dropped them). It is kept, on every device; if the passage comes back, or you open it where the older build is, it shows again. Remove it from its menu if it is gone for good.
- **Selecting text shows no Highlight bar**: highlights are offered in a reader (an article, a book, an EPUB, Zimipedia), not on a map, in the PDF viewer or in an app's own lists.
- **A saved item says "Source no longer installed"**: its ZIM is not in the library (removed, or not allowed for this account). It opens again when the ZIM is back.
