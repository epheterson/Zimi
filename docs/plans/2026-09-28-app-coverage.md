# App coverage across the Kiwix catalog, and an adapter plan

2026-09-28. Asked by Eric on 2026-09-27: "We should have more than Gutenberg in the book app, support as many as we can across all the apps as well. Be sure to support our own."

Read-only audit. Nothing in the repo changed.

## How this was measured

- **Catalog:** `zimi/assets/catalog-snapshot.json.gz` (built 2026-09-16, 2,653 entries). A family is grouped by the download directory (`/zim/<dir>/`) plus the name prefix. The catalog carries no Scraper field, so the scraper was read from the ZIMs themselves.
- **Local inspection (python libzim):** the smallest ZIM of each family that fit under 150 MB. 16 files, 509 MB in total: wikisource_eo, wikibooks_sv, zimgit-water, prunelle_en_draw-your-african-story, openmusictheory, ncert-audiobooks, shamela.ws_ar_al-mantiq, htdp, opendatastructures, learningstatisticswithr, media-eleda, gutenberg_ale, phet_oc, freecodecamp_it_coding-interview-prep, devdocs_en_python, phzh_core-italian-one. All deleted afterwards.
- **Remote inspection (too big to download):** a ~180-line reader (`rzim.py`, scratch only) that fetches just the ZIM header, the metadata, the directory entries and the odd listing file from the Kiwix download mirrors using HTTP range requests. It was checked against libzim on zimgit-water (same entry count, metadata and paths). I used it on 43 large ZIMs, and to read the Scraper/Creator/Tags metadata of every ZIM in `other/` and `videos/` (357 ZIMs, results in `census2.tsv`).
- **Not used:** browse.library.kiwix.org now puts an "Access confirmation" page in front of `/raw/`, which Kiwix added to stop AI crawlers. I did not try to get around it.

## 1. Coverage matrix

What decides an app today: `server._zim_kind` (server.py:1929). It looks at the Scraper prefix and the Name, **in this order**: map, video (`ted2zim`, `youtube2zim`, `Zimi … yt-dlp`), qa (`sotoki`), reddit (`arcticzim`), wiki (`mwoffliner`, or a Name starting with a Wikimedia project), books (`gutenberg2zim` or `gutenberg_`). Each app then keeps only its own kind: Bookshelf `books.py:233`, ZimiTube `tube.py:370` `reader_for`, Reddot `reddot.py:597`, Zimipedia `wiki.py:141`.

### Bookshelf (reads Gutenberg only)

