# Contributing

## Development

```bash
pip install -e .
ZIM_DIR=./zims python3 -m zimi serve --port 8899
```

## Tests

Install the test tools once: `pip install -e ".[test]"` (pytest and pytest-xdist). The browser tests also need `pip install playwright && python -m playwright install chromium`; without it they skip.

Which command, when:

| When | Command |
|---|---|
| While editing | the files you touched: `python3 -m pytest tests/test_x.py -q`, and for a `.cjs` file `python3 scripts/run_node_tests.py <word in its name>` |
| Before a NAS deploy | the quick tier, plus the tests that cover what you changed: `python3 -m pytest -m "not browser" -n auto --dist loadgroup -q`, `python3 scripts/run_node_tests.py`, then the browser files for the area you touched |
| CI (every ready PR) | everything: the quick tier, the node tests, and the browser tests in 4 shards (`pytest -m browser --shard I/4 -n auto --dist loadgroup`) |
| Anywhere, the whole thing | `python3 -m pytest -n auto --dist loadgroup -q` and `python3 scripts/run_node_tests.py` |

Things to know:

- A test is marked `browser` automatically when its module (or a fixture it uses) drives Playwright or Chromium; nothing is tagged by hand. `-m "not browser"` is the quick tier, `-m browser` the slow one.
- `--dist loadgroup` keeps a module's tests on one worker, which is what module-scoped servers and libraries assume (it is `--dist loadfile` with one exception: a module that sets `XDIST_SPLIT = n` has its independent parametrized cases dealt over n workers, so one long module is not the last one running).
- Tests never bind a fixed port: use `tests/ports.py` (`free_port()`, or the `free_port` fixture) or `--port 0`. Fixed ports collide when workers, or another session, run at once.
- The suite clears `ZIMI_TORRENT` and `ZIMI_OFFLINE` for itself, so it passes the same with or without them exported; a test that needs either sets it with `monkeypatch.setenv`.
- Each pytest run uses its own temp directory (tests/conftest.py), so two runs at once do not delete each other's files.
- The node tests (`tests/*.cjs`) are not collected by pytest; `scripts/run_node_tests.py` runs them all in parallel and prints a failing file's whole output.
- Old habits that still work: `python3 tests/test_unit.py`, `python3 tests/test_unit.py --perf` (needs a running server).

## Git Rules

- **Never commit directly to `main`** — use feature branches + PRs
- **Tag after merge** — tag on main, not on the feature branch

## Release Process

### Pre-release checklist

Before tagging, verify these on the feature branch:

- [ ] Versions match: `ZIMI_VERSION` in `zimi/server.py` and `version` in `pyproject.toml` (`snap/snapcraft.yaml` is stamped from the tag by CI — no need to touch it)
- [ ] `desktop/zimi_desktop.spec` `hiddenimports` includes ALL `zimi/*.py` modules (add any new ones from server split)
- [ ] Smoke test locally: `python3 desktop/zimi_desktop.py --serve --port 0` starts and prints `READY`
- [ ] `desktop-release.yml` smoke test commands work with current auth model (e.g. `Sec-Fetch-Site` header for manage endpoints)
- [ ] `node -c zimi/static/app.js` passes (no syntax errors)
- [ ] `python3 -m pytest -n auto --dist loadgroup -q` and `python3 scripts/run_node_tests.py` pass (the full suite, see Tests)
- [ ] `./scripts/release-gate.sh` passes — boots real servers against real ZIM files and drives every headline feature over HTTP, which is the only way to catch a feature that is correct in every module and still dead end to end (cross-ZIM link resolution once shipped serving an empty domain map, and no unit test noticed)
- [ ] CHANGELOG updated (with a `### Highlights` block, see Release notes below), README current, screenshots current
- [ ] No debug print statements or console.logs that shouldn't ship

### Release notes

