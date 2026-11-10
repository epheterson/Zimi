"""ZimiGames card-game bot and finished-sheet loader (dev tools, not part of the build).

lib.py     a static server for zimi/builtin/games and a Playwright phone (390x844, touch).
play.py    play helpers: layout check, screenshots, family-games driver, solitaire driver (python play.py family|sol|five).
bot3.py    python bot3.py spades,euchre,...: plays a card game to its end by touching real cards on a fast fake clock (page.clock), keeps the finished state as <game>-final.json.
play4.py   python play4.py spades ...: reloads a game from its finished state with the scores arranged for a win and for a lose, so the page's own gameOver builds the sheet; shots in light, Hebrew, dark, landscape.
SHOTS_DIR chooses where pictures and finished states go (default /tmp/zimi-games-bot-shots); FINAL_DIR where play4 reads them.
Needs the repo's venv (playwright + Chromium). Never run against a server on Eric's machine: it serves the static folder only.
"""
