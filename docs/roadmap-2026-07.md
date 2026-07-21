# Zimi roadmap — locked down 2026-07-20

Captured before a context compaction so nothing is lost. Source threads: the
7/19 grow-up audit, the Kiwix opportunity scan (`docs/kiwix-opportunity-scan-2026-07.md`),
and the 1.7.4 session.

## The strategic read (why the next release is what it is)

Zimi is **already "made for agents"** — MCP server + JSON API ship today. So the
planned "agent release" work (`/chunks`, OpenAPI spec, kiwix-vs-Zimi benchmark)
is **catch-up / hardening of an existing capability, not a hero feature.** That
makes it 1.7.x-scale, not a 1.8-worthy minor bump on its own.

A real **1.8 needs a hero** — a "wtf, why haven't I been using this" moment.

### Hero candidate (recommended): "Chat with your offline library"
A built-in **grounded chat / librarian** UI in Zimi that answers from your ZIMs
with **inline citations**, talking to *your* local LLM (Ollama endpoint) — fully
offline. It turns Zimi from "a tool agents call" into "the thing **you** use to
ask all of human knowledge, offline, without hallucinations." It makes the wedge
(grounding, cited, no internet) **visible to non-developers**, and the demo GIF
(#20) becomes a real feature. Stays true to identity: Zimi is the knowledge
layer; the LLM is yours. This is the 2.0 "Time Machine librarian" vision pulled
forward because it's the actual wedge.
- Anti-hallucination framing is the whole point: retrieve → cite → refuse if not
  in corpus. Never freeform generation.
- Other hero options considered: **federated mesh search** (search neighbours'
  ZIMs across the LAN mesh — uniquely defensible, but narrower appeal); **offline
  semantic/vector search** — REJECTED per the audit ("no embeddings in-repo, that's
  the trap"; Zimi is the substrate RAG clients plug embeddings onto).

## Release plan (recommended)

- **1.7.5 — "catch-up / distribution" (next, point release):**
  - **libtorrent migration** (aria2 → rasterbar) — task #24. Removes the 4 aria2
    compensation layers; in-process real stats + resume; aria2 deleted (HTTP
    range is the universal download floor, BT is the optional accelerator).
  - **Agent-API hardening** — `/chunks?zim=&path=&size=&overlap=` with STABLE
    deterministic chunk IDs (no embeddings), MCP tools exposing it, an OpenAPI
    spec + API-stability contract, a kiwix-serve-vs-Zimi benchmark. (This is the
    "catch-up," correctly a point release, not a hero.)
  - **Polish batch** (the `polish` branch): Evening/Morning capitalization
    (done), meteor "Peak!" string (#23), CHANGELOG dup-Security fix, + whatever
    else Eric spots.
  - **Cheap credibility wins** (each a long-open Kiwix ask): spelling-correction
    (libzim #731), reader TTS (kiwix-js #166), font-scale, "Download this ZIM"
    button, show real article count.

- **1.8 — the HERO: "Chat with your offline library"** (grounded, cited, uses
  your local LLM, offline). Its own focused cycle. The wedge made visible.

- **1.9 — "dependable library":** backup/restore, server-side bookmarks;
  multi-user DECOUPLED (audit: "does anyone really want users? maybe we wait").

- **2.0 — AI / conversational** (folds into 1.8 if the hero lands early).

## Threads / open tasks (cross-reference)
- #9 deploy/merge/tag/publish (deploy+merge DONE; **tag + publish the draft
  release pending Eric's go** — draft titled "v1.7.4", 1.7 "Reach+Pro" theme up
  top, notes verified).
- #18 lighter README overhaul (Eric's voice; stale tests badge 543→660,
  screenshots refresh) · #19 sky terminator + true moon/sun water reflections ·
  #20 demo GIF · #21 Zimi&Kiwix comparison doc · #22 NOMAD partnership ·
  #23 meteor "Peak!" string · #24 libtorrent.
- NEW gaps captured this session (were falling through like libtorrent):
  1.7.5 agent-API hardening, 1.8 chat hero, v1.8/1.9 date/time editor redesign
  (see `project_v18_datetime_editor`), CF cache-purge token fix, CHANGELOG dedup.

## Process fix (Eric: "this is weird, change it for the future")
Deploy from **main after merge**, not from the release branch before review.
Batch small fixes onto a `polish` branch; one deploy when settled — no rebuild
per tweak.
