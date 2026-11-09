# zim-tools survey

Eric 2026-11-07: which of openZIM's tools can Zimi absorb, or make irrelevant. Written 2026-11-09 from what Zimi does today (read from the code, not from memory of the tools' flags).

| Tool | What it does | Zimi today | Verdict |
|---|---|---|---|
| zimcheck | Integrity (checksum), metadata (-M), internal links (-U), redirects, empty entries | The Manage health check reads entry counts, title and Q-ID indexes, media samples; `zimwriter` writes by the same metadata table | **Absorbed 2026-11-09 as `zimi check`** (checksum, main page, metadata table, 48x48 icon, redirects, dangling links). First run found a dead link in the Games ZIM |
| zimdump | List entries, show one, dump all, info | `zimi read`, `/entries` and MCP `list_entries` (PDF lane), `/read`, the ZIM details in Manage | Covered. No need for a dump-to-folder; revisit if someone asks to leave Zimi with their files |
| zimwriterfs | A folder into a ZIM | `zimi create <folder>` (HTML, Markdown, PDF, sidecars, subsets), the Create page's Folder tile | Made irrelevant: it conforms to the same metadata table and adds Markdown, PDF and sidecars |
| zimsplit | Cut a ZIM into 4 GB parts for FAT32 | None | Not worth building: libzim reads split files (.zimaa) but FAT32 is rare and a USB stick for Zimi is exFAT. Say so in docs if asked |
| zimpatch / zimdiff | Binary patch between two ZIM editions | Delta update copies the old version into staging and BitTorrent hash-checks it, so only the pieces that changed download (library.py `_prepare_delta_staging`) | Same goal by another route; it needs no patch published, but only helps on the BitTorrent path. Nothing to do unless Kiwix starts publishing patches |
| zimrecreate | Rewrite a ZIM (reindex, recompress) | `zimpatch.py` and `zimwriter` rewrite a ZIM to add provenance, history and screenshots | Partly: Zimi rewrites its own captures; a general "recreate" is not asked for |

Also relevant, not in zim-tools: kiwix-serve's library and search (Zimi replaces them), `kiwix-manage` (Zimi's library does it), `zimfarm` scrapers (Z124: engines for Create, after this survey).

What the survey changes: one new command (`zimi check`), one fixed dead link, one line in the docs. Splitting and patching stay out, with the reasons above.
