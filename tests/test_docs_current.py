"""The docs have to keep up with the product.

Docs go stale silently. Nothing fails, nobody notices, and a year later the
guide describes a flag that moved and omits the feature everybody uses. These
are the cheap, mechanical checks — the ones a person should never have to run
by eye — not a substitute for writing the prose.

Each check fails with what to do about it, because a guard whose message is
"assert False" is a guard people learn to skip.
"""

import os
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

FEATURES = REPO / "docs" / "features"
README = REPO / "README.md"


def _guides():
    return sorted(p for p in FEATURES.glob("*.md") if p.name != "README.md")


def _all_docs_text():
    return "\n".join(
        p.read_text(encoding="utf-8") for p in list(FEATURES.glob("*.md")) + [README]
    )


def test_every_guide_is_listed_in_the_index_and_the_readme():
    """A guide nobody links to is a guide nobody reads."""
    index = (FEATURES / "README.md").read_text(encoding="utf-8")
    readme = README.read_text(encoding="utf-8")
    for guide in _guides():
        assert f"({guide.name})" in index, (
            f"{guide.name} is not linked from docs/features/README.md — add a row "
            f"to the table so it can be found."
        )
        assert (
            f"features/{guide.name}" in readme
        ), f"{guide.name} is not linked from README.md — add it to the guide list."


def test_no_internal_link_is_broken():
    """Every relative link in the README and the guides resolves.

    Drafts and plans are working notes and are deliberately not held to this."""
    broken = []
    for f in list(FEATURES.glob("*.md")) + [README]:
        for m in re.finditer(
            r"\[([^\]]+)\]\(([^)#]+?)(?:#[^)]*)?\)", f.read_text(encoding="utf-8")
        ):
            target = m.group(2)
            if target.startswith(("http://", "https://", "mailto:")):
                continue
            if not (f.parent / target).resolve().exists():
                broken.append(f"{f.relative_to(REPO)} -> {target}")
    assert not broken, "broken links:\n  " + "\n  ".join(broken)


def test_every_guide_keeps_the_three_part_shape():
    """How it works / Configure / Troubleshoot, so a reader always knows where
    to look. The index promises this shape; the guides have to keep it."""
    for guide in _guides():
        text = guide.read_text(encoding="utf-8")
        for heading in ("## How it works", "## Configure", "## Troubleshoot"):
            assert heading in text, (
                f"{guide.name} is missing '{heading}'. Every guide keeps the same "
                f"three sections — see docs/features/README.md."
            )


def test_every_cli_subcommand_is_documented():
    """A subcommand a person can type and cannot look up does not exist to them.

    Read from the CLI itself rather than a list kept here, so adding a
    subcommand is what fails this — not forgetting to update a fixture."""
    import zimi.server as server

    source = pathlib.Path(server.__file__).read_text(encoding="utf-8")
    subs = set(re.findall(r"add_parser\(\s*[\"']([a-z][a-z0-9-]+)[\"']", source))
    if not subs:
        return  # the CLI is not built with add_parser; nothing to check
    docs = _all_docs_text()
    missing = sorted(
        s for s in subs if f"zimi {s}" not in docs and f"`{s}`" not in docs
    )
    assert not missing, (
        "these CLI subcommands appear in no guide: "
        + ", ".join(missing)
        + " — document them in the guide that owns the job they do."
    )


def test_the_engines_are_all_described():
    """The capture engines are the choice people ask about most."""
    import zimi.manage as manage

    docs = _all_docs_text().lower()
    for engine in manage.CREATE_ENGINES:
        assert engine in docs, (
            f"capture engine '{engine}' is in CREATE_ENGINES and in no guide — "
            f"docs/features/making-zims.md is its home."
        )


def test_a_new_create_mode_cannot_ship_undocumented():
    """Same rule as the readiness probes: a mode the UI offers is a promise."""
    import zimi.manage as manage

    docs = _all_docs_text().lower()
    for mode in manage.CREATE_MODES:
        assert mode in docs, (
            f"create mode '{mode}' is offered and documented nowhere — "
            f"docs/features/making-zims.md."
        )
