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

- [ ] Versions match: `ZIMI_VERSION` in `server.py`, `version` in `pyproject.toml`, `version` in `snap/snapcraft.yaml`
- [ ] `zimi_desktop.spec` `hiddenimports` includes ALL `zimi/*.py` modules (add any new ones from server split)
- [ ] Smoke test locally: `python3 zimi_desktop.py --serve --port 0` starts and prints `READY`
- [ ] `desktop-release.yml` smoke test commands work with current auth model (e.g. `Sec-Fetch-Site` header for manage endpoints)
- [ ] `node -c zimi/static/app.js` passes (no syntax errors)
- [ ] `python3 -m pytest tests/ -q` passes
- [ ] CHANGELOG updated, README current, screenshots current
- [ ] No debug print statements or console.logs that shouldn't ship

### Phase 1: Tag and build

1. Squash merge feature branch to `main`
2. Tag on main: `git tag v1.X.0 && git push origin main --tags`
3. CI auto-triggers: `desktop-release.yml` (DMGs, AppImage, Snap) and `docker-publish.yml`
4. Desktop release creates a **draft** GitHub release with assets

**If desktop builds fail:** The workflow YAML runs from the ref. If you dispatch manually, omit `--ref` to use main's workflow: `gh workflow run desktop-release.yml -f tag=v1.X.0`. Workflow fixes on main won't help if `--ref` points to the old tag.

### Phase 2: QA + Publish

Before publishing, verify on real hardware:

- [ ] Download and install macOS DMG (both Apple Silicon and Intel)
- [ ] Search works across multiple ZIM sources
- [ ] PDF viewer opens zimgit PDFs inline
- [ ] Cross-language article switching works
- [ ] Password set/change/remove works
- [ ] Catalog browse, download, and language filter
- [ ] Docker: `docker pull epheterson/zimi:vX.X.X` and run

When QA passes:

- [ ] Edit draft release: set title `Zimi vX.X.X — Title`, paste release notes
- [ ] Publish release
- [ ] This triggers: PyPI publish, Snap Store publish, Sparkle appcast update, Homebrew cask update

### Post-release

- [ ] Verify Docker Hub: `docker pull epheterson/zimi:latest`
- [ ] Verify PyPI: `pip install --upgrade zimi`
- [ ] Verify Homebrew: `brew upgrade zimi`
- [ ] Respond to the GitHub release discussion thread (if any)

## Desktop App

### Local Build

```bash
pip install -r requirements-desktop.txt
pyinstaller --noconfirm zimi_desktop.spec     # Output: dist/Zimi.app
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
- **When splitting modules:** any new `zimi/*.py` file must be added to `hiddenimports` in `zimi_desktop.spec` AND the CI smoke test must still pass. PyInstaller can't discover runtime imports.
- **Workflow dispatch and refs:** `gh workflow run --ref v1.X.0` runs the workflow YAML from the tag, not main. Fixes to the workflow on main won't apply unless you omit `--ref`.
- Windows: use `pip install zimi` (no desktop build currently)
