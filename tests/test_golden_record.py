"""The Golden Record's pictures: every one credited, and the Almanac built for Kiwix carries only the free ones.

The Almanac shows 49 of the record's pictures (static/golden-record/). Eight are NASA photographs, in the public
domain; the other 41 are copyright their owners (NASA: "All of these images are copyright protected").
credits.json is the table the gallery draws from: each file, its caption, who it is by, public domain or not.

  1. The table covers every picture in the folder, once, and nothing that is not there; each caption exists.
  2. Exactly 8 are public domain, all NASA's; every owner of the other 41 is named in SOURCES.txt and zimi.txt.
  3. Zimi's own Almanac (the normal stage, and the ZIM built from it) carries all 49.
  4. The community Almanac (openZIM/Kiwix) carries exactly the 8, with the 41 marked omitted in its table (the
     gallery names those in its list as text), and its zimi.txt says so.

Run: pytest tests/test_golden_record.py -v
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import almanacstage  # noqa: E402

STATIC = almanacstage.STATIC
GR_DIR = os.path.join(STATIC, almanacstage.GOLDEN_RECORD)
PICTURE_EXT = (".gif", ".jpg", ".jpeg", ".png", ".webp")
PUBLIC_DOMAIN = 8
ALL = 49
OWNERS_NAMED_IN = (
    os.path.join(STATIC, "earth", "SOURCES.txt"),
    os.path.join(almanacstage.HOST, "zimi.txt"),
)


def _pictures(folder):
    return sorted(f for f in os.listdir(folder) if f.lower().endswith(PICTURE_EXT))


def _table(folder):
    with open(os.path.join(folder, "credits.json"), encoding="utf-8") as f:
        return json.load(f)["images"]


def test_the_table_covers_every_picture_once():
    images = almanacstage.golden_record_images()
    files = [im["file"] for im in images]
    assert len(files) == len(set(files)) == ALL
    assert sorted(files) == _pictures(GR_DIR)
    with open(os.path.join(STATIC, "i18n", "en.json"), encoding="utf-8") as f:
        en = json.load(f)
    caps = [im["cap"] for im in images]
    assert sorted(caps) == list(range(ALL)), "each caption once"
    assert all("gr_cap_%d" % c in en for c in caps)
    assert all(im["by"].strip() and isinstance(im["pd"], bool) for im in images)
    assert not any(im.get("omitted") for im in images), "the source table omits nothing"


def test_eight_are_public_domain_and_every_other_owner_is_named():
    images = almanacstage.golden_record_images()
    pd = [im for im in images if im["pd"]]
    assert len(pd) == PUBLIC_DOMAIN
    assert {im["by"] for im in pd} == {"NASA"}
    owners = {im["by"] for im in images if not im["pd"]}
    assert "NASA" not in owners
    for path in OWNERS_NAMED_IN:
        with open(path, encoding="utf-8") as f:
            text = f.read()
        missing = [o for o in owners if o not in text]
        assert not missing, (os.path.basename(path), missing)


def test_the_gallery_says_no_picture_is_nasa_public_domain_wholesale():
    with open(os.path.join(STATIC, "almanac.js"), encoding="utf-8") as f:
        src = f.read()
    assert "(NASA public domain)" not in src
    assert "_GR_IMAGES" not in src, "the gallery draws from credits.json"
    gallery = src[src.index("function _renderGoldenRecordGallery") :]
    gallery = gallery[: gallery.index("\n}\n")]
    assert "gr-list" in gallery and "gr-row-text" in gallery, "one list; an omitted picture is a line of text"


@pytest.fixture(scope="module")
def staged(tmp_path_factory):
    out = {}
    for community in (False, True):
        dest = tmp_path_factory.mktemp("community" if community else "full")
        almanacstage.stage(str(dest), community=community)
        out[community] = str(dest)
    return out


def test_zimis_own_almanac_carries_all_49(staged):
    folder = os.path.join(staged[False], almanacstage.GOLDEN_RECORD)
    assert len(_pictures(folder)) == ALL
    assert not any(im.get("omitted") for im in _table(folder))
    with open(os.path.join(staged[False], "zimi.txt"), encoding="utf-8") as f:
        assert almanacstage.GOLDEN_LINE_FULL in f.read()


def test_the_community_almanac_carries_exactly_the_public_domain_eight(staged):
    folder = os.path.join(staged[True], almanacstage.GOLDEN_RECORD)
    table = _table(folder)
    kept = sorted(im["file"] for im in table if im["pd"])
    assert _pictures(folder) == kept and len(kept) == PUBLIC_DOMAIN
    omitted = [im for im in table if im.get("omitted")]
    assert len(omitted) == ALL - PUBLIC_DOMAIN
    assert all(
        not im["pd"] and im["by"] for im in omitted
    ), "each omitted row keeps its caption and credit"
    assert len(table) == ALL, "the sequence stays whole"
    with open(os.path.join(staged[True], "zimi.txt"), encoding="utf-8") as f:
        meta = f.read()
    assert (
        almanacstage.GOLDEN_LINE_COMMUNITY in meta
        and almanacstage.GOLDEN_LINE_FULL not in meta
    )


def _zim_pictures(path):
    from libzim.reader import Archive

    from zimi.libzimcompat import entry_by_id

    a = Archive(path)
    prefix = almanacstage.GOLDEN_RECORD + "/"
    names = []
    for i in range(a.all_entry_count):
        p = entry_by_id(a, i).path
        if p.startswith(prefix) and p.lower().endswith(PICTURE_EXT):
            names.append(p[len(prefix) :])
    credits = json.loads(
        bytes(a.get_entry_by_path(prefix + "credits.json").get_item().content)
    )
    return sorted(names), credits["images"]


def test_the_built_zims_hold_49_and_8(tmp_path):
    sys.path.insert(
        0,
        os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"
        ),
    )
    import build_almanac_kiwix
    from zimi import ownzims

    own = next(o for o in ownzims.OWN if o.name == "zimi_almanac")
    full, full_table = _zim_pictures(ownzims.write_zim(own, str(tmp_path / "full.zim")))
    assert len(full) == ALL and not any(im.get("omitted") for im in full_table)
    kiwix, kiwix_table = _zim_pictures(
        build_almanac_kiwix.build(str(tmp_path), "kiwix.zim")
    )
    assert len(kiwix) == PUBLIC_DOMAIN
    assert kiwix == sorted(im["file"] for im in kiwix_table if im["pd"])
    assert sum(1 for im in kiwix_table if im.get("omitted")) == ALL - PUBLIC_DOMAIN
    from libzim.reader import Archive

    meta = Archive(str(tmp_path / "kiwix.zim"))
    assert meta.get_metadata("Name").decode() == build_almanac_kiwix.DEFAULT_NAME == "zimi_mul_almanac"
    assert meta.get_metadata("Title").decode() == build_almanac_kiwix.DEFAULT_TITLE == "Zimi Almanac"
    assert meta.get_metadata("Language").decode() == "eng,zho,hin,spa,ara,fra,por,rus,deu,heb"


# The gallery's own code, run in node on each edition's table: what the list holds.
_RENDER = r"""
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(process.argv[1], 'utf8');
function grab(re) { const m = src.match(re); if (!m) throw new Error('missing ' + re); return m[0]; }
const code = [/var _GR_DIR = [^\n]*/, /function _grCap\(idx\)[^\n]*/, /function _grCredit\(idx\) \{[\s\S]*?\n\}/,
  /function _renderGoldenRecordGallery\(\) \{[\s\S]*?\n\}/].map(grab).join('\n');
const ctx = { t: (k) => k, _almEsc: (x) => String(x), _grImages: JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).images };
vm.createContext(ctx); vm.runInContext(code, ctx);
const html = ctx._renderGoldenRecordGallery();
const count = (re) => (html.match(re) || []).length;
console.log(JSON.stringify({ rows: count(/<li class="gr-row/g), text: count(/gr-row gr-row-text/g),
  pictures: count(/<img /g), omittedLine: html.includes('alm_gr_omitted') }));
"""


def _render(folder):
    import shutil
    import subprocess

    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    r = subprocess.run(
        [node, "-e", _RENDER, os.path.join(STATIC, "almanac.js"), os.path.join(folder, "credits.json")],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def test_the_list_holds_49_pictures_in_zimi(staged):
    got = _render(os.path.join(staged[False], almanacstage.GOLDEN_RECORD))
    assert got == {"rows": ALL, "text": 0, "pictures": ALL, "omittedLine": False}


def test_the_kiwix_list_shows_8_pictures_and_names_41(staged):
    got = _render(os.path.join(staged[True], almanacstage.GOLDEN_RECORD))
    assert got == {"rows": ALL, "text": ALL - PUBLIC_DOMAIN, "pictures": PUBLIC_DOMAIN, "omittedLine": True}
