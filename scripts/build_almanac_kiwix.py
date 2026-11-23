"""Build the Almanac for openZIM/Kiwix: the standard Almanac without the Golden Record pictures that are not public domain.

    python scripts/build_almanac_kiwix.py [--out DIR] [--file NAME] [--name ZIM_NAME] [--title TITLE]

openZIM and Kiwix take only free content. The Almanac's Golden Record gallery shows 49 of the record's pictures:
8 NASA photographs (public domain) and 41 that are copyright their owners (golden-record/credits.json). This
edition keeps the 8 and names each of the 41 in the gallery's list (number, title, credit), so the record's
sequence stays whole (almanacstage.stage, community). Everything else is the Almanac ``python -m zimi.ownzims`` builds;
Zimi's own Almanac keeps all 49. Nothing is committed: the file goes to --out.

Its Name and Title are openZIM's, not the ones Zimi's own copy carries: Name ``zimi_mul_almanac`` (openZIM's
{domain}_{lang}_{selection}; ``mul`` for several languages) and Title "Zimi Almanac". The page speaks Zimi's ten languages.
"""

import argparse
import datetime
import os
import re
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from zimi import ownzims  # noqa: E402

DEFAULT_NAME = "zimi_mul_almanac"   # openZIM: {domain}_{lang}_{selection}; several languages are "mul"
#: The Language metadata: the ten languages the page speaks, ISO 639-3, in the order the Games use.
LANGUAGES = "eng,zho,hin,spa,ara,fra,por,rus,deu,heb"
DEFAULT_TITLE = "Zimi Almanac"
_NAME = re.compile(r"^zimi_([a-z]{2,3})_([a-z0-9][a-z0-9.-]*)$")
#: Text for the ZIM's Description or LongDescription instead of zimi.txt's (None keeps zimi.txt's). Change a line, rebuild.
DESCRIPTION = None
LONG_DESCRIPTION = None


def set_fields(folder, **fields):
    """Rewrite lines of the folder's zimi.txt; each field must already be there exactly once. None leaves it alone."""
    meta = os.path.join(folder, "zimi.txt")
    with open(meta, encoding="utf-8") as f:
        text = f.read()
    for key, value in fields.items():
        if value is None:
            continue
        text, n = re.subn(r"(?m)^%s:.*$" % key, lambda m: "%s: %s" % (key, value), text)
        if n != 1:
            raise SystemExit("zimi.txt has no single %s line" % key)
    with open(meta, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


#: The catalog names the three editions by Kiwix's flavour names, not Zimi's own (``maxi`` HD, ``ultra`` Maximum): the
#: small maps are ``mini``, HD is the base title (no Flavour), Maximum is ``maxi``. Keys are the edition's own
#: Flavour (None = the small maps); values are the catalog's.
CATALOG_FLAVOUR = {None: "mini", "maxi": None, "ultra": "maxi"}

#: What each catalog edition says about itself, like ownzims.FLAVOUR_TEXT (Description 80 characters at most).
CATALOG_TEXT = {
    ("zimi_almanac", None): (
        "The Almanac with compact maps of Earth, Moon and planets, the smallest edition",
        ownzims.STANDARD_EDITION.replace("the standard edition", "the mini edition"),
    ),
    ("zimi_almanac", "maxi"): (
        "The Almanac with high-resolution maps of Earth, Moon and planets" + ownzims._flavour_size(", about %s", "hd_size"),
        "This edition carries the high-resolution maps of the Earth, Moon and planets, the sharp tiles the mini edition leaves out"
        + ownzims._flavour_size(", about %s in all", "hd_size")
        + ".",
    ),
    ("zimi_almanac", "ultra"): (
        "Almanac maps of Earth, Moon and planets at full resolution" + ownzims._flavour_size(", about %s", "max_size"),
        "This is the maxi edition. It carries the maps of the Earth, Moon and planets with every tile at its source's full resolution"
        + ownzims._flavour_size(", about %s in all", "max_size")
        + ".",
    ),
}


def file_name_of(name, month, flavour=None):
    """openZIM's file name: ``<name>_<YYYY-MM>.zim``, with the Flavour before the month (``<name>_maxi_<YYYY-MM>.zim``)."""
    return "%s_%s.zim" % ("%s_%s" % (name, flavour) if flavour else name, month)


def build(out_dir, file_name=None, name=DEFAULT_NAME, title=DEFAULT_TITLE, month=None, description=None, long_description=None,
          flavour=None, extra_items=None):
    """The community Almanac, built from the source as it is now. Returns its path.

    ``flavour`` is the edition by Zimi's own name (None the small maps, ``maxi`` HD, ``ultra`` Maximum); the file carries the
    catalog's Flavour for it (CATALOG_FLAVOUR: mini, none, maxi) and a Description and LongDescription that say what it carries
    (CATALOG_TEXT). ``extra_items`` (the tiles) go in beside the Almanac."""
    from zimi import almanacstage, creator

    m = _NAME.match(name)
    if not m:
        raise SystemExit(
            "--name must look like zimi_<lang>_<scope>, e.g. %s" % DEFAULT_NAME
        )
    month = month or datetime.date.today().strftime("%Y-%m")
    os.makedirs(out_dir, exist_ok=True)
    catalog_flavour = CATALOG_FLAVOUR[flavour]
    path = os.path.join(out_dir, file_name or file_name_of(name, month, catalog_flavour))
    with tempfile.TemporaryDirectory(prefix="zimi-kiwix-") as tmp:
        dest = os.path.join(tmp, m.group(2))
        os.mkdir(dest)
        almanacstage.stage(dest, community=True)
        set_fields(dest, Title=title, Language=LANGUAGES, Description=description or DESCRIPTION, LongDescription=long_description or LONG_DESCRIPTION)
        own = next(o for o in ownzims.OWN if o.name == "zimi_almanac")
        said = ownzims.flavour_text(dest, own, flavour, CATALOG_TEXT)
        # The Name is set outright: creator derives it from the Language metadata's 3-letter code (zimi_eng_...).
        real = creator.zim_name
        creator.zim_name = lambda scope, language="eng": name
        try:
            creator.create_folder_zim(
                dest, out_path=path, register=False, flavour=catalog_flavour, extra_items=ownzims.with_build_year(extra_items),
                mime_overrides=ownzims.COMPRESSED_BINARY_TYPES,
                **{k: v for k, v in said.items() if k != "description" or not description}
            )
        finally:
            creator.zim_name = real
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
    ap.add_argument("--description", help="the ZIM's Description (default zimi.txt's)")
    ap.add_argument("--long-description", help="the ZIM's LongDescription (default zimi.txt's)")
    a = ap.parse_args(argv)
    path = build(a.out, a.file, a.name, a.title, description=a.description, long_description=a.long_description)
    print("built %s (%.1f MB)" % (path, os.path.getsize(path) / 1e6))
    return 0


if __name__ == "__main__":
    sys.exit(main())
