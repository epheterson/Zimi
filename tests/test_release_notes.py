"""The release body Desktop Release builds from CHANGELOG.md (scripts/release_notes.py)."""

import importlib.util
import pathlib
import re
import subprocess
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "release_notes.py"

_spec = importlib.util.spec_from_file_location("release_notes", SCRIPT)
release_notes = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(release_notes)

CHANGELOG = """# Changelog

## [1.2.0] - 2026-02-01

### Highlights

Pages saved from a browser become a ZIM. Read aloud is faster.

### Added

- Saved pages.

### Fixed

- Speed.

## [1.1.0] - 2026-01-01

### Added

- A thing.

### Fixed

- Another thing.

## [1.0.0] - 2025-12-01

### Highlights

One sentence only.
"""

REPO = "https://github.com/example/repo"


def body(version):
    return release_notes.release_body(CHANGELOG, version, REPO)


def test_highlights_become_the_body_with_a_link_to_the_full_entry():
    assert body("1.2.0") == (
        "Pages saved from a browser become a ZIM. Read aloud is faster.\n\n"
        "[Full changelog for v1.2.0]"
        "(https://github.com/example/repo/blob/v1.2.0/CHANGELOG.md#120---2026-02-01)"
    )


def test_the_other_sections_stay_out_of_the_highlights_body():
    assert "Saved pages" not in body("1.2.0")
    assert "A thing" not in body("1.2.0")


def test_a_section_without_highlights_is_used_whole():
    assert body("1.1.0") == "### Added\n\n- A thing.\n\n### Fixed\n\n- Another thing."


def test_highlights_that_end_the_file_are_found():
    assert body("1.0.0").startswith("One sentence only.\n\n[Full changelog for v1.0.0]")


def test_a_version_with_no_section_gets_a_bare_line():
    assert body("9.9.9") == "Release v9.9.9"


def test_a_prefix_of_another_version_is_not_matched():
    assert body("1.2") == "Release v1.2"


def test_an_empty_highlights_block_falls_back_to_the_section():
    text = "## [2.0.0] - 2026-03-01\n\n### Highlights\n\n### Added\n\n- X.\n"
    assert release_notes.release_body(text, "2.0.0", REPO) == "### Highlights\n\n### Added\n\n- X."


def test_highlights_not_at_the_top_do_not_count():
    text = "## [2.0.0] - 2026-03-01\n\n### Added\n\n- X.\n\n### Highlights\n\nLate.\n"
    assert "Full changelog" not in release_notes.release_body(text, "2.0.0", REPO)


@pytest.mark.parametrize(
    "heading, anchor",
    [
        ("## [1.14.1] - 2026-10-20", "1141---2026-10-20"),
        ("## [1.14.1]", "1141"),
        ("## [Unreleased]", "unreleased"),
    ],
)
def test_the_anchor_is_the_one_github_generates(heading, anchor):
    assert release_notes.heading_anchor(heading) == anchor


def test_the_command_line_prints_the_body(tmp_path):
    path = tmp_path / "CHANGELOG.md"
    path.write_text(CHANGELOG, encoding="utf-8")
    done = subprocess.run(
        [sys.executable, str(SCRIPT), "1.1.0", str(path)], capture_output=True, text=True, check=True
    )
    assert done.stdout.strip() == body("1.1.0")


def test_every_highlights_block_in_the_real_changelog_is_one_to_three_sentences():
    text = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    for version in re.findall(r"^## \[(\d[^\]]*)\]", text, re.M):
        _, section = release_notes._section(text, version)
        highlights = release_notes._highlights(section)
        if highlights:
            sentences = re.findall(r"[^.!?]+[.!?]", highlights)
            assert 1 <= len(sentences) <= 3, "%s: Highlights is %d sentences" % (version, len(sentences))
