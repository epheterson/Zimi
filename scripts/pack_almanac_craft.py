#!/usr/bin/env python3
"""Pack the Almanac HD craft folder as one release asset and pin it (the way the tiles are pinned).

    python3 scripts/pack_almanac_craft.py --tag v1.16.0 [--folder DIR]

Builds the folder (scripts/build_almanac_maxi.py build_craft_folder: the stock craft at full detail, NASA's and the
reconstructed Sent craft) unless --folder names one, writes almanac_craft_<month>.tar.gz beside it (a flat, deterministic
archive) and zimi/assets/almanac-craft.json ({file, size, sha256, tag}). Upload the archive to the release named by --tag
(gh release upload); build_almanac_maxi.py downloads and checks it, so a release never needs NASA's servers. The archive is
reproducible for one zlib build; the pin is what a release checks, so pack once and keep the file.
"""

import argparse
import datetime
import gzip
import hashlib
import json
import os
import sys
import tarfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_almanac_maxi as maxi  # noqa: E402


def pack(folder, out):
    """A reproducible .tar.gz of the folder's files (sorted, no owners, no times)."""
    with open(out, "wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode="w") as t:
            for name in sorted(os.listdir(folder)):
                info = t.gettarinfo(os.path.join(folder, name), arcname=name)
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                info.mtime = 0
                info.mode = 0o644   # not the file system's (umask-dependent)
                with open(os.path.join(folder, name), "rb") as f:
                    t.addfile(info, f)
    h = hashlib.sha256()
    with open(out, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", required=True, help="the release the asset will be uploaded to")
    ap.add_argument("--folder", help="an HD craft folder already built (default: build one in --out/craft)")
    ap.add_argument("--out", default=os.path.join(maxi.ROOT, "dist"))
    a = ap.parse_args(argv)
    os.makedirs(a.out, exist_ok=True)
    folder = a.folder or maxi.build_craft_folder(os.path.join(a.out, "craft"))
    name = "almanac_craft_%s.tar.gz" % datetime.date.today().strftime("%Y-%m")
    path = os.path.join(a.out, name)
    sha = pack(folder, path)
    pin = {"file": name, "size": os.path.getsize(path), "sha256": sha, "tag": a.tag}
    with open(maxi.CRAFT_PIN, "w", encoding="utf-8") as f:
        json.dump(pin, f, indent=2)
        f.write("\n")
    print("packed %s (%.1f MB, sha256 %s); pinned in %s" % (path, pin["size"] / 1e6, sha, maxi.CRAFT_PIN))
    print("now: gh release upload %s %s" % (a.tag, path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