| Family | ZIMs | Size | Read today | Structure (evidence) | Adapter |
|---|---|---|---|---|---|
| Gutenberg (`gutenberg2zim`) | 103 | 731.4 GB | yes | `full_by_popularity.js`, `languages.js` and the Dublin Core in each book's head | exists |
| Wikisource (`mwoffliner`) | 66 | 81.8 GB | no. The kind check routes it to Zimipedia before `books` is tested (server.py:1951 returns before 1953) | A work is a top-level path and its chapters are subpages (`Work/Chapter`). The `Page:`/`Index:` scan namespaces make up most entries (eo: 22,205 of 36,046). Every work page carries **`<div id="ws-data">`** with `ws-type`, `ws-title`, `ws-author`/`ws-translator`, `ws-year`, `ws-publisher` and a COinS span. It is on 94% of the non-Page pages in eo (11,565 of 12,333). eo has 158 works with subpages and 960 single top-level pages | Medium. Pull `#ws-data` out of the first 60 KB of each page, the way Gutenberg's head is read, in a details build. Group by the path root and skip the Page/Index namespaces |
| Wikibooks (`mwoffliner`) | 76 | 15.1 GB | no (Zimipedia) | A book is a path prefix, `Book/Chapter`. In sv, 60 prefixes have 3 or more subpages and 59 of them have a root page, which is the table of contents. No author metadata (collaborative) and no listing file | Small to medium. A book is a prefix with 3 or more subpages, its root page is the entry, and its links give the chapter order |
| LibreTexts (`mindtouch2zim v0.1.1`) | 13 | 17.3 GB | no, and no app at all | **`content/shared.json`** holds the whole page tree as `{id,title,path}` (stats: 12,598 pages). Books sit at `Bookshelves/<area>/<book>` and `Courses/<campus>/<book>` (290 at depth 3 in stats). Pages are `index/page_<id>`, bodies are `content/page_content_<id>.json`. Drop `Workbench`, `Under_Construction` and `Sandboxes` | **Small.** One JSON file per ZIM, like Gutenberg |
| nautilus libraries (`nautiluszim`): maitre_lucas 34 (17.3 GB), youscribe 4 (7.3 GB, including `youscribe_fr_audiobooks` with 530 audio/ogg), moldova 9 (4.0), prunelle 6 (2.9), diksha 2 (2.2), zimgit-* 5 (0.9), editions-ganndal, wiki-africa, zaya, usda-2015, python-class-vc. Their Counter metadata adds up to 3,895 documents, 201 videos and 530 audio files. 22 of the ZIMs mix documents and video | 65 | 35.6 GB | the list shows only for names starting `zimgit-` (app.js:6440, `search.parse_catalog` at search.py:1217). No app | **`database.js`**: `var DATABASE=[{'_id','ti','dsc','aut','fp':[…]}]`, a Python literal, files under `files/<fp>`. The items mix PDFs and **mp4** (maitre_lucas_planete_terre has 8 PDF and 8 video/mp4) | **Smallest.** The parser already exists. Detect by Scraper `nautiluszim`, split on the `fp` extension: pdf/epub/odt go to Bookshelf, mp4/webm/mp3 go to ZimiTube |
| Kolibri storybooks: africanstorybook.org_mul_all | 1 | 8.7 GB | no | **No Scraper, no Tags**, Creator `Kolibri`. The topic tree is hash-named HTML: Language, then Level, then the book. A leaf page has `<h1>` title, a description, "Author: …", "License: …", and `<hash>.epub` shown in the ZIM's own `assets/epub_embed.html`. 5,165 EPUBs across 126 languages. No JSON index | Medium. Walk the tree from the main page (breadcrumbs give language and level) and read each leaf's h1 and Author in a details build. Detect by Tag `kolibri`, or Creator `Kolibri`, or an `assets/epub_embed.html` entry |
| Lilote (`lilote_fr_fo`, no Scraper) | 1 | 0.73 GB | no | Per book `<slug>.json` holds `{title, author_book, book_editor, book_theme, level, pdf, cover, question_export}`, plus `<slug>.pdf` and a `<slug>.quiz` page. About 300 books | Small, but a single ZIM |
| Whole-ZIM single books (zimit): jeffe Algorithms, stacks.math, opendatastructures, openmusictheory, htdp, learningstatisticswithr, learningstatistics, ethanweed, mspeekenbrink, OpSec Bible, anonymousplanet | 11 | ~1.1 GB | no | warc2zim/zimit with `_category:other` and nothing that marks it as a book. The main page is the table of contents (htdp: `Book/index.html`, 20 links in order). Some ship the whole-book PDF (opendatastructures has 34, learningstatisticswithr has 1) | Small. A curated list of Names shipped in assets, plus a per-ZIM "this is a book" override. One card per ZIM, cover from the Illustration, chapters from the main page's links |
| zimit document libraries: survivorlibrary (14,464 PDF), alexandria.dk (5,329 PDF), armypubs (5,768 PDF), bnr (2,292 PDF + 1,294 EPUB), bouquineux (2,588 EPUB), cd3wd, irp.fas | 7 | ~315 GB | no | The files are ordinary entries. **A dirent title is just the path**. Anchor text links most of them (opendatastructures: 34 of 34 named from 1,153 pages in 1.5 s). survivorlibrary file names carry the title and year (`(socialism)-bankruptcy_of_reform_1932.pdf`) | Medium. One generic "documents in this ZIM" pass: walk the entries by mimetype, name each file from the anchor text that links to it, fall back to the file name. The Counter metadata says up front whether there are any |
| zimit HTML book sites: shamela.ws (14), booksdash, marxists (2), liberius, athena, bibnum | 20 | ~74 GB | no | Site-specific. shamela: `category/<n>` lists books, `book/<id>` is the card (author with death year, editor, publisher, page count, contents), pages are `book/<id>/<n>`. booksdash is a WordPress capture (118k entries, 115k JPEG) | One site parser each. Last |
| Sheet music (zimit): mutopia (3,911 PDF), chopin, celticscores, breizh, partituras, tomlehrer | 6 | ~32 GB | no | PDFs under per-piece pages | Covered by the generic documents pass. A "Scores" shelf is a view, not a new adapter |
| ncert-audiobooks | 1 | 11 MB | no | **The audio is not in the ZIM.** 288 pages use `<audio><source src="../storage/…mp3">` but there are no mp3 entries (checked with `has_entry_by_path`) | Not worth building. The defect is upstream in the zimit recipe |

### ZimiTube (reads ted2zim 2/3, youtube2zim 2/3, Zimi yt-dlp)

