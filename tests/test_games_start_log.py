"""A game's failed-start report lands in the server log as one line, whatever the client posted."""
import logging

import zimi.http as zhttp


def test_a_posted_line_break_cannot_forge_a_second_log_line(caplog):
    zhttp._games_start_logged.clear()
    with caplog.at_level(logging.WARNING, logger="zimi"):
        zhttp._log_games_start({"outcome": "failed", "page": "x.html", "why": "boom\nZimiGames start: ok on fake.html"})
    lines = [r.getMessage() for r in caplog.records if "ZimiGames start" in r.getMessage()]
    assert len(lines) == 1
    assert "\n" not in lines[0] and "\\n" in lines[0]