Desktop Release builds the draft's body from the version's `## [X.Y.Z]` section in `CHANGELOG.md` (`scripts/release_notes.py`). The section may open with a `### Highlights` block of one to three short one-line bullets, before `### Added` and the rest. When it does, the release body is those bullets, a **Fixed** list of every line in the section beginning with `- ` that cites an issue (#N), and a link to the full entry in the CHANGELOG at the version's tag. Without the block the whole section is the body. Highlights are one-line factual bullets, no headings or stories; the CHANGELOG itself keeps them as its first subsection. A draft that already exists is never overwritten, so a curated body wins.

The Highlights are grouped by area under bold headings, **Zimi** first and **Almanac** last (it is the Easter egg), with **Games** and any other area between, and a bullet or more under each. Each bullet is one short line saying what a person can do now; a fix is listed only when it fixes something an earlier release shipped, and what was built and corrected inside the release is not a fix. `python3 scripts/release_notes.py --check X.Y.Z` (or `Unreleased`) names a block that breaks the order. Add your line to the Unreleased block in the right area as you make the change.

### Patch releases

Patch releases (`X.Y.Z`) are cut on demand only: when a real bug hits people on a released version, branch from `main`, fix just that, and release it as the next patch. The release in progress (`X.Y+1.0`) is never held for it and never carries a patch's version number. A merged version is spent: a fix after a merge ships as the next patch, never a re-cut of the same number.

### Phase 1: Tag and build

1. Squash merge the release branch to `main` with the version bumped in `pyproject.toml`
2. Auto Release tags `vX.Y.Z` (never by hand)
3. The tag triggers `desktop-release.yml` (DMGs, AppImage, Snap, Windows) and `docker-publish.yml`
4. Once every build is in, Desktop Release creates the **draft** GitHub release with all its files attached. No draft means the builds are still running or one failed: check the Desktop Release run

**If desktop builds fail:** The workflow YAML runs from the ref. If you dispatch manually, omit `--ref` to use main's workflow: `gh workflow run desktop-release.yml -f tag=v1.X.0`. Workflow fixes on main won't help if `--ref` points to the old tag.

### Phase 2: QA + Publish

Before publishing, verify on real hardware:

- [ ] Download and install macOS DMG (both Apple Silicon and Intel)
- [ ] Search works across multiple ZIM sources
- [ ] PDF viewer opens zimgit PDFs inline
- [ ] Cross-language article switching works
- [ ] Password set/change/remove works
- [ ] Catalog browse, download, and language filter
- [ ] Docker: `docker pull epheterson/zimi:X.X.X` and run (image tags have no `v` prefix)

When QA passes:

- [ ] Read the draft's notes and check its files are all there
- [ ] Publish release
- [ ] This triggers: PyPI publish, Snap Store publish, the apps' update feeds (appcasts), Homebrew cask update

### Post-release

- [ ] Verify Docker Hub: `docker pull epheterson/zimi:latest`
- [ ] Verify PyPI: `pip install --upgrade zimi`
- [ ] Verify Homebrew: `brew upgrade zimi`
- [ ] Respond to the GitHub release discussion thread (if any)

## Desktop App

### Local Build

```bash
pip install -r desktop/requirements-desktop.txt
pyinstaller --noconfirm desktop/zimi_desktop.spec     # Output: dist/Zimi.app
```

### Icons

```bash
python zimi/assets/generate_icons.py
# Creates: icon.png, favicon.png, icon.ico, icon.icns
```

### Code Signing

CI handles signing and notarization automatically. See `.github/workflows/desktop-release.yml` for details. Required secrets are documented in the workflow file.

### Gotchas

- `dist/` and `build/` are gitignored — never commit build artifacts
- PyInstaller copies source at build time — rebuild after code changes
- The `.spec` file includes `zimi/templates/`, `zimi/assets/`, and `zimi/static/` as data
- **When splitting modules:** any new `zimi/*.py` file must be added to `hiddenimports` in `desktop/zimi_desktop.spec` AND the CI smoke test must still pass. PyInstaller can't discover runtime imports.
- **Workflow dispatch and refs:** `gh workflow run --ref v1.X.0` runs the workflow YAML from the tag, not main. Fixes to the workflow on main won't apply unless you omit `--ref`.
- Windows: CI builds a desktop app (`Zimi-<version>-windows-x64.zip` and `-setup.exe`, WinSparkle auto-update) via `desktop-release.yml`; `pip install zimi` also works
