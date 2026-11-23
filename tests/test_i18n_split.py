"""Home does not download the Almanac's strings.

i18n/<lang>.json is what the shell shows; the Almanac's own strings (alm_, tb_, ref_) are in i18n/almanac/<lang>.json and
come down with the Almanac's first file. A key the shell's code names (exact, or the front of a family such as
alm_shower_) stays in Home's file, so the teaser cards and the Manage panel never read a bare key.
"""

import glob
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import i18n_split as split  # noqa: E402


def _load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def test_home_holds_only_the_almanac_keys_the_shell_names():
    names = split.shell_names()
    extra = {}
    for path in sorted(glob.glob(os.path.join(split.I18N, "*.json"))):
        stray = [
            k
            for k in _load(path)
            if split.is_almanac_key(k) and not split.home_needs(k, names)
        ]
        if stray:
            extra[os.path.basename(path)] = sorted(stray)[:5]
    assert not extra, (
        "Almanac strings in Home's file (run scripts/i18n_split.py): %s" % extra
    )


def test_the_almanacs_file_holds_nothing_the_shell_names():
    names = split.shell_names()
    for path in sorted(glob.glob(os.path.join(split.ALMANAC_I18N, "*.json"))):
        keys = _load(path)
        assert not [k for k in keys if not split.is_almanac_key(k)], path
        assert not [k for k in keys if split.home_needs(k, names)], path


def test_the_almanacs_files_share_one_key_set_across_languages():
    en = set(_load(os.path.join(split.ALMANAC_I18N, "en.json")))
    assert en
    for lang in ("ar", "de", "es", "fr", "he", "hi", "pt", "ru", "zh"):
        assert set(_load(os.path.join(split.ALMANAC_I18N, lang + ".json"))) == en, lang


def test_no_key_is_in_both_files():
    for path in sorted(glob.glob(os.path.join(split.I18N, "*.json"))):
        both = set(_load(path)) & set(
            _load(os.path.join(split.ALMANAC_I18N, os.path.basename(path)))
        )
        assert not both, (path, sorted(both)[:5])
