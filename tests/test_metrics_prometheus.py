"""GET /metrics — Prometheus text exposition.

Three things are being defended here:

1. The output is *valid* exposition, not a string dump that happens to look
   like one. A malformed line, a missing TYPE, or a duplicated HELP makes the
   scraper drop the whole scrape — silently, from Zimi's point of view.
2. Label values are escaped and endpoint labels are bounded. An unbounded
   label is how a crawler takes down someone's TSDB from the outside.
3. The pre-existing JSON snapshot (which the admin UI reads via
   /manage/stats) is unchanged. /metrics adds a rendering; it replaces
   nothing.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.http as http  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── A parser for the text exposition format ─────────────────────────────────
# Deliberately written from the spec rather than by looking at our own output,
# so it can actually fail. A label VALUE may legally contain any character
# (including `}` and `=`) as long as it is escaped, so the label matcher has to
# understand quoting rather than lazily matching up to the first `}`.

_LABEL = r'[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\]|\\.)*"'
_LABELS = r"\{(?:" + _LABEL + r"(?:," + _LABEL + r")*)?\}"
_NUMBER = r"[+-]?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|Inf|NaN)"
SAMPLE_RE = re.compile(
    r"^(?P<name>[a-zA-Z_:][a-zA-Z0-9_:]*)"
    r"(?P<labels>" + _LABELS + r")?"
    r" (?P<value>" + _NUMBER + r")$"
)
HELP_RE = re.compile(r"^# HELP (?P<name>\S+) (?P<text>.*)$")
TYPE_RE = re.compile(r"^# TYPE (?P<name>\S+) (?P<type>\S+)$")

_VALID_TYPES = {"counter", "gauge", "summary", "histogram", "untyped"}
# A summary/histogram declares HELP/TYPE on the base name; its samples carry
# these suffixes.
_FAMILY_SUFFIXES = ("_sum", "_count", "_bucket")


class Exposition:
    """Parsed exposition: {name: type}, {name: help}, and the sample lines."""

    def __init__(self, text):
        self.types = {}
        self.helps = {}
        self.samples = []  # (name, labels_str, value_str)
        assert text.endswith("\n"), "exposition must end with a newline"
        for lineno, line in enumerate(text.split("\n")[:-1], start=1):
            if not line:
                continue
            if line.startswith("#"):
                m = HELP_RE.match(line)
                if m:
                    name = m.group("name")
                    assert name not in self.helps, f"duplicate HELP for {name}"
                    self.helps[name] = m.group("text")
                    continue
                m = TYPE_RE.match(line)
                assert m, f"line {lineno}: unparseable comment: {line!r}"
                name = m.group("name")
                assert name not in self.types, f"duplicate TYPE for {name}"
                assert m.group("type") in _VALID_TYPES, m.group("type")
                self.types[name] = m.group("type")
                continue
            m = SAMPLE_RE.match(line)
            assert m, f"line {lineno}: not a valid sample line: {line!r}"
            self.samples.append((m.group("name"), m.group("labels") or "", line))

    def family_of(self, sample_name):
        """The declared family a sample belongs to."""
        if sample_name in self.types:
            return sample_name
        for suffix in _FAMILY_SUFFIXES:
            if sample_name.endswith(suffix):
                base = sample_name[: -len(suffix)]
                if base in self.types:
                    return base
        return None

    def line_for(self, sample_name, label_fragment=None):
        for name, labels, line in self.samples:
            if name == sample_name and (
                label_fragment is None or label_fragment in labels
            ):
                return line
        return None


def parse(text):
    return Exposition(text)


@pytest.fixture(autouse=True)
def _reset_metrics():
    """Each test starts from a clean counter set — the metrics dict is a
    module global shared with every other test in the session."""
    with http._metrics_lock:
        http._metrics["requests"].clear()
        http._metrics["latency_sum"].clear()
        http._metrics["errors"] = 0
        http._metrics["rate_limited"] = 0
        http._metrics["start_time"] = time.time() - 42
    yield


# ────────────────────────────────────────────────────────────────────────────
# Format validity
# ────────────────────────────────────────────────────────────────────────────


def test_exposition_parses_and_every_family_is_declared():
    http._record_metric("/search", 0.25)
    http._record_metric("/search", 0.75)
    http._record_metric("/read", 0.5, error=True)
    exp = parse(http._prometheus_metrics(zim_count=53, version="1.9.0"))

    assert exp.samples, "no samples emitted"
    for name, _labels, line in exp.samples:
        family = exp.family_of(name)
        assert family is not None, f"sample {name!r} has no declared TYPE ({line})"
        assert family in exp.helps, f"family {family!r} has no HELP"
        assert name.startswith("zimi_"), f"unprefixed metric name: {name}"


def test_counters_end_in_total():
    http._record_metric("/search", 0.1)
    exp = parse(http._prometheus_metrics())
    counters = [n for n, t in exp.types.items() if t == "counter"]
    assert counters, "expected at least one counter"
    for name in counters:
        assert name.endswith("_total"), f"counter {name} must end in _total"


def test_no_duplicate_metric_names():
    """Every endpoint contributes samples to the SAME families, so the header
    pair must be emitted once per family, not once per endpoint. A repeated
    HELP/TYPE is a hard parse error at the scraper."""
    for ep in ("/search", "/read", "/suggest", "/random", "/chunks", "/snippet"):
        http._record_metric(ep, 0.1)
    text = http._prometheus_metrics()
    parse(text)  # the parser asserts on duplicate HELP/TYPE
    for name in ("zimi_http_requests_total", "zimi_http_request_duration_seconds"):
        assert text.count(f"# TYPE {name} ") == 1
        assert text.count(f"# HELP {name} ") == 1


def test_latency_is_a_sum_and_count_pair_not_an_average():
    """The whole point of the format: sum and count aggregate across
    instances, an average does not. Emitting a precomputed mean would be
    silently wrong on any multi-instance deployment."""
    http._record_metric("/search", 0.25)
    http._record_metric("/search", 0.75)
    text = http._prometheus_metrics()
    exp = parse(text)

    assert exp.types["zimi_http_request_duration_seconds"] == "summary"
    assert (
        exp.line_for("zimi_http_request_duration_seconds_sum", '"/search"')
        == 'zimi_http_request_duration_seconds_sum{endpoint="/search"} 1.000000'
    )
    assert (
        exp.line_for("zimi_http_request_duration_seconds_count", '"/search"')
        == 'zimi_http_request_duration_seconds_count{endpoint="/search"} 2'
    )
    # No average, in any spelling.
    assert "avg" not in text and "_mean" not in text


def test_request_and_error_counts_are_counters():
    http._record_metric("/search", 0.1)
    http._record_metric("/read", 0.2, error=True)
    exp = parse(http._prometheus_metrics())
    assert exp.types["zimi_http_requests_total"] == "counter"
    assert exp.types["zimi_http_errors_total"] == "counter"
    assert exp.types["zimi_http_rate_limited_total"] == "counter"
    assert exp.line_for("zimi_http_errors_total") == "zimi_http_errors_total 1"
    assert exp.line_for("zimi_http_requests_total", '"/search"').endswith(" 1")


def test_counters_are_monotonic_across_scrapes():
    http._record_metric("/search", 0.1)
    first = parse(http._prometheus_metrics())
    http._record_metric("/search", 0.1)
    second = parse(http._prometheus_metrics())
    assert first.line_for("zimi_http_requests_total", '"/search"').endswith(" 1")
    assert second.line_for("zimi_http_requests_total", '"/search"').endswith(" 2")


def test_build_info_and_uptime_gauges():
    exp = parse(http._prometheus_metrics(zim_count=7, version="9.9.9"))
    assert exp.types["zimi_build_info"] == "gauge"
    assert exp.line_for("zimi_build_info") == 'zimi_build_info{version="9.9.9"} 1'
    assert exp.types["zimi_uptime_seconds"] == "gauge"
    assert exp.line_for("zimi_uptime_seconds") == "zimi_uptime_seconds 42"
    assert exp.line_for("zimi_zim_files") == "zimi_zim_files 7"


def test_empty_metrics_still_valid():
    """A freshly booted instance has served nothing. The exposition must still
    parse — a scraper that gets a parse error on cold start marks the target
    down and alerts."""
    exp = parse(http._prometheus_metrics())
    assert exp.types["zimi_http_requests_total"] == "counter"
    assert exp.line_for("zimi_http_requests_total") is None  # declared, no samples


# ────────────────────────────────────────────────────────────────────────────
# Escaping and cardinality
# ────────────────────────────────────────────────────────────────────────────


def test_label_values_are_escaped():
    nasty = '/w/a"b\\c\nd'
    http._record_metric(nasty, 1.5)
    text = http._prometheus_metrics()
    exp = parse(text)  # would fail to parse if the quote leaked through

    expected = 'zimi_http_requests_total{endpoint="/w/a\\"b\\\\c\\nd"} 1'
    assert expected in text
    assert exp.line_for("zimi_http_requests_total") == expected
    # The raw newline must not survive into the output: one sample = one line.
    assert "\n" not in expected


def test_escape_order_does_not_double_escape():
    """Backslash has to be replaced first. If quotes were escaped first, the
    backslash pass would then double the backslash the quote escape just
    introduced, and `a"` would render as `a\\\\"` instead of `a\\"`."""
    assert http._prom_escape('a"') == 'a\\"'
    assert http._prom_escape("a\\") == "a\\\\"
    assert http._prom_escape('\\"') == '\\\\\\"'


def test_endpoint_label_cardinality_is_capped(monkeypatch):
    """Endpoint keys are hardcoded literals at every call site, so cardinality
    is bounded by the source. The cap is the backstop for a future careless
    call site: past it, new keys stop being created rather than minting a time
    series per URL."""
    monkeypatch.setattr(http, "_METRIC_ENDPOINT_CAP", 3)
    for ep in ("/a", "/b", "/c", "/d", "/e"):
        http._record_metric(ep, 0.1)
    http._record_metric("/a", 0.1)  # existing key keeps counting

    exp = parse(http._prometheus_metrics())
    endpoints = {
        labels for name, labels, _ in exp.samples if name == "zimi_http_requests_total"
    }
    assert len(endpoints) == 3
    assert '{endpoint="/d"}' not in endpoints
    assert exp.line_for("zimi_http_requests_total", '"/a"').endswith(" 2")


def test_dropped_endpoint_still_counts_errors():
    """The cap bounds LABELS, not error accounting — a request past the cap
    must still show up in the (label-free) error counter."""
    with http._metrics_lock:
        http._metrics["requests"].update({f"/x{i}": 1 for i in range(200)})
    http._record_metric("/brand-new", 0.1, error=True)
    exp = parse(http._prometheus_metrics())
    assert exp.line_for("zimi_http_errors_total") == "zimi_http_errors_total 1"


# ────────────────────────────────────────────────────────────────────────────
# The existing JSON is untouched
# ────────────────────────────────────────────────────────────────────────────

# Snapshot of the JSON shape the admin UI consumes, as it was BEFORE /metrics
# existed. Pinned literally: if a future change to the Prometheus renderer
# reaches back into _get_metrics, this fails.
_JSON_KEYS = {
    "uptime_seconds",
    "total_requests",
    "errors",
    "rate_limited",
    "endpoints",
}
_JSON_ENDPOINT_KEYS = {"count", "avg_latency_ms"}


def test_json_snapshot_shape_unchanged():
    http._record_metric("/search", 0.25)
    http._record_metric("/search", 0.75)
    http._record_metric("/read", 0.5, error=True)
    data = http._get_metrics()

    assert set(data) == _JSON_KEYS
    assert set(data["endpoints"]) == {"/search", "/read"}
    assert set(data["endpoints"]["/search"]) == _JSON_ENDPOINT_KEYS
    # Values, not just keys: the average is still an average, in milliseconds,
    # rounded to one decimal, exactly as the UI renders it.
    assert data["endpoints"]["/search"] == {"count": 2, "avg_latency_ms": 500.0}
    assert data["total_requests"] == 3
    assert data["errors"] == 1
    assert data["rate_limited"] == 0
    assert data["uptime_seconds"] == 42
    # Still JSON-serializable (it is embedded in the /manage/stats payload).
    json.loads(json.dumps(data))


def test_json_and_prometheus_agree():
    for _ in range(3):
        http._record_metric("/search", 0.1)
    data = http._get_metrics()
    exp = parse(http._prometheus_metrics())
    assert exp.line_for("zimi_http_requests_total", '"/search"').endswith(
        f" {data['endpoints']['/search']['count']}"
    )


# ────────────────────────────────────────────────────────────────────────────
# Rate-limit class
# ────────────────────────────────────────────────────────────────────────────


def test_metrics_rides_the_content_bucket():
    """Rate-limited (the admin gate can run PBKDF2 on an attacker-supplied
    Bearer) but on the generous poll bucket, so a 15s scrape never competes
    with search for the 60/min API budget."""
    limited, content = http._rate_class("/metrics")
    assert limited is True
    assert content is True


# ────────────────────────────────────────────────────────────────────────────
# End to end: a real server, a real scrape, a real credential
# ────────────────────────────────────────────────────────────────────────────

READY_RE = re.compile(rb"^READY (\d+)\s*$", re.MULTILINE)
READY_TIMEOUT_SEC = 30
_API_TOKEN = "test-scrape-token-1234567890"


def _wait_for_ready(proc, log_path):
    deadline = time.time() + READY_TIMEOUT_SEC
    while time.time() < deadline:
        if proc.poll() is not None:
            with open(log_path, "rb") as f:
                pytest.fail(
                    f"server exited early:\n{f.read().decode(errors='replace')}"
                )
        try:
            with open(log_path, "rb") as f:
                m = READY_RE.search(f.read())
        except OSError:
            m = None
        if m:
            return int(m.group(1))
        time.sleep(0.2)
    proc.kill()
    pytest.fail(f"no READY within {READY_TIMEOUT_SEC}s")


@pytest.fixture
def guarded_server():
    """A server with a manage password AND an API token set — i.e. the posture
    a real deployment has, where /metrics must refuse an anonymous scrape and
    accept a Bearer token."""
    tmp_zim_dir = tempfile.mkdtemp(prefix="zimi-metrics-zims-")
    tmp_data_dir = tempfile.mkdtemp(prefix="zimi-metrics-data-")
    log_fd, log_path = tempfile.mkstemp(prefix="zimi-metrics-log-")
    os.close(log_fd)

    env = os.environ.copy()
    env.update(
        {
            "ZIM_DIR": tmp_zim_dir,
            "ZIMI_DATA_DIR": tmp_data_dir,
            "ZIMI_MANAGE_PASSWORD": "hunter2-not-a-real-password",
            "ZIMI_API_TOKEN": _API_TOKEN,
            "ZIMI_AUTO_UPDATE": "0",
            "ZIMI_TORRENT": "0",
            "ZIMI_PEER_DISCOVERY": "0",
            "PYTHONUNBUFFERED": "1",
        }
    )
    with open(log_path, "w") as log_f:
        proc = subprocess.Popen(
            [sys.executable, "-m", "zimi", "serve", "--port", "0"],
            cwd=REPO_ROOT,
            env=env,
            stdout=log_f,
            stderr=subprocess.STDOUT,
        )
    try:
        yield _wait_for_ready(proc, log_path)
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=2)
        for p in (tmp_zim_dir, tmp_data_dir):
            shutil.rmtree(p, ignore_errors=True)
        try:
            os.remove(log_path)
        except OSError:
            pass


def _get(url, token=None, timeout=10.0):
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.headers.get("Content-Type"), resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type"), e.read().decode()


def test_live_metrics_requires_credentials(guarded_server):
    port = guarded_server
    status, _ct, _body = _get(f"http://127.0.0.1:{port}/metrics")
    assert status == 401, "an anonymous scrape must not read the counters"


def test_live_metrics_with_api_token(guarded_server):
    """The documented scrape path: Prometheus `authorization: {credentials:}`
    sends exactly this Bearer header."""
    port = guarded_server
    # Generate some traffic first so a request family has samples.
    _get(f"http://127.0.0.1:{port}/search?q=test", token=_API_TOKEN)

    status, ctype, body = _get(f"http://127.0.0.1:{port}/metrics", token=_API_TOKEN)
    assert status == 200
    assert ctype == "text/plain; version=0.0.4; charset=utf-8"
    exp = parse(body)
    assert exp.types["zimi_http_requests_total"] == "counter"
    assert exp.line_for("zimi_build_info") is not None
    assert exp.line_for("zimi_http_requests_total", '"/search"').endswith(" 1")


def test_live_health_contract(guarded_server):
    """/health is the documented healthcheck: unauthenticated, 200 + JSON."""
    port = guarded_server
    status, ctype, body = _get(f"http://127.0.0.1:{port}/health")
    assert status == 200
    assert ctype == "application/json"
    data = json.loads(body)
    assert data["status"] == "ok"
    assert set(data) >= {
        "status",
        "version",
        "asset_version",
        "zim_count",
        "pdf_support",
    }
