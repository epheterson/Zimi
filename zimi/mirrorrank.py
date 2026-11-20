"""Ranking a download's download mirrors by how fast they serve this machine.

Before an HTTP download starts, a mirror probe times one piece-sized Range
fetch from every download mirror at once, under a hard cap, and the download
starts on the fastest. Kiwix's own order (by country) is the fallback.
"""

import threading
import time
import urllib.request

# Downloads with less than this left to fetch start at once in Kiwix's order:
# probing them would cost more than it saves.
PROBE_MIN_BYTES_LEFT = 300 * 1024 * 1024
# The whole probe, every mirror at once, never holds a start longer than this.
PROBE_CAP_SECONDS = 10.0
# What a probe fetches when the .meta4 names no piece size (Kiwix's is 4 MiB).
DEFAULT_PROBE_BYTES = 4 * 1024 * 1024


def rank(urls, probe_bytes, bytes_left=None, stop=None):
    """`urls` (download mirrors in Kiwix's order), fastest first.

    `bytes_left` is what the download still has to fetch (None: unknown).
    Mirrors the probe could not time (refused, failed, ended early) follow
    the timed ones, in Kiwix's order; with none timed, a single download
    mirror, too little (or an unknown amount) left to fetch, or ZIMI_OFFLINE
    set, Kiwix's order is returned as it is.
    `stop()` turning true (the download was cancelled or paused) ends the
    wait at once; already true, nothing is probed.
    """
    from zimi import p2p

    urls = list(urls)
    stop = stop or (lambda: False)
    if len(urls) < 2 or stop():  # nothing to choose between, or no one waiting
        return urls
    if bytes_left is None or bytes_left < PROBE_MIN_BYTES_LEFT:
        return urls
    if p2p.is_offline():  # ZIMI_OFFLINE: no request leaves for a probe
        return urls
    speeds = _probe_all(urls, probe_bytes, stop)
    timed = sorted((u for u in urls if speeds.get(u)), key=lambda u: -speeds[u])
    return timed + [u for u in urls if not speeds.get(u)]


class _ProbeRun:
    """What every probe of one run shares: when it ends, and what it found."""

    def __init__(self, urls, stop):
        self.deadline = time.monotonic() + PROBE_CAP_SECONDS
        self.stop = stop
        self.received = {url: 0 for url in urls}  # bytes so far, per mirror
        self.finished = {}  # url -> bytes per second, for whole pieces
        self.failed = set()
        self.over = False  # the run has ended: its probes stop reading


def _probe_all(urls, probe_bytes, stop):
    """{url: bytes per second} for each mirror the probe could time, by the
    cap or by `stop()`, whichever comes first.

    A probe still receiving when the time is up is timed by what it received
    so far: on a link too slow for every mirror to send a whole piece within
    the cap, the rates so far still tell the mirrors apart. A probe that
    failed, or whose mirror ended the reply early, is not timed.
    """
    started = time.monotonic()
    run = _ProbeRun(urls, stop)
    threads = [
        threading.Thread(target=_probe, args=(u, probe_bytes, run), daemon=True)
        for u in urls
    ]
    for t in threads:
        t.start()
    while not stop():
        alive = [t for t in threads if t.is_alive()]
        left = run.deadline - time.monotonic()
        if not alive or left <= 0:
            break
        alive[0].join(min(0.1, left))
    run.over = True  # whatever stop() says later (Resume), this run is done
    elapsed = max(time.monotonic() - started, 1e-6)
    speeds = dict(run.finished)
    for url in urls:
        if url not in speeds and url not in run.failed and run.received[url] > 0:
            speeds[url] = run.received[url] / elapsed
    return speeds


def _probe(url, nbytes, run):
    """Fetch the first `nbytes` of `url`, counting into `run.received[url]`.

    Records the rate in `run.finished` once the whole piece arrived, or the
    url in `run.failed` when the request failed or the mirror ended the reply
    early. Stops reading at the deadline or when `run.stop()` turns true.
    """
    from zimi import library
    from zimi import server as srv

    start = time.monotonic()
    req = urllib.request.Request(
        url,
        headers={"User-Agent": library.USER_AGENT, "Range": f"bytes=0-{nbytes - 1}"},
    )
    try:
        with urllib.request.urlopen(
            req, timeout=max(0.1, run.deadline - start), context=srv.SSL_CTX
        ) as resp:
            while run.received[url] < nbytes:
                if run.over or time.monotonic() >= run.deadline or run.stop():
                    return  # still receiving: timed by what arrived
                # read1: whatever has arrived, so a slow reply still counts.
                chunk = resp.read1(min(65536, nbytes - run.received[url]))
                if not chunk:
                    run.failed.add(url)  # the reply ended short of the piece
                    return
                run.received[url] += len(chunk)
    except TimeoutError:
        return  # silent until the cap: timed by what arrived, if anything
    except Exception:
        run.failed.add(url)
        return
    run.finished[url] = nbytes / max(time.monotonic() - start, 1e-6)
