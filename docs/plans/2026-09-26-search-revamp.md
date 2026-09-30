# Search revamp (next release)

Eric, 2026-09-26: "let's revamp search all around next release in catalog and library and within a zim and get all the things folks might expect". Started from #94 (tripplehelix): "`-ted` to remove those results. Google has a good list of types of search queries." Goal in his words: "Find more ZIM's!"

## Three places people search, one grammar

1. **Catalog** (Kiwix's ~1,000 downloadable ZIMs, filtered client-side in `browseCatalogFilter`).
2. **Library** (every installed ZIM: `search_all`, the title index, libzim full text, `suggest`).
3. **Within a ZIM** (`/search?zim=`, the source pills, the reader), and within the open article.

One query grammar, one parser with matching cases in Python and JS (branch `search-operators` is building it):
`-word` excludes, `"exact phrase"`, `OR`, and filters that map onto what search already has (`lang:`, source or type, a ZIM), never parallel machinery.

## What people expect (the checklist)

Grammar and filters
- [ ] `-word`, `"phrase"`, `OR` (hyphenated words like `e-mail` are not exclusions)
- [ ] `lang:fr`, `in:<source>` / type filters; shown as removable chips once typed
- [ ] Catalog: filter by language, category, size, date, with/without pictures (nopic/mini/maxi), installed or not; sort by relevance, newest, size, popularity

Results
- [ ] Matched words highlighted in titles and snippets
- [ ] Grouped by source with "more from this source"; paging past the first screen
- [ ] Exact title match first (already scored; keep it)
- [ ] Search inside PDFs of zimgit ZIMs and, where cheap, image captions

Within a ZIM and a page
- [ ] A clear "search in this ZIM" from the reader, scoped by default while reading
- [ ] Find in page (the open article), with next/previous and a count, on phone and desktop

Getting to an answer
- [ ] Nothing found: say why (a filter, a missing language), offer to drop it, and offer ZIMs from the catalog that would have it ("download a ZIM that has this")
- [ ] Did you mean (exists; extend to operators and filters)
- [ ] Recent searches, per user or browser
- [ ] The query and filters live in the URL, so a search can be shared and Back works
- [ ] Keyboard: arrows through results, Enter opens, Esc clears

Agents and API
- [ ] The grammar works in `/search`, `/suggest` and the MCP `search` tool; documented in api-and-mcp.md

## Guardrails
- Nothing slower on the primary path: measure `search_all` and first suggestion before and after on the NAS's largest library.
- Every item gets a test that fails on the old code; the reported sites and #86-style oracles stay green.
- All 10 languages; operators work with non-Latin words.

## Open questions for Eric
- Recent searches: per browser or per account? (Apps are per user or server, never per browser.)
- "Download a ZIM that has this": show catalog matches inline, or a link to the Catalog pre-filled?
