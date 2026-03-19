The Language Release.

## Multilingual UI

Full localization into 10 languages: English, French, German, Spanish, Portuguese, Russian, Chinese, Arabic, Hindi, and Hebrew. RTL layout for Arabic and Hebrew. Every string reviewed by native speakers.

## Cross-Language Navigation

When reading an article, the language dropdown shows every installed translation. Matching uses Wikidata Q-IDs for Wikipedia-family sources and fuzzy title matching for everything else. If a translation isn't installed, download it from the dropdown. Zimi navigates to the article when it's ready.

Language is woven through the whole app. Sources are labeled by language on the homepage. The catalog has instant language filtering. Search results show language pills for filtering. The `/search` API accepts `lang=`. The MCP server has `article_languages` to find all translations of an article.

If cross-language matching isn't working for something, [open an issue](https://github.com/epheterson/Zimi/issues).

## Security

- Separated browser auth (password) from API auth (tokens). Generate and revoke tokens for programmatic access.
- Rate limiting on `/manage/` endpoints
- Salted password hashing
- Hardened thumbnail proxy
- Sanitized 500 error responses

## MCP Tools

Four new tools: `article_languages`, `read_with_links`, `deep_search`, and language-filtered `search`.

## Almanac

Messages Across Time: 10 historical inscriptions spanning 3,700 years, each in up to 10 languages with side-by-side comparison. Golden Record gallery with 49 NASA Voyager images. Real star catalog (Yale BSC) with 10 constellations in the simulated sky. Orrery goes to 100M×.

## Polish

Server split from one 5,400-line file into 7 focused modules. Catalog language filtering is instant (cached client-side, no server round-trips). Search filter pills sorted by result count. Three-letter ISO 639-3 codes resolve to proper language names. Hebrew cross-language interlinking fixed.

---

## Install

**macOS:** `brew tap epheterson/zimi && brew install --cask zimi`
**Linux:** `sudo snap install zimi`
**Docker:** `docker run -v ./zims:/zims -p 8899:8899 epheterson/zimi`
**Python:** `pip install zimi && zimi serve`
