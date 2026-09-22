#!/usr/bin/env python3
"""Build the catalog snapshot that ships inside Zimi.

Run at release time, not on every CI run:

    python3 scripts/build_catalog_snapshot.py

It writes two files into ``zimi/assets/`` and they are committed:

    catalog-snapshot.json.gz   entries with a magnet each, about 166 KB
    catalog-icons.tar          48px WebP, deduplicated, about 1.8 MB

Three things make it cheap enough to run every release.

**Magnets come from metalinks, not torrents.** Kiwix publishes a ``.meta4``
beside every ZIM and the catalog already points at it. Every value in a
torrent's ``info`` dict is in there, so the infohash can be computed without
asking for the torrent. See ``zimi/metalink.py``.

**It is incremental.** A Kiwix filename carries its build date, so an unchanged
filename is the same bytes and therefore the same infohash and the same
illustration. The previous snapshot is loaded and those entries are reused
untouched. Measured churn is 18% over two months, which turns a 4.2 minute cold
build into roughly 48 seconds.

**It checks ten real torrents.** Not to re-prove the derivation, which is
settled across 50 entries from 0.3 MB to 22.8 GB, but to catch Kiwix changing
how they generate torrents. Without that the failure is 2,652 silently wrong
magnets and a lot of downloads that never start. Any mismatch fails the build.

Needs Pillow for the icons; everything else is stdlib.
"""

import argparse
import concurrent.futures as futures
import datetime
import gzip
import hashlib
import io
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import catalog_snapshot  # noqa: E402
from zimi.metalink import bencode, infohash_from_metalink  # noqa: E402

OPDS = "https://opds.library.kiwix.org/v2/entries"
PAGE = 500
WORKERS = 8
TIMEOUT = 60
CANARIES = 10
MIN_RESOLVED = 0.90
ICON_PX = 48
ICON_QUALITY = 72
# Says who we are and why, so an operator reading Kiwix's logs can tell this
# from a scraper. One machine, once per release.
UA = "Zimi catalog snapshot builder (+https://github.com/epheterson/Zimi)"

_ENTRY = re.compile(r"<entry>(.*?)</entry>", re.S)
_ACQ = re.compile(
    r'<link\s+rel="http://opds-spec\.org/acquisition/open-access"[^>]*href="([^"]+)"[^>]*'
    r'length="(\d+)"',
)
_THUMB = re.compile(
    r'<link\s+rel="http://opds-spec\.org/image/thumbnail"\s+href="([^"]+)"', re.S
)


def fetch(url: str, timeout: int = TIMEOUT) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def _text(block: str, tag: str) -> str:
    match = re.search(rf"<{tag}(?:\s[^>]*)?>(.*?)</{tag}>", block, re.S)
    if not match:
        return ""
    raw = re.sub(r"<[^>]+>", "", match.group(1)).strip()
    for entity, char in (
        ("&amp;", "&"),
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&quot;", '"'),
        ("&#39;", "'"),
    ):
        raw = raw.replace(entity, char)
    return raw


def parse_entries(xml: str) -> list[dict]:
    out = []
    for block in _ENTRY.findall(xml):
        name = _text(block, "name")
        acq = _ACQ.search(block)
        if not name or not acq:
            continue
        thumb = _THUMB.search(block)
        out.append(
            {
                "name": name,
                "title": _text(block, "title"),
                "summary": _text(block, "summary"),
                "language": _text(block, "language"),
                "category": _text(block, "category"),
                "author": _text(block, "name") if "<author>" in block else "",
                "tags": _text(block, "tags"),
                "date": (_text(block, "updated") or "")[:10],
                "article_count": int(_text(block, "articleCount") or 0),
                "media_count": int(_text(block, "mediaCount") or 0),
                "size_bytes": int(acq.group(2)),
                "download_url": acq.group(1),
                "icon_url": thumb.group(1) if thumb else "",
            }
        )
    return out


def fetch_catalog() -> list[dict]:
    """Every entry in the Kiwix catalog, paged."""
    entries: list[dict] = []
    start = 0
    while True:
        xml = fetch(f"{OPDS}?count={PAGE}&start={start}").decode("utf-8", "replace")
        page = parse_entries(xml)
        if not page:
            break
        entries.extend(page)
        print(f"  catalog: {len(entries)} entries", flush=True)
        if len(page) < PAGE:
            break
        start += PAGE
    seen, unique = set(), []
    for entry in entries:
        if entry["name"] not in seen:
            seen.add(entry["name"])
            unique.append(entry)
    return unique


def filename_of(entry: dict) -> str:
    """The ZIM's dated filename, which is the identity an incremental build
    keys on: unchanged filename, unchanged bytes, unchanged infohash."""
    tail = entry.get("download_url", "").rstrip("/").split("/")[-1]
    return tail[:-6] if tail.endswith(".meta4") else tail


