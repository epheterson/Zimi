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

### Phase 1: Build

1. Merge feature branch PR to `main`
2. Tag: `git tag v1.X.0 && git push origin v1.X.0`
3. CI builds desktop apps (DMGs, AppImage) and creates a **draft** release

### Phase 2: QA + Publish

Before publishing, verify on real hardware:

- [ ] Download and install macOS DMG
- [ ] Search works across multiple ZIM sources
- [ ] PDF viewer opens zimgit PDFs inline
- [ ] Article navigation history works (back button, long-press trail)
- [ ] Catalog browse, download, and update check
- [ ] Screenshots current in README

When QA passes:

- [ ] Publish draft release on GitHub
- [ ] This triggers: PyPI publish, Sparkle appcast update, Homebrew cask update, Docker Hub build

### Post-release

- [ ] Verify Docker Hub: `docker pull epheterson/zimi:latest`
- [ ] Verify PyPI: `pip install --upgrade zimi`

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
- Windows: use `pip install zimi` (no desktop build currently)
