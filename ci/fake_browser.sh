#!/usr/bin/env bash
# What the browser-mode smoke hands the app as its "browser".
# BROWSER=ci/fake_browser.sh makes Python's webbrowser module run this
# instead of a real one, and wait for it to exit, exactly as it waits for a
# console browser (w3m, lynx: what a machine without a display gets). So it
# loads the page the way a browser tab would, then records the address and
# the status it got: "<url> 200" is a working tab. An app that opens the
# browser before its server answers records "<url> 000" after the timeout.
status=$(curl -s -o /dev/null -w '%{http_code}' --max-time "${FAKE_BROWSER_TIMEOUT:-20}" "$1") || true
echo "$1 ${status:-000}" >> "${FAKE_BROWSER_LOG:-/tmp/fake-browser.log}"
