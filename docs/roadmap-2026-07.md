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

## Addendum 2026-07-21 (Eric, post-1.7.5): roadmap reshuffle

- **1.8 hero: Almanac → library deep-links.** Every almanac entity (planets,
  stars, constellations, meteor showers, eclipses, holidays, calendar systems,
  zodiac, deep-time eras) links to the matching article when a Wikipedia (or
  suitable) ZIM is installed — language-matched via the existing interlang /
  Q-ID machinery, opened in the Zimi reader (now with Reader View). Fail-soft:
  no matching ZIM → no link, zero clutter. "Another step towards offline
  internet — feeling online while all in Zimi." Do it right, not fast:
  entity→article mapping table (Q-IDs where possible, title fallback),
  per-language resolution, availability probe against the installed library.
  Generalizes: any Zimi mini-app becomes a portal into the library.
- **Chatbot ("chat with your library") → 2.0** — possibly as the Time Machine
  voice/video librarian itself. 1.8's hero is the almanac-linking instead.

## Addendum 2026-07-23 (Eric, post-1.8 users-light): 1.9 = Industry Edition

Decision: named users STAY light in 1.8 (basic accounts, roles, per-user
allowlists, admin password reset, last-login). The full user/identity machinery
moves to **1.9, reframed as the "Industry Edition"** — the enterprise / fleet /
school tier. "Figure out what enterprise needs." Users-v2 (emails, resets, kid
modes, monitoring ethics, schools) folds INTO this, not a separate track.

What enterprise buyers actually require (research summary, build order TBD):

- **Identity / SSO.** OAuth2 / OIDC login (Google Workspace, Entra ID, Okta,
  Keycloak) so Zimi isn't a separate password island. SAML is the enterprise
  long-tail; OIDC first. Map IdP groups → Zimi roles at login.
- **User provisioning.** SCIM 2.0 for auto-provision/deprovision from the IdP,
  plus a pragmatic CSV/JSON bulk import for air-gapped sites with no live IdP.
  Both write the same users.json-shaped store the light version already owns.
- **Group-based policy.** Today's per-user allowlist doesn't scale to 500 kids.
  Need per-GROUP ZIM policies (class "Grade 7" → this shelf), users inherit from
  group, individual override optional. The allowlist choke point already exists;
  add a group layer above it.
- **Audit logs.** Who logged in, who changed a policy, who downloaded a ZIM —
  append-only, exportable (JSON lines / syslog). Distinct from monitoring what a
  user READS (that stays behind the ethics gate — see users-v2 note).
- **Private / forced-login mode.** An instance that serves NOTHING to anonymous
  visitors: no library, no read, until authenticated. Today anonymous = all
  access; enterprises need the inverse as a config flag.
- **Backup / restore.** One-command dump+restore of config, users, groups,
  policies, bookmarks (not the ZIMs — those are re-downloadable). Prereq for any
  serious deployment; already on the 1.9 "dependable library" list.
- **Fleet deployment.** Air-gapped bundles (ZIMs + image + config in one tar),
  docker-compose and k8s manifests, a headless config file (no click-through
  setup), and an "apply this policy set to N boxes" story for school districts /
  NGOs / ships / bases.
- **Update channels.** stable / beta channel selection, offline update bundles
  (download once on a connected box, sideload to the fleet), pinned versions —
  because enterprises don't auto-pull latest.
- **Monitoring / observability.** /metrics exists — expose it in **Prometheus
  text format** (or add a /metrics?format=prometheus) so it drops into existing
  Grafana stacks; documented healthcheck endpoint; structured JSON logs.
- **License / support posture.** Decide the commercial line: open core + a paid
  Industry Edition (SSO, SCIM, audit, support SLA) is the standard OSS-infra
  model. Even if unpriced now, gate the enterprise-only surfaces behind a clear
  edition boundary so the split is clean later.

Guiding cut: 1.8 stays the friendly single-admin + a few named users. 1.9 is
"deploy Zimi to 200 machines and hand it to IT" — identity, policy at scale,
audit, backup, fleet ops. Don't build 1.9 surfaces into 1.8; keep the light
store forward-compatible (it already is: roles + flags{} seam + allowlist choke
point).
