"""Build the Almanac for openZIM/Kiwix: the standard Almanac without the Golden Record pictures that are not public domain.

    python scripts/build_almanac_kiwix.py [--out DIR] [--file NAME]

openZIM and Kiwix take only free content. The Almanac's Golden Record gallery shows 49 of the record's pictures:
8 NASA photographs (public domain) and 41 that are copyright their owners (golden-record/credits.json). This
edition keeps the 8 and draws each of the 41 as a card with its caption and credit, so the record's sequence
stays whole (almanacstage.stage, community). Everything else is the Almanac ``python -m zimi.ownzims`` builds;
Zimi's own Almanac keeps all 49. Nothing is committed: the file goes to --out.
"""

import argparse
import datetime
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

FILE_FMT = "zimi_almanac_%s.zim"


def build(out_dir, name=None, month=None):
    """The community Almanac, built from the source as it is now. Returns its path."""
    from zimi import almanacstage, ownzims

    own = next(o for o in ownzims.OWN if o.name == "zimi_almanac")
    own = own._replace(stage=lambda dest: almanacstage.stage(dest, community=True))
    month = month or datetime.date.today().strftime("%Y-%m")
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, name or FILE_FMT % month)
    return ownzims.write_zim(own, path)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "dist", "kiwix"))
    ap.add_argument(
        "--file", help="the file's name (default zimi_almanac_<YYYY-MM>.zim)"
    )
    a = ap.parse_args(argv)
    path = build(a.out, a.file)
    print("built %s (%.1f MB)" % (path, os.path.getsize(path) / 1e6))
    return 0


if __name__ == "__main__":
    sys.exit(main())
