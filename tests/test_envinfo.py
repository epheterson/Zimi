"""The environment panel names every variable Zimi reads.

A panel that quietly goes stale is worse than no panel. It would answer
"nothing is overridden" while something was, which is precisely the failure it
exists to prevent: issue #69 cost a week of round-trips because ZIMI_AUTO_UPDATE
was set in the reporter's launcher and nothing in Zimi could say so.

So the first test walks the source for ZIMI_* literals and fails when one is
neither in the table nor explicitly marked as not-an-env-var. It is deliberately
a source scan rather than a curated list, because the thing being guarded
against is somebody adding a variable and not thinking about this file.

Run: pytest tests/test_envinfo.py -v
"""

import os
import pathlib
import re
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from zimi import envinfo  # noqa: E402

_PKG = pathlib.Path(__file__).resolve().parent.parent / "zimi"
_LITERAL = re.compile(r"[\"'](ZIMI_[A-Z0-9_]+)[\"']")


def _names_in_source() -> set[str]:
    found = set()
    for path in sorted(_PKG.glob("*.py")):
        if path.name == "envinfo.py":
            continue  # the table itself is not evidence of a reader
        found |= set(_LITERAL.findall(path.read_text(encoding="utf-8")))
    return found


def test_every_variable_in_the_source_is_in_the_table():
    unlisted = _names_in_source() - envinfo.known_names() - envinfo.NOT_ENV
    assert not unlisted, (
        "these are read somewhere in zimi/ but the environment panel would not "
        f"show them: {sorted(unlisted)}. Add them to envinfo.VARS, or to "
        "envinfo.NOT_ENV if they are not environment variables."
    )


def test_the_table_has_no_variables_the_code_never_reads():
    """The other direction. A stale entry is a smaller problem than a missing
    one, but it still means the panel describes something that does nothing."""
    stale = envinfo.known_names() - _names_in_source()
    assert not stale, f"in the table but read nowhere: {sorted(stale)}"


def test_not_env_entries_are_really_not_env_vars():
    """An exclusion is a claim, and claims rot. Each name here must still
    appear in the source (otherwise drop it) and must not be in the table."""
    in_source = _names_in_source()
    for name in envinfo.NOT_ENV:
        assert name in in_source, f"{name} is excluded but no longer appears at all"
        assert name not in envinfo.VARS, f"{name} is both excluded and listed"


# ── what the panel reports ─────────────────────────────────────────────────


def test_only_variables_actually_set_are_reported():
    rows = envinfo.effective({"ZIMI_AUTO_UPDATE": "1"})
    assert [r["name"] for r in rows] == ["ZIMI_AUTO_UPDATE"]
    assert envinfo.effective({}) == []


def test_a_variable_set_to_empty_still_counts_as_set():
    """The subtlety behind #69: merely having the name in the environment
    locks the control, whatever the value is. Reporting only truthy values
    would hide the exact case that caused the confusion."""
    rows = envinfo.effective({"ZIMI_AUTO_UPDATE": ""})
    assert [r["name"] for r in rows] == ["ZIMI_AUTO_UPDATE"]
    assert rows[0]["value"] == ""


def test_an_unrelated_variable_is_ignored():
    assert envinfo.effective({"PATH": "/usr/bin", "HOME": "/root"}) == []


def test_rows_say_which_control_the_variable_takes_over():
    (row,) = envinfo.effective({"ZIMI_AUTO_UPDATE": "1"})
    assert row["locks"] == "Auto-update"
    assert row["description"]


def test_a_variable_with_no_ui_says_so_rather_than_guessing():
    """Blank, not invented. The panel is only useful if every word in it is
    true, and several variables genuinely have no control of their own."""
    (row,) = envinfo.effective({"ZIMI_HOT_ZIMS": "wikipedia_en_all"})
    assert row["locks"] == ""
    assert row["description"]


# ── secrets ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("name", ["ZIMI_MANAGE_PASSWORD", "ZIMI_API_TOKEN"])
def test_known_secrets_never_report_their_value(name):
    (row,) = envinfo.effective({name: "hunter2"})
    assert row["value"] == "set"
    assert row["secret"] is True
    assert "hunter2" not in repr(row)


@pytest.mark.parametrize(
    "name",
    [
        "ZIMI_SOMETHING_TOKEN",
        "ZIMI_NEW_PASSWORD",
        "ZIMI_SHARED_SECRET",
        "ZIMI_SIGNING_KEY",
    ],
)
def test_credential_shaped_names_are_masked_by_shape(name):
    """Belt and braces. A variable added later is masked before anybody
    remembers to come back to this file and flag it, so the failure mode of
    forgetting is a hidden value rather than a leaked one."""
    assert envinfo.is_secret(name) is True


def test_ordinary_names_are_not_masked():
    for name in ("ZIMI_PORT", "ZIMI_OFFLINE", "ZIMI_PEER_NAME", "ZIMI_HOT_ZIMS"):
        assert envinfo.is_secret(name) is False, name


def test_every_masked_variable_in_the_table_is_deliberate():
    """If the shape rule starts masking something that is not a credential,
    the panel silently stops being useful for it. Naming them here means that
    shows up as a failing test rather than as a blank column."""
    masked = {name for name in envinfo.VARS if envinfo.is_secret(name)}
    assert masked == {"ZIMI_MANAGE_PASSWORD", "ZIMI_API_TOKEN"}


def test_the_real_environment_is_readable():
    """effective() defaults to os.environ; it must not blow up on whatever is
    actually set on the machine running the tests."""
    for row in envinfo.effective():
        assert set(row) == {"name", "value", "secret", "description", "locks"}
