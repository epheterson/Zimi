"""What automation must actually run.

Every workflow here is a gate somebody trusts. A gate that passes without
checking anything is worse than no gate, because it is believed.

Four of those turned up in a single day on the 1.9 branch:

  * ``deploy.sh`` piped its build through ``tail -3``, so the pipeline's exit
    status was tail's. A Dockerfile that exited 127 still printed "NAS
    deployed" and left the old image running.
  * ``pytest --timeout=600`` with pytest-timeout absent is an argument error,
    and pytest exits 0 on it. The suite did not run; the command "passed".
  * CI named two test files, collecting 305 of 2469 tests.
  * The desktop RELEASE workflow ran ``python tests/test_unit.py``, which has
    no ``unittest.main()`` — it imported the module and exited 0 having run
    none of its 245 tests. That step passed every build it ever gated.

Meanwhile six tests had been failing on the branch for two days. Two of them
had caught real bugs. All six already existed and were already correct.

So these assertions are about the instruments, not the code: the suite is only
worth having if something runs all of it.
"""

import os
import pathlib
import re

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / ".github" / "workflows"

# Workflows that gate code — a push, a PR, or a release build. Others (docs
# publishing, issue triage) have no business running a test suite.
GATING = ("ci.yml", "desktop-release.yml")


def _text(name):
    path = WORKFLOWS / name
    if not path.is_file():
        pytest.skip(f"{name} is not in this checkout")
    return path.read_text()


def _commands(name):
    """The workflow with its comments stripped.

    Comments here explain the very mistakes these tests forbid, and they quote
    the offending commands to do it. Scanning the raw file makes a workflow
    fail for describing a bug it does not have."""
    return "\n".join(
        line for line in _text(name).splitlines() if not line.lstrip().startswith("#")
    )


@pytest.mark.parametrize("name", GATING)
def test_a_gating_workflow_runs_the_whole_suite(name):
    """``pytest tests/`` and not ``pytest tests/some_file.py``.

    Naming files is how 88% of the suite stopped running: each new test file
    was correct, collected locally, and invisible to CI from the day it was
    written."""
    body = _commands(name)
    invocations = re.findall(r"pytest\s+(tests/\S*)", body)
    assert invocations, f"{name} never invokes pytest on the suite"
    for target in invocations:
        assert target.rstrip("/") == "tests", (
            f"{name} runs pytest against {target!r} rather than the whole "
            f"suite. A named file collects what existed the day it was named."
        )


@pytest.mark.parametrize("name", GATING)
def test_no_workflow_runs_a_test_file_as_a_script(name):
    """``python tests/x.py`` on a file with no ``unittest.main()`` imports it,
    runs nothing, and exits 0. It looks exactly like a passing test run."""
    body = _commands(name)
    stray = re.findall(r"python[0-9.]*\s+tests/\S+\.py", body)
    assert not stray, (
        f"{name} runs {stray} directly. Use `python -m pytest` — a bare "
        f"`python tests/x.py` exits 0 whether or not any test executed."
    )


def test_the_standalone_js_tests_are_all_reached():
    """The .cjs tests are not collected by pytest, so CI loops over them. A
    loop that names files instead of globbing would rot the same way."""
    body = _text("ci.yml")
    assert (
        "tests/*.cjs" in body
    ), "ci.yml no longer globs tests/*.cjs — a new .cjs test would never run"
    present = sorted(p.name for p in (ROOT / "tests").glob("*.cjs"))
    assert present, "no .cjs tests found; has the glob outlived its files?"


def test_deploy_does_not_hide_a_failed_build():
    """`ssh nas "...build" | tail -3` reports tail's exit status. Every
    "deploy=0" for a week meant only that tail ran."""
    deploy = ROOT / "deploy.sh"
    if not deploy.is_file():
        pytest.skip("deploy.sh is not in this checkout")
    body = deploy.read_text()
    if "| tail" not in body and "|tail" not in body:
        return  # nothing piped, nothing to mask
    assert "set -o pipefail" in body or "set -eo pipefail" in body, (
        "deploy.sh pipes a build through tail without pipefail, so a failed "
        "build reports success"
    )


def test_every_test_file_is_collectable():
    """A file named test_*.py that pytest cannot collect is a file whose tests
    nobody runs — and nothing else would notice, because a suite that skips it
    still reports all green."""
    names = sorted(p.name for p in (ROOT / "tests").glob("test_*.py"))
    assert len(names) > 20, f"only found {len(names)} python test files"
    # The suite's own file is here, so this is at minimum self-consistent.
    assert os.path.basename(__file__) in names
