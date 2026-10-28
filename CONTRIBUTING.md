# Contributing

## Development

```bash
pip install -e .
ZIM_DIR=./zims python3 -m zimi serve --port 8899
```

## Tests

```bash
python3 tests/test_unit.py                    # Unit tests
python3 -m pytest tests/test_server.py -v     # Integration tests (requires running server)
python3 tests/test_unit.py --perf             # Performance benchmarks
```

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
- [ ] `python3 -m pytest tests/ -q` passes
- [ ] `./scripts/release-gate.sh` passes — boots real servers against real ZIM files and drives every headline feature over HTTP, which is the only way to catch a feature that is correct in every module and still dead end to end (cross-ZIM link resolution once shipped serving an empty domain map, and no unit test noticed)
- [ ] CHANGELOG updated (with a `### Highlights` block, see Release notes below), README current, screenshots current
- [ ] No debug print statements or console.logs that shouldn't ship

### Release notes

Desktop Release builds the draft's body from the version's `## [X.Y.Z]` section in `CHANGELOG.md` (`scripts/release_notes.py`). The section may open with a `### Highlights` block of one to three short one-line bullets, before `### Added` and the rest. When it does, the release body is those bullets plus a link to the full entry in the CHANGELOG at the version's tag. Without the block the whole section is the body. Highlights are one-line factual bullets, no headings or stories; the CHANGELOG itself keeps them as its first subsection. A draft that already exists is never overwritten, so a curated body wins.

### Phase 1: Tag and build

1. Squash merge the release branch to `main` with the version bumped in `pyproject.toml`
2. Auto Release tags `vX.Y.Z` (never by hand)
3. The tag triggers `desktop-release.yml` (DMGs, AppImage, Snap, Windows) and `docker-publish.yml`
4. Once every build is in, Desktop Release creates the **draft** GitHub release with all its files attached. No draft means the builds are still running

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