| Family | ZIMs | Size | Read today | Note |
|---|---|---|---|---|
| TED (`ted2zim 3.1.0`) | 357 | 651.1 GB | yes | |
| YouTube channels (`youtube2zim` 3.x) | 175 | 288.4 GB | yes | All 170 ZIMs in `videos/` are youtube2zim, whatever their tags say. That includes `videos/` ZIMs without the `youtube` tag (cest-pas-sorcier, canadian-prepper, science-in-the-bath, slam-out-loud were all verified as youtube2zim 3.x) and `litterature-audio-poetry_fr` (audio, youtube2zim 3.3.0) |
| Khan Academy (Kolibri: Tags `khan-academy;kolibri`, **no Scraper**) | 3 | 441.8 GB | **no** | tube.py:14 says youtube2zim covers Khan Academy. The catalog builds are Kolibri. Same hash-named topic tree as African Storybook: `.webm` leaves, 241,759 Perseus exercise JSON files |
| nautilus videos and audio (mostly maitre_lucas; youscribe audiobooks) | 26 with video, 1 with audio | 19.8 GB and 5.0 GB | no | 201 mp4 and 530 ogg files, read through the same `database.js` adapter as the documents |
| MOOCs (`openedx2zim 1.0.1`, 2022) | 5 | 0.5 GB | no | Old A/ namespace. Too small to justify a reader: open the main page |
| education-et-numerique (`scraper-1.0.1`) | 1 | 3.8 GB | no | custom scraper, skip |

### ZimiExchange, Reddot, Maps, Zimipedia

- **ZimiExchange:** stack_exchange 181 ZIMs, 191.1 GB, all sotoki. Complete.
- **Reddot:** the catalog has no ArcticZim ZIMs. Only Zimi's own `r/<sub>` captures. Complete for what exists.
- **Maps:** maps 193 ZIMs, 330.5 GB (maps2zim), plus StreetZim/AtlasZim from outside the catalog. Complete.
- **Zimipedia:** Wikipedia 538, Wiktionary 146, Wikiquote 67, Wikivoyage 24, Wikiversity 17, Wikibooks 76, Wikisource 66, Wikispecies 1 and Vikidia 8, plus 95 mwoffliner wikis in `other/` (112.9 GB). All are read by Scraper today. Six older wikis have no Scraper and a Name Zimi does not recognise, so they are not read: theworldfactbook, ubuntuusers, kiwix.ekopedia, kiwix.westeros, kiwix.ecured, plume-app. That gap is small. `folgerpedia.folger.edu_en_all` is a MediaWiki that zimit captured (warc2zim): a real example of the site-captured wiki question in section 3.

### Families that suggest a new app

| Family | ZIMs / size | Structure | Recommendation |
|---|---|---|---|
| PhET (`openzim/phet`) | 114 / 7.8 GB | **`catalog.js`**: `window.importedData = {simsByLanguage:{<lang>:[{id,title,categories,topics}]}}`. The sim is `<id>_<lang>.html` and its thumbnail is `<id>.png` | **Build it ("Labs").** One file per ZIM, 114 languages, and nothing else in Zimi is interactive like it |
| iFixit (no Scraper, Tags `iFixit`) | 12 / 42.7 GB | 740k entries, 188k HTML guides, 498k webp. Too big to walk remotely | Later. The ZIM's own UI is usable. A "Repair" app needs a guide walker |
| freeCodeCamp (`fcc2zim v2.0.3`) | 45 / 0.3 GB | `content/curriculum/index.json` lists `{title, slug}` per course and block. The ZIM is its own SPA with a code runner | Do not build it. Opening the main page already works |
| devdocs (`devdocs2zim v0.2.1`) | 231 / 0.6 GB | `navbar.json`: `{name, version, children:[{name, href}]}` | Not an app. Use navbar.json as a search scope or table of contents |

## 2. Inspections, evidence per family

(See the tables. Raw dumps are in `remote/*.txt` and `census2.tsv` in this folder.) Families I could not inspect in content: booksdash, bnr, bouquineux, liberius, marxists, alexandria, armypubs and survivorlibrary beyond metadata, path shapes and Counter. iFixit's path list is too large for the remote reader (62 MB of directory entries). Khan Academy only by metadata and root entries.

## 3. Zimi's own ZIMs

Two classifiers already exist. `_zim_kind` (server.py:1929) picks the app. `_zimi_kind` (http.py:1053) reads provenance: `X-Zimi-History` mode `folder|page|pages|site|video|bookmarks`, `Zimi ` in the Scraper, or the `zimi:alive` tag. Both run on metadata that `_extract_zim_metadata` already loops over (server.py:2927), so extra rules cost no I/O. `Counter` is among those keys and lists every mimetype with its count.

