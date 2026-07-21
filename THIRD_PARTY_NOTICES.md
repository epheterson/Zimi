# Third-party software distributed with Zimi desktop builds

## libtorrent-rasterbar

Zimi's BitTorrent transfers run in-process through libtorrent-rasterbar,
imported dynamically when it is present (Docker images install the wheel via
pip; desktop builds bundle the compiled extension module). Zimi works without
it — downloads fall back to plain HTTP.

- Project: https://libtorrent.org/
- License: BSD 3-Clause
- Source code: https://github.com/arvidn/libtorrent
