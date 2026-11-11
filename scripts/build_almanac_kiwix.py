"""Build the Almanac for openZIM/Kiwix: the standard Almanac without the Golden Record pictures that are not public domain.

    python scripts/build_almanac_kiwix.py [--out DIR] [--file NAME] [--name ZIM_NAME] [--title TITLE]

openZIM and Kiwix take only free content. The Almanac's Golden Record gallery shows 49 of the record's pictures:
8 NASA photographs (public domain) and 41 that are copyright their owners (golden-record/credits.json). This
edition keeps the 8 and names each of the 41 in the gallery's list (number, title, credit), so the record's
sequence stays whole (almanacstage.stage, community). Everything else is the Almanac ``python -m zimi.ownzims`` builds;
Zimi's own Almanac keeps all 49. Nothing is committed: the file goes to --out.

Its Name and Title are openZIM's, not the ones Zimi's own copy carries: Name ``zimi_eng_almanac`` (creator,
language, scope; the scope is the staged folder's name) and Title "Zimi Almanac".
"""

import argparse
import datetime
import os
import re
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

DEFAULT_NAME = "zimi_eng_almanac"
DEFAULT_TITLE = "Zimi Almanac"
FILE_FMT = "%s_%s.zim"
_NAME = re.compile(r"^zimi_([a-z]{3})_([a-z0-9][a-z0-9_-]*)$")
_TITLE_LINE = re.compile(r"(?m)^Title:.*$")


def build(out_dir, file_name=None, name=DEFAULT_NAME, title=DEFAULT_TITLE, month=None):
    """The community Almanac, built from the source as it is now. Returns its path."""
    from zimi import almanacstage, creator, ownzims

    m = _NAME.match(name)
    if not m:
        raise SystemExit(
            "--name must look like zimi_<lang>_<scope>, e.g. %s" % DEFAULT_NAME
        )
    month = month or datetime.date.today().strftime("%Y-%m")
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, file_name or FILE_FMT % (name, month))
    with tempfile.TemporaryDirectory(prefix="zimi-kiwix-") as tmp:
        # The ZIM's Name is zimi_<language>_<the folder's name>: the folder is named for the scope.
        dest = os.path.join(tmp, m.group(2))
        os.mkdir(dest)
        almanacstage.stage(dest, community=True)
        meta = os.path.join(dest, "zimi.txt")
        with open(meta, encoding="utf-8") as f:
            text = f.read()
        with open(meta, "w", encoding="utf-8", newline="\n") as f:
            f.write(_TITLE_LINE.sub("Title: " + title, text, count=1))
        creator.create_folder_zim(dest, out_path=path, register=False, extra_items=ownzims.with_build_year())
    return path


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "dist", "kiwix"))
    ap.add_argument("--file", help="the file's name (default <name>_<YYYY-MM>.zim)")
    ap.add_argument(
        "--name",
        default=DEFAULT_NAME,
        help="the ZIM's Name metadata (default %(default)s)",
    )
    ap.add_argument(
        "--title", default=DEFAULT_TITLE, help="the ZIM's Title (default %(default)s)"
    )
    a = ap.parse_args(argv)
    path = build(a.out, a.file, a.name, a.title)
    print("built %s (%.1f MB)" % (path, os.path.getsize(path) / 1e6))
    return 0


if __name__ == "__main__":
    sys.exit(main())
