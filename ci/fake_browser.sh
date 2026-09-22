#!/usr/bin/env bash
# What the browser-mode smoke hands the app as its "browser": records the
# address it was asked to open. BROWSER=ci/fake_browser.sh makes Python's
# webbrowser module call this instead of a real one.
echo "$1" >> "${FAKE_BROWSER_LOG:-/tmp/fake-browser.log}"
