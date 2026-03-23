The Language Release. Zimi now speaks 10 languages and helps you move between them.

## Languages

Not an afterthought. Language is deeply integrated into every aspect of Zimi so you can focus on your content and feel at home.

- **10-language UI.** English, French, German, Spanish, Portuguese, Russian, Chinese, Arabic, Hindi, Hebrew. Full RTL layout for Arabic and Hebrew. Auto-detects your browser language.
- **Cross-language navigation.** Reading an article? The language dropdown shows every installed translation, matched via Wikidata Q-IDs for Wikipedia-family sources and exact title matching for everything else. Don't have that language? Download it from the dropdown.
- **Language everywhere.** Sources labeled by language on the homepage. Language pills in search results for quick filtering. Instant language filtering in the catalog. Q-ID badges on source cards that support cross-language linking.
- **API and MCP.** `/search?lang=XX` filters by language. New `article_languages` tool finds every translation.

If cross-language matching isn't working for something, [open an issue](https://github.com/epheterson/Zimi/issues).

## Changes

- Docker: renamed `/data` to `/config` to match *arr conventions (auto-migrates from v1.5)
- Separated browser auth (password) from API auth (tokens). Generate and revoke tokens for programmatic access.
- Rate limiting on `/manage/` endpoints
- Split server.py into 7 focused modules

## Bug Fixes

- Desktop app white flash on startup
- PDF download from viewer showing white page instead of saving file

---

## Install

**macOS:** `brew tap epheterson/zimi && brew install --cask zimi`
**Linux:** `sudo snap install zimi`
**Docker:** `docker run -v ./zims:/zims -v ./zimi-config:/config -p 8899:8899 epheterson/zimi`
**Python:** `pip install zimi && zimi serve`

---

Built with ❤️ in California by [@epheterson](https://github.com/epheterson) and [Claude Code](https://claude.ai/code).
