# ZIM editing — design

Eric, 2026-08-10: "How about some sort of zim editing after creation what are things folks might need to do? Add a new landing page or modify it linking to various things like a fax cover sheet. Or add and remove things resize images or videos convert all pages to reader mode I dunno what folks might want."

## The one honest constraint

The ZIM format is write-once. There is no in-place edit; every "edit" is really: open the existing ZIM, apply operations, write a new ZIM, swap it in. That constraint is a gift if we embrace it instead of hiding it: **editing in Zimi is derivation.** The original is never touched until the new file is verified, the swap is atomic (the same tmp-then-replace discipline everything else uses), and "undo" is trivial because the previous file can be kept as a `.prev` beside it. Nobody loses a library entry to a bad edit, ever.

## What people actually need (ranked by evidence)

From the landscape research (zim-requests, nautilus's collection.json pain, forum threads) plus what Eric named:

1. **A landing page you control** — Eric's "fax cover sheet." Every capture tool generates its own front page and everyone hates them. A cover composer: title, blurb, optional image, and a picker that links to entries inside the ZIM (and nothing else — links must resolve or they don't ship). This is also the top ask hiding inside nautilus complaints: people organize collections and want the front door to reflect the organization. Templates: cover sheet (title + links), index (auto tree, editable labels), gallery (thumbnails). **v1.**
2. **Add and remove entries** — drop three more PDFs into last month's field pack; prune the four pages the crawler grabbed that you didn't want. Remove is pure derivation (copy everything except); add reuses the folder-mode pipeline for the new files. **v1.**
3. **Metadata + icon** — title, description, language, the 48px icon. Cheap, constantly wanted, and the icon is what makes a created ZIM feel real on the shelf. **v1.**
4. **Shrink media** — "resize images or videos." Images: re-encode over a size/quality cap during rebuild (Pillow soft-dep, honest skip when absent). Video: transcode needs ffmpeg — soft-dep like yt-dlp, and slow on a Pi by nature; the job model already streams progress, so slow is survivable. **v2, images maybe v1 if Pillow is already around.**
5. **Reader-mode all pages** — strip site chrome from captured pages down to article text. We already ship an accessibility rewriter (`a11y.py`) that knows how to walk and rewrite ZIM HTML; this is a batch application of that idea with a readability pass. Genuinely differentiating — no other ZIM tool offers it. **v2.**
6. **Merge two ZIMs** — the trip-pack builder in disguise. **v2, pairs with the delight-pass "trip packs" idea.**

## The UI shape

An **Edit** action on a library card (admin-only, any ZIM — not just created ones; pruning a downloaded ZIM is legitimate). It opens the same full-page surface pattern as Create, with the operation list on the left and a live preview iframe on the right where it matters (the cover composer is WYSIWYG-ish: edit fields, preview rerenders). Apply = one derivation job through the existing create-job machinery (one at a time, streamed progress, cancel-safe because the original is untouched).

The cover composer is the emotional center: pick "Cover sheet," type a title, click entries from a searchable list to add as links, drag to order, Apply. Two minutes from crawl to a ZIM that opens on *your* page.

## v1 cut (buildable now, ~2 lanes)

- Derivation engine: `zimi edit` core — copy-with-changes rebuild, entry add/remove, metadata/icon set, landing-page replace. Everything streams; never two copies of an entry in memory.
- Cover composer + entry add/remove + metadata in the Edit surface, on the create-job rails.
- CLI parity for scripting (`zimi edit <zim> --set-title ... --remove <path> --add <folder> --cover <html>`), since the engine is the same.

## Explicitly not

- In-place binary patching. Never; fights checksums, torrents, and sanity.
- A WYSIWYG HTML editor for arbitrary articles. That's a CMS; the moment we want it we should want the annotations-layer idea from the 2.0 list instead.

## Open questions for Eric

1. v1 cut as scoped (cover + add/remove + metadata) — go?
2. Keep `.prev` of the replaced ZIM by default (disk cost, instant undo) or make keeping opt-in?
3. Does Edit make 1.9, or is it the first 1.9.x headline? Honest note: 1.9 is enormous already, and Edit v1 is a fresh engine + a fresh surface — my instinct says it rides 1.9 only if your validation pass on everything else comes back clean.