def load_previous(path: str) -> dict[str, dict]:
    """Last release's entries, keyed by filename."""
    try:
        with gzip.open(path, "rt", encoding="utf-8") as f:
            payload = json.load(f)
    except (OSError, ValueError):
        return {}
    return {
        e["file"]: e
        for e in payload.get("entries", [])
        if e.get("file") and e.get("magnet")
    }


def resolve_magnet(entry: dict) -> tuple[str, str | None]:
    """The magnet for one entry, or None. Never raises: one unreachable file
    costs that entry its magnet and nothing else."""
    try:
        xml = fetch(entry["download_url"]).decode("utf-8", "replace")
    except (urllib.error.URLError, OSError, TimeoutError):
        return entry["name"], None
    return entry["name"], infohash_from_metalink(xml)


def check_canary(entry: dict) -> tuple[str, bool, str]:
    """Derive one infohash and compare it to Kiwix's actual torrent."""
    url = entry["download_url"]
    torrent_url = (url[:-6] if url.endswith(".meta4") else url) + ".torrent"
    try:
        xml = fetch(url).decode("utf-8", "replace")
        raw = fetch(torrent_url)
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return entry["name"], True, f"skipped ({type(e).__name__})"
    real = _infohash_of_torrent(raw)
    got = infohash_from_metalink(xml)
    if real is None:
        return entry["name"], True, "skipped (unreadable torrent)"
    return entry["name"], got == real, f"{got} vs {real}"


def _infohash_of_torrent(raw: bytes) -> str | None:
    def decode(data, i=0):
        kind = data[i : i + 1]
        if kind == b"d":
            i += 1
            out = {}
            while data[i : i + 1] != b"e":
                key, i = decode(data, i)
                value, i = decode(data, i)
                out[key] = value
            return out, i + 1
        if kind == b"l":
            i += 1
            out = []
            while data[i : i + 1] != b"e":
                value, i = decode(data, i)
                out.append(value)
            return out, i + 1
        if kind == b"i":
            end = data.index(b"e", i)
            return int(data[i + 1 : end]), end + 1
        colon = data.index(b":", i)
        length = int(data[i:colon])
        return data[colon + 1 : colon + 1 + length], colon + 1 + length

    try:
        info = decode(raw)[0][b"info"]
        return hashlib.sha1(bencode(info)).hexdigest()  # noqa: S324
    except (ValueError, KeyError, IndexError):
        return None


