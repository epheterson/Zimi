"""German speaks to the reader as "du" (Apple's style), never "Sie"; lowercase du/dein mid-sentence.

The games' own German has the same rule (tests/test_games_batch2_browser.py).
"""

import json
import os
import re

I18N_DE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "static",
    "i18n",
    "de.json",
)

# The strings where "Sie"/"Ihr" is genuinely third person (they/it/their), each about a thing named in the same string.
THIRD_PERSON_SIE = {
    "alm_dt_tilt_desc",  # Sie = die Neigung
    "backup_mydata_intro",  # Sie = Lesezeichen, Verlauf, Einstellungen
    "backup_mydata_intro_account",
    "catalog_snapshot_note",  # Sie = die Bibliothek
    "ref_d_sats_text",  # Sie = GPS-Satelliten und ISS
    "ref_h_sky_text",  # Ihre = der Himmelskörper
    "ref_h_stars_text",  # Ihre = der Sterne
    "saved_sync_behind",  # Sie = die Änderungen
    "streetzim_offline",  # Sie = die Regionen
    "wiki_note_mini",  # Sie = diese Kopie
}

FORMAL = re.compile(r"\b(Sie|Ihr(e[mnrs]?)?|Ihnen|Meinten)\b")
# "Du"/"Dein..." are capitalised only at the start of a string or sentence
MID_SENTENCE_CAPITAL = re.compile(
    r"(?<![.!?:…] )(?<!^)\b(Du|Dein\w*|Dir|Dich|Euch|Euer\w*)\b"
)


def _de():
    with open(I18N_DE, encoding="utf-8") as f:
        return json.load(f)


def test_german_ui_text_is_informal():
    de = _de()
    found = sorted(
        k for k, v in de.items() if k not in THIRD_PERSON_SIE and FORMAL.search(v)
    )
    assert not found, f"formal address in de.json (use du/dein): {found}"
    assert de["offline_title_nonet"] == "Du bist offline"


def test_third_person_allowlist_has_no_stale_entries():
    de = _de()
    stale = sorted(k for k in THIRD_PERSON_SIE if not FORMAL.search(de[k]))
    assert not stale, f"allowlist entries that no longer need it: {stale}"


def test_german_du_forms_are_lowercase_mid_sentence():
    wrong = sorted(k for k, v in _de().items() if MID_SENTENCE_CAPITAL.search(v))
    assert not wrong, f"capitalised du-form mid-sentence: {wrong}"
