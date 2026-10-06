"""How long the Dictionary's Say takes per word, and what a warm worker holds.

For each downloaded engine here (Kokoro, Piper), on words never said before:
  per-call  the engine started afresh for each word (the old path)
  cold      the worker's first word (it loads the model)
  warm      the words after it
  prewarm   voices.warm() as the page opening asks, then the first word
and the worker's resident memory once warm. Nothing is cached or fetched:
each word goes to a temporary file, never the server's audio cache.

Runs beside a live Zimi, with its own workers (the server's are left alone):

    python3 scripts/voice_bench.py [DATA_DIR]
    # on the NAS, from a checkout (the container needs nothing new):
    ssh nas "timeout 600 /usr/local/bin/docker exec -i zim-reader python3 -" < scripts/voice_bench.py
"""

import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(globals().get("__file__", "."))))
for root in (HERE, "/app"):  # a checkout, or the Docker image
    if os.path.isdir(os.path.join(root, "zimi")):
        sys.path.insert(0, root)
        break

import zimi.server as server  # noqa: E402
from zimi import voices  # noqa: E402

WORDS = ("homophone", "lantern", "meadow", "quarrel", "bicycle", "thunder")
PER_CALL_WORDS = 2
LANG = "en"


def rss_mb(pid):
    try:
        with open("/proc/%d/status" % pid) as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) / 1024
    except OSError:
        pass
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True)
        return int(out.stdout.split()[0]) / 1024
    except (OSError, ValueError, IndexError):
        return None


def timed(fn):
    t = time.monotonic()
    ok = fn()
    return time.monotonic() - t, ok


def bench(engine, tmp):
    picked = voices.choose(LANG, engine=engine)
    if not picked:
        print("%-7s no voice here" % engine)
        return
    _engine, voice = picked
    out = os.path.join(tmp, engine + ".wav")

    def say(word, worker=True):
        if os.path.exists(out):
            os.remove(out)
        if worker:
            return voices._synthesize(engine, voice, word, out)
        return voices._run(
            voices._command(engine, voice, out),
            word,
            out,
            timeout=voices.KOKORO_TIMEOUT_S,
        )

    rows = []
    for w in WORDS[:PER_CALL_WORDS]:
        rows.append(("per-call", w) + timed(lambda: say(w, worker=False)))
    voices._stop_workers()
    rows.append(("cold", WORDS[2]) + timed(lambda: say(WORDS[2])))
    for w in WORDS[3:5]:
        rows.append(("warm", w) + timed(lambda: say(w)))
    worker = voices._worker(engine)
    rss = rss_mb(worker.proc.pid) if worker and worker.alive() else None
    voices._stop_workers()
    # What voices.warm() sends for the language's default engine, sent to
    # this engine's worker: the page opening, then its first word.
    worker = voices._worker(engine)
    req = voices._request(engine, voice)
    rows.append(
        ("prewarm", "(load)") + timed(lambda: worker.ask(req, voices.KOKORO_TIMEOUT_S))
    )
    rows.append(("after", WORDS[5]) + timed(lambda: say(WORDS[5])))
    for kind, word, secs, ok in rows:
        print(
            "%-7s %-9s %-10s %6.2f s %s"
            % (engine, kind, word, secs, "" if ok else "FAILED")
        )
    print("%-7s worker RSS %s MB" % (engine, "%.0f" % rss if rss else "?"))
    voices._stop_workers()


def main():
    if len(sys.argv) > 1:
        server.ZIMI_DATA_DIR = sys.argv[1]
    print("data:", server.ZIMI_DATA_DIR, "installed:", sorted(voices.installed()))
    # The menu's engine= choice: Kokoro's voice for English, then Piper's.
    with tempfile.TemporaryDirectory() as tmp:
        for engine in (voices.KOKORO, voices.PIPER):
            bench(engine, tmp)


if __name__ == "__main__":
    main()
