"""Publish a new Almanac HD tile source: the manual step between a tile build and the releases that use it.

    python scripts/publish_almanac_tiles.py --stage DIR --month 2026-11c [--out DIR] [--tag almanac-tiles-2026-11c]
                                            [--measure] [--upload]

The tiles are built from NASA's and USGS's sources on a big machine (scripts/build_almanac_hd.py --no-zim: about 60 GB
of sources and 24 GB of memory, more than a GitHub runner has), into a staged folder. Every Zimi release then builds
its two Almanac HD flavours from them in CI (desktop-release.yml, scripts/build_almanac_maxi.py --tag): HD, cut short
to fit one release file, and Maximum, everything, in chunks. This script is how the staged tiles get to CI:

  1. packs the staged folder as the tile source ZIM, ``zimi_almanac_tiles_<month>.zim``;
  2. cuts it into zimsplit chunks under GitHub's 2 GiB a file, only between clusters;
  3. checks: every chunk is under the limit, libzim opens the chunks as one book and its checksum holds, the layer list
     is there, and no release has shipped any of these file names;
  4. with ``--measure``, builds both flavours here, as CI will, for their sizes (the offer's offline estimate);
  5. writes the pin (file, size, sha256, tag, each chunk's size and sha256, the flavours' sizes);
  6. only with ``--upload`` (a public action: whoever runs it decides), creates the release ``--tag`` as a pre-release
     if it is not there, uploads the chunks, and checks each one's size on GitHub against the file here; then the pin is
     written to zimi/assets/almanac-tiles.json, to be committed. Without ``--upload`` it writes the pin beside the
     chunks and prints the commands it would run.
"""

import argparse
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path[:0] = [ROOT, os.path.join(ROOT, "scripts")]

import build_almanac_hd as hd  # noqa: E402
import build_almanac_maxi as maxi  # noqa: E402

REPO = "epheterson/Zimi"
NAME_FMT = "zimi_almanac_tiles_%s.zim"
LIMIT = 2**31  # GitHub's limit for a release file


def check_chunks(chunks, shipped):
    """The checks a tile source passes before it is published; returns the problems found (none: publish)."""
    from libzim.reader import Archive

    problems = []
    for c in chunks:
        if os.path.getsize(c) >= LIMIT:
            problems.append("%s is over GitHub's 2 GiB a file" % os.path.basename(c))
        if os.path.basename(c) in shipped:
            problems.append(
                "%s is a name a release already shipped" % os.path.basename(c)
            )
    try:
        a = Archive(chunks[0])
        if not a.check():
            problems.append(
                "the chunks do not read as one whole book (libzim's checksum fails)"
            )
        if not a.has_entry_by_path("hd.json"):
            problems.append("the book has no hd.json")
    except (
        Exception
    ) as e:  # noqa: BLE001 (any reason libzim refuses it is a reason not to publish)
        problems.append("libzim cannot open the chunks as one book: %s" % e)
    return problems


def pin_for(book, chunks, tag, sizes=None):
    pin = {
        "file": os.path.basename(book),
        "size": sum(os.path.getsize(c) for c in chunks),
        "sha256": maxi._sha256_files(chunks),
        "tag": tag,
        "chunks": [
            {
                "file": os.path.basename(c),
                "size": os.path.getsize(c),
                "sha256": maxi.sha256_file(c),
            }
            for c in chunks
        ],
    }
    pin.update(sizes or {})
    return pin


def _gh(*args, check=True):
    return subprocess.run(
        ("gh",) + args, capture_output=True, text=True, timeout=600, check=check
    )


def upload(tag, chunks, month):
    if _gh("release", "view", tag, "--repo", REPO, check=False).returncode != 0:
        _gh(
            "release",
            "create",
            tag,
            "--repo",
            REPO,
            "--prerelease",
            "--title",
            "Almanac HD tiles %s" % month,
            "--notes",
            "The tile source Zimi's releases build Almanac HD and Maximum from. Not a Zimi release.",
        )
    _gh("release", "upload", tag, "--repo", REPO, *chunks)
    got = {
        a["name"]: a["size"]
        for a in json.loads(
            _gh("release", "view", tag, "--repo", REPO, "--json", "assets").stdout
        )["assets"]
    }
    bad = [
        os.path.basename(c)
        for c in chunks
        if got.get(os.path.basename(c)) != os.path.getsize(c)
    ]
    if bad:
        raise SystemExit("uploaded but not whole on GitHub: %s" % ", ".join(bad))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--stage", required=True, help="the staged tiles (build_almanac_hd.py --no-zim)"
    )
    ap.add_argument(
        "--month",
        required=True,
        help="<month><letter> of the tile source, e.g. 2026-11c",
    )
    ap.add_argument("--out", default=os.path.join(ROOT, "dist", "almanac-tiles"))
    ap.add_argument(
        "--tag",
        help="the release that carries the chunks (default almanac-tiles-<month>)",
    )
    ap.add_argument(
        "--measure",
        action="store_true",
        help="build both flavours here for their sizes",
    )
    ap.add_argument(
        "--upload",
        action="store_true",
        help="publish: create the release if needed and upload",
    )
    a = ap.parse_args(argv)
    tag = a.tag or "almanac-tiles-%s" % a.month
    os.makedirs(a.out, exist_ok=True)
    book = os.path.join(a.out, NAME_FMT % a.month)
    if not os.path.exists(book):
        hd.pack_zim(a.stage, book)
    chunks = maxi.split_book(book, os.path.join(a.out, "chunks"))
    try:
        shipped = maxi.shipped_assets(REPO)
    except Exception as e:  # noqa: BLE001
        raise SystemExit("cannot list what releases shipped (gh): %s" % e)
    problems = check_chunks(chunks, shipped)
    if problems:
        raise SystemExit("not published:\n  " + "\n  ".join(problems))
    sizes = {}
    if a.measure:
        hd_file, max_chunks, _manifest = maxi.build_release(
            chunks[0], os.path.join(a.out, "flavours"), tag, a.month
        )
        sizes = {
            "hd_size": os.path.getsize(hd_file),
            "max_size": sum(os.path.getsize(c) for c in max_chunks),
        }
    pin = pin_for(book, chunks, tag, sizes)
    if not a.upload:
        out = os.path.join(a.out, "almanac-tiles.json")
        with open(out, "w", encoding="utf-8") as f:
            json.dump(pin, f, indent=2)
            f.write("\n")
        print("checked; not published. The pin is at", out)
        print(
            "To publish: gh release create %s --repo %s --prerelease ... ; gh release upload %s %s"
            % (tag, REPO, tag, " ".join(chunks))
        )
        print("or run again with --upload")
        return 0
    upload(tag, chunks, a.month)
    with open(maxi.PIN, "w", encoding="utf-8") as f:
        json.dump(pin, f, indent=2)
        f.write("\n")
    print(
        "published %d chunks to %s; commit %s"
        % (len(chunks), tag, os.path.relpath(maxi.PIN, ROOT))
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
