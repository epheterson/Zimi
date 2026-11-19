"""Ranking a download's download mirrors by how fast they serve this machine.

Before an HTTP download starts, a mirror probe times one piece-sized Range
fetch from every download mirror at once, under a hard cap, and the download
starts on the fastest. Kiwix's own order (by country) is the fallback.
"""

import threading
import time
import urllib.request

# Files smaller than this start at once in Kiwix's order: probing them would
# cost more than it saves.
PROBE_MIN_FILE_BYTES = 300 * 1024 * 1024
# The whole probe, every mirror at once, never holds a start longer than this.
PROBE_CAP_SECONDS = 10.0
# What a probe fetches when the .meta4 names no piece size (Kiwix's is 4 MiB).
DEFAULT_PROBE_BYTES = 4 * 1024 * 1024


def rank(urls, probe_bytes, size_bytes=None, stop=None):
    """`urls` (download mirrors in Kiwix's order), fastest first.

    Mirrors the probe could not time (refused, failed, too slow for the cap)
    follow the timed ones, in Kiwix's order; with none timed, a file too
    small to probe, or ZIMI_OFFLINE set, Kiwix's order is returned as it is.
    `stop()` turning true (the download was cancelled) ends the wait at once.
    """
    from zimi import p2p

    urls = list(urls)
    if size_bytes is None or size_bytes < PROBE_MIN_FILE_BYTES:
        return urls
    if p2p.is_offline():  # ZIMI_OFFLINE: no request leaves for a probe
        return urls
    speeds = _probe_all(urls, probe_bytes, stop or (lambda: False))
    timed = sorted((u for u in urls if speeds.get(u)), key=lambda u: -speeds[u])
    return timed + [u for u in urls if not speeds.get(u)]


def _probe_all(urls, probe_bytes, stop):
    """{url: bytes per second} for each mirror the probe could time, by the
    cap or by `stop()`, whichever comes first."""
    deadline = time.monotonic() + PROBE_CAP_SECONDS
    speeds = {}

    def run(url):
        speed = _probe(url, probe_bytes, deadline)
        if speed:
            speeds[url] = speed

    threads = [threading.Thread(target=run, args=(u,), daemon=True) for u in urls]
    for t in threads:
        t.start()
    while any(t.is_alive() for t in threads) and not stop():
        left = deadline - time.monotonic()
        if left <= 0:
            break
        next(t for t in threads if t.is_alive()).join(min(0.1, left))
    return dict(speeds)


def _probe(url, nbytes, deadline):
    """Bytes per second fetching the first `nbytes` of `url`, or None."""
    from zimi import library
    from zimi import server as srv

    start = time.monotonic()
    req = urllib.request.Request(
        url,
        headers={"User-Agent": library.USER_AGENT, "Range": f"bytes=0-{nbytes - 1}"},
    )
    got = 0
    try:
        with urllib.request.urlopen(
            req, timeout=max(0.1, deadline - start), context=srv.SSL_CTX
        ) as resp:
            while got < nbytes and time.monotonic() < deadline:
                chunk = resp.read(min(65536, nbytes - got))
                if not chunk:
                    break
                got += len(chunk)
    except Exception:
        return None
    if got < nbytes:
        return None
    return got / max(time.monotonic() - start, 1e-6)
