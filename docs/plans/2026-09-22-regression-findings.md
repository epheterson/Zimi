# Regression pass findings (2026-09-22)

Verified against a copy of the live library (78 ZIMs) on the NAS: a second 1.10.1 container, ZIM folder read-only, its own data folder, LAN only.

## DYM-1 Did-you-mean degrades silently after a restart

Found: live `dym_vocab.json` was from 2026-07-28 and did not match the current title indexes (signature mismatch), so every live boot since late July started with no vocabulary. The vocabulary is built only when the first sparse search arrives; that search gets no suggestion, nor does any other for the 3 to 5 minutes the build takes. On the test instance the build ran during index warm-up, hit its 300 s budget after 3 of 60 indexes, and was persisted as if complete (450k words instead of 674k); later boots would load that partial vocabulary indefinitely.

Measured: a full build on the live container takes 202 s idle (budget 300 s) and yields 1,225,424 words from 78/78 indexes; with it, photosynthsis, mitochondira, chlorofyll and einstien all correct.

Repaired by hand on live (built and persisted a full vocabulary in the live container; it now matches the indexes).

Open: why no build on live ever persisted between July and now (old container logs are gone).

Fix to make:
- Build (or load) the vocabulary in the background after startup, after READY and warm-up, not on the first search.
- A budget-truncated build is used in memory but persisted as partial, and a partial cache triggers a background completion instead of being loaded as final.
- Test: a truncated build is never loaded as complete on the next start; the vocabulary is ready without any search having happened.
