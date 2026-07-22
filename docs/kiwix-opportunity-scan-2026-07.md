# Kiwix / offline-knowledge opportunity scan — 2026-07-20

Three-front research sweep (openZIM/Kiwix GitHub · community/HN · competitive
landscape) mining pain points and unmet needs Zimi can win on. Evidence links
inline. Tags: **[solved]** Zimi already does it · **[partial]** partly · **[new]**
build opportunity.

## The thesis (one line)
Zimi's durable edge is being the **machine interface to offline knowledge** at
the exact moment offline local-LLM agents became a real, commercializing
category. Kiwix owns content+format but exposes only HTML; the new AI wave
(Project NOMAD ~14K★, Prepper AI, Off-Grid AI, a forming MCP-Wikipedia cluster)
has agent demand but weak, single-source, bolted-on retrieval. **Zimi is the
missing grounding substrate** — clean HTTP+MCP, cross-source, ranked, cited.

## Ranked opportunities (demand × fit)

1. **Offline agent grounding layer (API + MCP)** — [solved, underexposed]
   Highest demand, most defensible. Kiwix has refused a JSON/RESTful search API
   for 6 years (kiwix-tools #368/#378); a cluster of single-source, English-only
   MCP-Wikipedia servers is forming (wiki-local-mcp: 1500-char index, 1★). Zimi's
   `/search`+`/read`+MCP is exactly the "LLM-as-index over a trusted corpus,
   with citations" shape the smartest HN voices ask for (HN 44617078). **Lead
   with this.** Anti-hallucination framing: retrieval-grounded, cites the ZIM
   page, refuses when not in corpus — never freeform generation.

2. **Court the prepper-AI wave as their backend** — [solved, go-to-market]
   NOMAD/Prepper AI/Off-Grid AI need a good retrieval backend; Zimi *is* one.
   Ride the wave instead of fighting it — "the knowledge tool your local LLM
   calls." Prepper AI is a walled 74-manual app; Zimi grounds on the 100M-article
   corpus people already hoard.

3. **Discovery — "which of 66 files do I download?"** — [solved, sharpen + market]
   The #1 community UX pain (Nelson's log; HN 47476821; Kiwix's own prepper page).
   Zimi's cross-source catalog, real entry counts, bundle/subset detection,
   category gallery already answer it. Bonus correctness win: Kiwix's OPDS inflates
   articleCount ~3× (kiwix-tools #767); Zimi computes real counts.

4. **Cross-source *ranked* search** — [solved, but win on quality not existence]
   Kiwix now ships multi-ZIM search, so the capability isn't unique — but it's
   HTML, unranked, no authority weighting. Zimi's win is *ranked/deduped/
   authority-scored JSON*: "the difference between grep and a search engine."
   Still the #1 *structural* GitHub complaint (libzim #932, desktop #315, apple
   #911, android #1324).

5. **P2P / LAN ZIM replication** — [solved, uniquely defensible, evangelize]
   Nobody else does node-to-node offline ZIM sync. Meshtastic itself can't carry
   large files, so Zimi's HTTP-direct `/dl/` + mDNS + BT is the *content layer
   above mesh signaling*. Community wants "complementary libraries across nearby
   devices, not identical 100GB copies" (HN 31365472). Demand quieter — sell it
   in the resilience/classroom segment.

6. **Delta / incremental updates** — [partial → new headline]
   Kiwix's own docs: full re-downloads waste ~80% bandwidth; zimdiff/zimpatch
   exist on paper but aren't in the flow (mediawiki Kiwix/ZIM incremental
   updates). Zimi's auto-updater is a start; **true delta updates would be a
   headline feature nobody ships well.**

7. **Server-first UX sidesteps the native-app mess** — [solved, market]
   Android stuck on a 2021 build, filesystem access fragile, search "takes a
   minute or 2, sometimes never comes out" (Nelson's log; kiwix-apple #627 34★
   storage location, #1260 hotspot fragility). Zimi's always-on server + clean
   web UI reachable from any LAN device is the mature answer.

8. **Search spelling-correction** — [new] libzim #731 (29c): "when I write the
   wrong word Wiktionary does not correct me." High demand, Zimi doesn't do it.

9. **Reader TTS + font scaling** — [new] kiwix-js #166 (open since 2016), many
   dupes. Proven durable demand; Zimi's reader could add it.

10. **Cross-language Q-ID linking** — [solved, niche] Genuinely unique offline,
    but low loud demand — a vitamin. Position for multilingual field/NGO
    deployments, not the lead.

## Positioning guidance
- **Lead:** "the grounding layer / machine interface for offline knowledge —
  cross-source, ranked, cited, MCP-native." Court the prepper-AI projects as a
  backend.
- **Resilience, not doom-cosplay:** censorship shutdowns, disasters, off-grid,
  education, "community network / share what you have" — the community *mocks*
  bunker aesthetics.
- **Be honest internally:** cross-source search is a *quality* wedge now that
  Kiwix ships multi-ZIM; the personal-notes-RAG market is crowded (Zimi's niche
  is the *encyclopedic* corpus, not your PDF folder); almanac is delight/demo,
  not market pull.

## Out of scope (don't chase)
ZIM *creation/editing* (libzim #1001 redirect-fragments 38★, #935/#934 edit,
zimit #525, zim-tools #69, mwoffliner #539) — Zimi is a reader/server, not a
builder. Storage/compression is a ZIM-format constraint, not Zimi-fixable.

## Suggested next moves
- **v1.8 (agent release):** double down on MCP — `/chunks` + citations, an
  OpenAPI spec, and a short "ground your local LLM on Zimi" README aimed at the
  NOMAD/Ollama crowd. This is the wedge.
- **A demo that sells it:** Claude (or a local LLM) answering a question with
  inline Zimi citations, fully offline.
- **Later:** spelling-correction + TTS (cheap credibility wins); delta updates
  (headline, harder); evangelize P2P in the prepper/classroom niche.

Sources: openZIM/Kiwix GitHub issues (linked by number above), HN 44617078 /
47476821 / 31365472 / 38512781, Nelson's log, projectnomad.us, offgridai.io,
docketoffline.ai, wiki-local-mcp, mediawiki Kiwix/ZIM incremental updates.
