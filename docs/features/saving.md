# Saving

One place for everything you keep: bookmarks, lists, Liked, and where you were in a book. Every app shows its own part of it, and the Saved panel shows all of it.

## How it works

**A saved item** is one thing kept: what it is (an article, a book, a video, a question, a post or a place on a map), its ZIM and page, a title, the app it belongs to, where you were in it (the section of an article, the place in a book, the time in a video, the view of a map) and when you saved it. The bookmark button in the header saves what is on screen, or lets it go; **B** does the same.

**Lists** are named groups, and an item can be in as many as you like: a "Portugal trip" list can hold a Wikivoyage guide, a place on a map and a TED talk. **Liked** is a list every library has. An item's menu has **Lists**, with a tick beside each list it is in and **New list** at the bottom.

**Continue** is where you were: the books you are reading, the latest first. It is not a list; it fills itself as you read, and **Remove from Continue** takes a book off it.

**The Saved panel** (the header's panel button, or **B** on the home page) shows Continue, Liked and your lists, each with its items, then what is in no list. Opened over an app, it shows that app's own first, with **All** beside it. Make a list with **New list**; rename, export or delete one from its menu (deleting a list keeps its items saved); drag a list to reorder the lists; drag an item into another list to move it, onto **Not in a list** to take it out, or along its list to reorder. Opening an item takes you back where you were: an article at its section, a book at its page, a place on its map, a video, question or post in its app.

**Export to ZIM** turns lists into one ZIM you can keep or share: each ticked list becomes a section of it. A list's own menu opens the export with that list alone ticked.

**In each app.** Each app shows its own part, in place, and every one puts a thing in a list with the same picker the panel's **Lists** uses (a tick beside each list it is in, and **New list** typed in place).

- **Bookshelf** shows **Continue reading** (how far you are in each book) and **My shelf** (the books you keep: **Add to my shelf** on a book's page, with **Lists** beside it).
- **ZimiTube**: under a video, **Like**, **Watch later** and **Lists**. The home starts with your rows: **Continue watching** (where you stopped, a video at its time, an audiobook at its track; one watched to the end leaves it), **Watch later** (every video you keep), **Liked**, then each of your lists that holds a video.
- **ZimiExchange** and **Reddot**: under a question's or a post's title, **Like**, **Save** and **Lists**. **Saved** among the chips at the top lists what you kept, the latest first, with your lists as chips to narrow it. A long thread you saved opens again where you were in it, on any screen.
- **Maps**: the pin in the header is **Places and maps**. **Save this place** keeps the view on screen (its centre and zoom) under the name of the place your search found there, else the nearest town on the map; your places follow, this map's first. Tapping one flies there (on another map, that map opens there); its list button opens the picker. **B** saves the place too.

**Where it is kept.** Signed out, in this browser. Signed in with a named account, with the account on the server as well, so what you save on the phone is on the tablet and a book read on one continues on the other. Each device keeps working without the server and catches up when it can: the account's copy is fetched when a page is idle, a change goes up two seconds after it is made (a place in a book at most every twenty seconds), and leaving the tab sends what is waiting. A delete on one device holds when another device syncs later: every deletion is remembered for 90 days, so only a device away for longer than that can bring back something deleted meanwhile. Each account keeps its own copy in the browser, so signing out on a shared screen leaves nothing of yours for the next person.

**From earlier versions.** Bookmarks and their folders come in the first time a browser (or an account on it) opens 1.12: each folder becomes a list named by its path ("Travel / Portugal"), in the same order, with its bookmarks in their order; a bookmark at the top level is saved in no list; a map's bookmark keeps its place; Bookshelf's places become Continue. An account's bookmarks saved to the server by an earlier version come in the same way, once. The old keys stay in the browser for one release, so going back to 1.11 still finds them.

### For an app page

An app page (the pages under `zimi/static/`, shown in the reader) calls the shell's store directly: same origin, so `saved()` from `apps.js` returns `window.parent.Saved`, or `null` when the page is opened on its own. A change from anywhere (the page, the panel, another device) reaches the page as `window.__saved()`, which the page defines to redraw its part.

`apps.js` also holds the parts every app shares: `savedBar(item, opts)` draws Like, Save and Lists into each `<span class="svbar"></span>` of the page for the thing open (`savedBar(null)` as it closes; `opts.save` names Save in the app's words, `opts.thread` keeps where you are in a long thread), `savedPaint()` draws them again from the store (call it from `window.__saved`), `threadRestore()` scrolls a saved thread back to its place, `pickLists(item, el)` opens the shell's list picker over `el`, and `savedListChips(app, list, fn)` draws an app's lists as chips for its Saved view.

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

## Configure

Nothing to set. What is kept is stored under `zimi_saved` in the browser (`zimi_saved:<account>` for a signed-in account's copy) and, for a named account, in its data file under `ZIMI_DATA_DIR/userdata/`, which a server backup includes. The My data card's Export and Import carry it to and from a file.

## Troubleshoot

- **Saved things did not follow me to another device**: both must be signed in with the same named account; an admin without a named account keeps them in that browser only. See [Access](access.md). They arrive when the page is idle or when you come back to the tab after a minute.
- **Something I deleted came back**: a device that had not synced for more than 90 days can bring back what was deleted meanwhile. Delete it again.
- **A saved item says "Source no longer installed"**: its ZIM is not in the library (removed, or not allowed for this account). It opens again when the ZIM is back.