| What Zimi makes | Metadata it writes | App today | Should be | Missing |
|---|---|---|---|---|
| `zimi create <video URL>` (video.py) | Scraper `Zimi x + yt-dlp v`, history `video`, `videos.json` | ZimiTube | ZimiTube | nothing (audio-only is handled: tube.py:362 lists m4a/mp3/opus) |
| `zimi create r/<sub>` (reddot.py:317) | ArcticZim writes the file. **No X-Zimi-History, no Zimi Scraper suffix** | Reddot (Scraper `arcticzim`) | Reddot | provenance: Reddot ZIMs get no "made by Zimi" badge (`_zimi_kind` returns None). Pass a Scraper suffix, or add history after the build |
| folder with PDF/EPUB (creator.py:823-960) | Scraper `Zimi x`, history `folder` with counts, **no document listing**. Files are written as plain assets and listed only in the generated index HTML | none | **Bookshelf** | (1) at create time, write a listing of the documents. Recommendation: write nautilus's `database.js` shape (`ti`, `aut`, `dsc`, `fp`) so the nautilus adapter reads Zimi and Kiwix libraries alike. Fill title, author and date from the EPUB's OPF (stdlib zipfile) and from the PDF Info when PyMuPDF is present, else from the file name, with the cover from the EPUB. (2) Detect: history mode `folder` plus a Counter with `application/pdf` or `application/epub+zip`. (3) **EPUBs cannot be read in the browser today.** http.py:3451 forces a download, so Bookshelf would show EPUB-only books it cannot open. Serve an EPUB's spine chapters out of the zip on the server (stdlib) rather than vendoring epub.js |
| folder with video/audio | history `folder`, Counter `video/*` / `audio/*` | none (the kind needs `yt-dlp` in the Scraper, server.py:1944) | ZimiTube | detect by history plus Counter, and write a `videos.json` at create time (the tube `_zimi` reader already reads it, tube.py:338) |
| site capture (crawler.py:945, history `site`), zimit/alive/import (warc2zim, Scraper suffix only) | Source URL, counts | none | normally the plain reader. A captured **book site** belongs in Bookshelf through the generic documents pass or the "this is a book" override. A captured **MediaWiki** should *not* go to Zimipedia: Zimipedia's Today page relies on mwoffliner paths and Wikipedia date pages | if wanted later: record `<meta name=generator content="MediaWiki…">` as a tag at capture time. Only charset metas are rewritten (creator.py:171-196), so the meta likely survives. Not verified |
| page/pages, bookmarks export | history `page`, `pages`, `bookmarks` | none | none | nothing |

## 4. Recommended order (most content per unit of work)

1. **nautilus `database.js` into both Bookshelf and ZimiTube.** The parser exists (search.py:1217). Detect by Scraper `nautiluszim`. This is the only adapter that feeds two apps. Covers 65 ZIMs and 35.6 GB (3,895 documents, 201 videos, 530 audiobook tracks). Audiobooks (`youscribe_fr_audiobooks`) belong on the shelf and play in ZimiTube's player.
2. **LibreTexts.** 13 ZIMs, 17.3 GB, hundreds of textbooks from one `content/shared.json` per ZIM.
3. **Wikisource and Wikibooks in Bookshelf** (142 ZIMs, 97 GB). They stay kind `wiki` for Zimipedia and Bookshelf also takes `project in (wikisource, wikibooks)` (`_wiki_project`, server.py:1900). Wikisource reads `#ws-data` in a details build. Wikibooks is prefix grouping.
4. **Zimi's own folder ZIMs.** Write the listing at create time, add server-side EPUB chapter serving (which also unlocks Gutenberg's EPUB-only books, `books_epub_only`), and fix Reddot provenance.
5. **Whole-ZIM books.** A shipped list of about 11 Names plus an override. An hour of work, but little content (1.1 GB).
6. **PhET "Labs".** A new app, one JSON file per ZIM, 114 ZIMs.
7. **Kolibri (African Storybook plus Khan Academy)**, one tree walker for both apps: 5,165 storybooks and 442 GB of Khan. Medium effort, and needs a details build.
8. **Generic documents pass for zimit PDF/EPUB libraries** (survivorlibrary, bnr, bouquineux, armypubs, alexandria, sheet music). Big content (~350 GB) but noisy titles.
9. Site-specific parsers (shamela, booksdash, marxists). Last, one at a time, only on demand.

Skip: ncert-audiobooks (no audio inside), openedx MOOCs, freeCodeCamp, devdocs as an app, iFixit for now.