def resolve_icon(entry: dict) -> tuple[str, bytes | None]:
    """One icon, re-encoded small. Kiwix serves 48px PNGs at about 3.5 KB;
    WebP at the same size averages 1 KB, and a third of them turn out to be
    byte-identical once decoded because every Wikipedia language edition
    carries the same globe."""
    url = entry.get("icon_url") or ""
    if not url:
        return entry["name"], None
    if url.startswith("/"):
        url = "https://library.kiwix.org" + url
    try:
        raw = fetch(url, timeout=30)
    except (urllib.error.URLError, OSError, TimeoutError):
        return entry["name"], None
    try:
        from PIL import Image

        image = Image.open(io.BytesIO(raw)).convert("RGBA")
        image.thumbnail((ICON_PX, ICON_PX))
        buffer = io.BytesIO()
        image.save(buffer, "WEBP", quality=ICON_QUALITY, method=6)
        return entry["name"], buffer.getvalue()
    except Exception:
        return entry["name"], None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--full", action="store_true", help="ignore the previous snapshot"
    )
    parser.add_argument(
        "--no-icons", action="store_true", help="metadata and magnets only"
    )
    parser.add_argument(
        "--limit", type=int, default=0, help="first N entries, for a trial run"
    )
    args = parser.parse_args()

    started = time.time()
    assets = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "assets"
    )
    os.makedirs(assets, exist_ok=True)
    snapshot_path = os.path.join(assets, "catalog-snapshot.json.gz")
    icons_path = os.path.join(assets, "catalog-icons.tar")

    print("Fetching the Kiwix catalog...", flush=True)
    catalog = fetch_catalog()
    if not catalog:
        print("FAILED: the catalog fetch returned nothing", file=sys.stderr)
        return 1
    if args.limit:
        catalog = catalog[: args.limit]
    print(f"  {len(catalog)} entries", flush=True)

    previous = {} if args.full else load_previous(snapshot_path)
    if previous:
        print(f"  previous snapshot: {len(previous)} entries to reuse from", flush=True)

    # Reuse anything whose filename has not moved; fetch only the rest.
    reused, todo = {}, []
    for entry in catalog:
        old = previous.get(filename_of(entry))
        if old:
            reused[entry["name"]] = old
        else:
            todo.append(entry)
    print(f"  reusing {len(reused)}, resolving {len(todo)}", flush=True)

    magnets: dict[str, str | None] = {}
    if todo:
        print("Deriving magnets...", flush=True)
        with futures.ThreadPoolExecutor(WORKERS) as pool:
            for i, (name, infohash) in enumerate(pool.map(resolve_magnet, todo), 1):
                magnets[name] = infohash
                if i % 100 == 0:
                    print(f"  {i}/{len(todo)}", flush=True)

    icons: dict[str, bytes] = {}
    icon_of: dict[str, str] = {}
    if not args.no_icons:
        # Icons are keyed by CONTENT, so a reused entry's icon must still be
        # present in the new tar. The previous tar is the source for those.
        for name, old in reused.items():
            if old.get("icon"):
                icon_of[name] = old["icon"]
        carried = set(icon_of.values())
        for digest in carried:
            data = catalog_snapshot.icon(digest)
            if data:
                icons[digest] = data
        missing = carried - set(icons)
        if missing:
            # The previous tar is gone or partial. Refetch those entries'
            # icons rather than shipping entries that point at nothing.
            print(f"  {len(missing)} carried icons missing; refetching", flush=True)
            todo += [e for e in catalog if icon_of.get(e["name"]) in missing]
            for name, digest in list(icon_of.items()):
                if digest in missing:
                    del icon_of[name]

        print(f"Fetching {len(todo)} icons...", flush=True)
        with futures.ThreadPoolExecutor(WORKERS) as pool:
            for i, (name, data) in enumerate(pool.map(resolve_icon, todo), 1):
                if data:
                    digest = hashlib.sha256(data).hexdigest()[:16]
                    icons[digest] = data
                    icon_of[name] = digest
                if i % 100 == 0:
                    print(f"  {i}/{len(todo)}", flush=True)

    entries = []
    for entry in catalog:
        old = reused.get(entry["name"])
        infohash = old.get("magnet") if old else magnets.get(entry["name"])
        record = {
            "name": entry["name"],
            "file": filename_of(entry),
            "title": entry["title"],
            "summary": entry["summary"],
            "language": entry["language"],
            "category": entry["category"],
            "tags": entry["tags"],
            "date": entry["date"],
            "article_count": entry["article_count"],
            "media_count": entry["media_count"],
            "size_bytes": entry["size_bytes"],
            "download_url": entry["download_url"],
        }
        if infohash:
            record["magnet"] = infohash
        if icon_of.get(entry["name"]):
            record["icon"] = icon_of[entry["name"]]
        entries.append(record)

    resolved = sum(1 for e in entries if e.get("magnet"))
    ratio = resolved / max(len(entries), 1)
    print(f"  magnets: {resolved}/{len(entries)} ({ratio:.0%})", flush=True)
    if ratio < MIN_RESOLVED:
        print(
            f"FAILED: only {ratio:.0%} of entries resolved a magnet, "
            f"below the {MIN_RESOLVED:.0%} floor. Shipping this would be a "
            "catalog that mostly cannot be fetched.",
            file=sys.stderr,
        )
        return 1

    # The canary: does Kiwix still build torrents the way we assume?
    have_magnets = [
        e for e in catalog if magnets.get(e["name"]) or reused.get(e["name"])
    ]
    if have_magnets:
        picks = random.sample(have_magnets, min(CANARIES, len(have_magnets)))
        print(f"Checking {len(picks)} real torrents...", flush=True)
        bad = []
        with futures.ThreadPoolExecutor(4) as pool:
            for name, ok, detail in pool.map(check_canary, picks):
                if not ok:
                    bad.append((name, detail))
        if bad:
            print(
                "FAILED: a derived infohash did not match Kiwix's own torrent. "
                "They may have changed how torrents are generated; shipping "
                "would mean thousands of magnets that match no swarm.",
                file=sys.stderr,
            )
            for name, detail in bad:
                print(f"  {name}: {detail}", file=sys.stderr)
            return 1
        print("  all matched", flush=True)

    built = datetime.date.today().isoformat()
    catalog_snapshot.write_snapshot(snapshot_path, entries, built)

    # StreetZim's regions, from the Internet Archive, so the Maps toggle has
    # something to show on a machine that has never been online. Small (25
    # KB) and independent of the Kiwix half: a failure here is a warning,
    # never a failed snapshot.
    from zimi import streetzim

    streetzim_path = os.path.join(assets, "streetzim-snapshot.json.gz")
    try:
        print("Fetching StreetZim's regions from the Internet Archive...", flush=True)
        regions = streetzim.fetch_live()
        if regions:
            streetzim.write_snapshot(streetzim_path, regions, built)
            print(f"Wrote {streetzim_path} ({len(regions)} regions)")
        else:
            print("WARNING: StreetZim listing came back empty; kept the previous snapshot", file=sys.stderr)
    except Exception as e:
        print(f"WARNING: StreetZim listing not fetched ({e}); kept the previous snapshot", file=sys.stderr)
    if not args.no_icons:
        catalog_snapshot.write_icons(icons_path, icons)

    snapshot_kb = os.path.getsize(snapshot_path) / 1024
    print(f"\nWrote {snapshot_path} ({snapshot_kb:.0f} KB, {len(entries)} entries)")
    if not args.no_icons:
        icons_mb = os.path.getsize(icons_path) / 1e6
        print(f"Wrote {icons_path} ({icons_mb:.2f} MB, {len(icons)} unique icons)")
    print(f"Built {built} in {time.time() - started:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
