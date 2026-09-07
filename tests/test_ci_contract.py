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
import shutil
import subprocess
import tempfile

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
    return path.read_text(encoding="utf-8")


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


def test_the_standalone_js_tests_pass():
    """Run the .cjs suite from pytest, so `pytest tests/` means everything.

    These are not collected by pytest, so for as long as CI was the only thing
    running them, "the suite is green" locally meant "the Python half is
    green". Two .cjs tests were broken on this branch and stayed broken through
    a full day of work because every local run was `pytest tests/` — the exact
    blind spot the CI-coverage fix above was about, one level closer to home.

    Skipped rather than failed when node is absent: a Python-only contributor
    should not be blocked by a missing runtime, and CI always has one."""
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed here; CI runs these")
    scripts = sorted((ROOT / "tests").glob("*.cjs"))
    assert scripts, "no .cjs tests found"
    broken = []
    for script in scripts:
        done = subprocess.run(
            [node, str(script)], capture_output=True, text=True, cwd=ROOT, timeout=180
        )
        if done.returncode != 0:
            tail = (done.stdout + done.stderr).strip().splitlines()
            hint = next(
                (ln for ln in tail if "FAIL" in ln or "Error" in ln),
                tail[-1] if tail else "",
            )
            broken.append(f"{script.name}: {hint[:160]}")
    assert not broken, "standalone JS tests failed:\n  " + "\n  ".join(broken)


def test_deploy_does_not_hide_a_failed_build():
    """`ssh nas "...build" | tail -3` reports tail's exit status. Every
    "deploy=0" for a week meant only that tail ran."""
    deploy = ROOT / "deploy.sh"
    if not deploy.is_file():
        pytest.skip("deploy.sh is not in this checkout")
    body = deploy.read_text(encoding="utf-8")
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


def _runners(name, job):
    """Every runner a job's matrix expands to.

    Both forms appear here: ``os: [a, b]`` in the CI matrix, and a list of
    ``- os: x`` entries under ``include:`` in the release matrix."""
    body = _text(name)
    start = body.index(f"\n  {job}:")
    nxt = re.search(r"\n  [a-z][a-z0-9_-]*:\n", body[start + 1 :])
    block = body[start : start + 1 + nxt.start()] if nxt else body[start:]
    block = "\n".join(
        ln for ln in block.splitlines() if not ln.lstrip().startswith("#")
    )
    inline = re.search(r"^\s*os:\s*\[([^\]]+)\]", block, re.M)
    if inline:
        return {v.strip().strip("'\"") for v in inline.group(1).split(",")}
    return {
        m.strip().strip("'\"") for m in re.findall(r"^\s*-?\s*os:\s*(\S+)", block, re.M)
    }


def test_the_pr_gate_runs_on_every_runner_the_release_builds_on():
    """The pull request gate IS the release matrix, not a sample of it.

    1.9.0 was tagged twice and Desktop Release failed both times. The second
    time, a gate had been added to catch exactly that — but it ran one job on
    ubuntu-latest, and the release's Linux leg is pinned to ubuntu-22.04 where
    an apt package has a different name. The Windows and macOS suites had not
    run since 1.8.2 and had accumulated real failures nobody could see.

    Any runner in one list and not the other is a platform whose failures only
    a tag can find, which is after the version number is spent."""
    gate = _runners("ci.yml", "desktop-env")
    release = _runners("desktop-release.yml", "build")
    assert gate, "ci.yml's desktop-env job no longer declares a runner matrix"
    assert release, "desktop-release.yml's build job no longer declares a runner matrix"
    assert gate == release, (
        "the pull request gate and the release build no longer run on the same "
        f"runners. Only in the gate: {sorted(gate - release) or 'none'}. Only in "
        f"the release: {sorted(release - gate) or 'none'}. A platform in the "
        "release alone is one whose failures cannot be seen before the tag."
    )


def test_the_repo_refuses_commit_messages_with_session_links():
    """A session URL in a commit message is a link into a private transcript,
    published under the repo owner's name, in the one place that cannot be
    edited after it lands on main.

    It is enforced by a hook rather than remembered because the agent harness
    supplies an attribution block containing that link, and anything following
    that instruction never sees the rule. This test is what keeps the hook
    itself from being deleted or quietly stopping working."""
    hook = ROOT / ".githooks" / "commit-msg"
    assert hook.is_file(), "the commit-msg hook is gone"
    if os.name != "nt":
        assert os.access(hook, os.X_OK), "the commit-msg hook is not executable"

    # Run it THROUGH sh rather than as a program. It is a `#!/bin/sh` script,
    # and Windows does not read shebangs: executing it directly raises
    # "[WinError 193] %1 is not a valid Win32 application". Git for Windows
    # ships the sh that git itself uses to run hooks, so this is also how the
    # hook actually runs on that platform.
    shell = shutil.which("sh") or shutil.which("bash")
    if not shell:
        pytest.skip("no POSIX shell here to run the hook with")

    def run(message):
        with tempfile.NamedTemporaryFile("w", suffix=".msg", delete=False) as fh:
            fh.write(message)
            path = fh.name
        try:
            return subprocess.run(
                [shell, str(hook), path], capture_output=True, text=True
            )
        finally:
            os.unlink(path)

    bad = run("a change\n\nClaude-Session: https://claude.ai/code/session_x1\n")
    assert bad.returncode != 0, "the hook let a session link through"

    plain_url = run("a change\n\nsee https://claude.ai/code/session_x1 for context\n")
    assert plain_url.returncode != 0, "the hook only catches the trailer form"

    good = run("a change\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n")
    assert good.returncode == 0, f"the hook rejected a clean message: {good.stderr}"


def test_no_commit_on_this_branch_carries_a_session_link():
    """The hook stops new ones; this catches any that predate it, while the
    branch can still be rewritten."""
    done = subprocess.run(
        ["git", "log", "origin/main..HEAD", "--format=%H%n%B"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    if done.returncode != 0:
        pytest.skip("no origin/main to compare against here")
    offenders = [ln for ln in done.stdout.splitlines() if "claude.ai" in ln]
    assert (
        not offenders
    ), "commit message(s) on this branch carry a session link:\n  " + "\n  ".join(
        offenders
    )


def test_every_text_file_operation_names_its_encoding():
    """`Path.read_text()` / `write_text()` without an encoding use the platform
    default, which on Windows is cp1252 — so a fixture holding one non-ASCII
    character raises UnicodeEncodeError there and nowhere else. That is exactly
    how the Windows runner failed on 1.9.2, in a test that had passed on three
    other operating systems. UTF-8 everywhere, stated, is the whole fix."""
    import ast

    offenders = []
    for path in sorted(ROOT.glob("tests/*.py")) + sorted(ROOT.glob("scripts/*.py")):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr in ("read_text", "write_text")
                and not any(k.arg == "encoding" for k in node.keywords)
            ):
                offenders.append(f"{path.relative_to(ROOT)}:{node.lineno}")
    assert not offenders, "text file operation without an encoding:\n  " + "\n  ".join(
        offenders
    )
