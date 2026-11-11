"""Build Zimi Games for openZIM/Kiwix: the same games, with the ZIM's Name, Title and languages openZIM's catalogue uses.

    python scripts/build_games_kiwix.py [--out DIR] [--file NAME] [--name ZIM_NAME] [--title TITLE]

The games folder is copied to a temporary folder whose zimi.txt gets the Title and the ten interface languages; nothing in
the repo changes. A ZIM in several languages is named ``mul`` by Kiwix, so the Name is set outright (``zimi_mul_games``).
build_almanac_kiwix.py holds the sibling for the Almanac, and the DESCRIPTION / LONG_DESCRIPTION switches that both share.
"""

import argparse
import datetime
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DEFAULT_NAME = "zimi_mul_games"
DEFAULT_TITLE = "Zimi Games"
FILE_FMT = "%s_%s.zim"
#: Text for the ZIM's Description or LongDescription instead of zimi.txt's (None keeps zimi.txt's). Change a line, rebuild.
DESCRIPTION = None
LONG_DESCRIPTION = None


def build(out_dir, file_name=None, name=DEFAULT_NAME, title=DEFAULT_TITLE, month=None, description=None, long_description=None):
    """The community Games, built from the source as it is now. Returns its path."""
    from build_almanac_kiwix import LANGUAGES, set_fields
    from zimi import creator, ownzims

    month = month or datetime.date.today().strftime("%Y-%m")
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, file_name or FILE_FMT % (name, month))
    with tempfile.TemporaryDirectory(prefix="zimi-kiwix-") as tmp:
        src = os.path.join(tmp, "games")
        shutil.copytree(os.path.join(ownzims.SOURCE_ROOT, "games"), src)
        set_fields(src, Title=title, Language=LANGUAGES, Description=description or DESCRIPTION, LongDescription=long_description or LONG_DESCRIPTION)
        real = creator.zim_name
        creator.zim_name = lambda scope, language="eng": name
        try:
            creator.create_folder_zim(src, out_path=path, register=False, extra_items=ownzims.with_build_year())
        finally:
            creator.zim_name = real
    return path


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "dist", "kiwix"))
    ap.add_argument("--file", help="the file's name (default <name>_<YYYY-MM>.zim)")
    ap.add_argument("--name", default=DEFAULT_NAME, help="the ZIM's Name metadata (default %(default)s)")
    ap.add_argument("--title", default=DEFAULT_TITLE, help="the ZIM's Title (default %(default)s)")
    ap.add_argument("--description", help="the ZIM's Description (default zimi.txt's)")
    ap.add_argument("--long-description", help="the ZIM's LongDescription (default zimi.txt's)")
    a = ap.parse_args(argv)
    path = build(a.out, a.file, a.name, a.title, description=a.description, long_description=a.long_description)
    print("built %s (%.1f MB)" % (path, os.path.getsize(path) / 1e6))
    return 0


if __name__ == "__main__":
    sys.exit(main())
