"""The headless config file: discovery, parsing, precedence, `zimi config`.

The load-bearing assertion in here is `test_env_beats_config_file`. The config
file sits BELOW the environment on purpose, so that dropping one next to a
running Docker or compose deployment — which sets ZIM_DIR — cannot change how
that deployment behaves. Every other precedence test exists to pin the rest of
the chain around it: flag > env > file > built-in default.

The parse tests are all about the failure modes a deployer actually hits:
a file that isn't there (normal, silent), a file that is empty (normal), a file
with a typo'd key (warn, keep booting) and a file with broken JSON (refuse, and
say which file).
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as server  # noqa: E402

from tests.test_serve_smoke import REPO_ROOT, _wait_for_ready  # noqa: E402


@pytest.fixture
def cfg_dir():
    path = tempfile.mkdtemp(prefix="zimi-config-")
    yield path
    shutil.rmtree(path, ignore_errors=True)


def _write(dirpath, name, text):
    path = os.path.join(dirpath, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return path


def _write_config(dirpath, mapping, name=server.CONFIG_FILENAME):
    return _write(dirpath, name, json.dumps(mapping))


# ---------------------------------------------------------------------------
# Precedence matrix: flag > env > config file > default
# ---------------------------------------------------------------------------


def _sources(**kwargs):
    """resolve_settings() reduced to {key: (value, source)} with env defaulted
    to empty, so no test accidentally reads the developer's own shell."""
    kwargs.setdefault("env", {})
    return server.resolve_settings(**kwargs)


def test_env_beats_config_file():
    """THE compatibility test. A config file naming a zim_dir must lose to a
    ZIM_DIR environment variable — an existing deployment keeps winning."""
    settings = _sources(
        env={"ZIM_DIR": "/env/zims"},
        config={"zim_dir": "/file/zims"},
        config_path="/etc/zimi.json",
    )
    assert settings["zim_dir"][0] == "/env/zims"
    assert settings["zim_dir"][1] == "env: ZIM_DIR"


def test_flag_beats_env_beats_config_beats_default():
    """All four layers present at once, one per setting, so the ordering is
    pinned end to end rather than pairwise."""
    settings = _sources(
        zim_dir_flag="/flag/zims",
        env={"ZIMI_DATA_DIR": "/env/state", "ZIM_DIR": "/env/zims"},
        config={"zim_dir": "/file/zims", "data_dir": "/file/state", "host": "10.0.0.1"},
        config_path="/etc/zimi.json",
    )
    assert settings["zim_dir"][0] == "/flag/zims"  # flag over env over file
    assert settings["data_dir"][0] == "/env/state"  # env over file
    assert settings["host"][0] == "10.0.0.1"  # file over default
    assert settings["port"][0] == server.DEFAULT_PORT  # nobody said anything


def test_config_file_beats_default():
    settings = _sources(
        config={"zim_dir": "/file/zims", "host": "127.0.0.1", "port": 8883},
        config_path="/etc/zimi.json",
    )
    assert settings["zim_dir"][0] == "/file/zims"
    assert settings["host"][0] == "127.0.0.1"
    assert settings["port"][0] == 8883


def test_config_zim_dir_carries_the_derived_data_dir():
    """`<zim_dir>/.zimi` is a default, so it follows whichever zim_dir won —
    including one that came from the file."""
    settings = _sources(config={"zim_dir": "/file/zims"}, config_path="/etc/zimi.json")
    assert settings["data_dir"][0] == os.path.join("/file/zims", ".zimi")


def test_config_data_dir_beats_a_derived_flag_default():
    """Mirror of the existing env case: the derived path is a default, so an
    explicit data_dir from the file beats `--zim-dir`'s derived one."""
    settings = _sources(
        zim_dir_flag="/media/usb/zims",
        config={"data_dir": "/var/lib/zimi"},
        config_path="/etc/zimi.json",
    )
    assert settings["zim_dir"][0] == "/media/usb/zims"
    assert settings["data_dir"][0] == "/var/lib/zimi"


def test_no_config_reproduces_the_shipped_defaults():
    """A resolution with nothing configured anywhere must still be exactly
    what shipped before this feature existed."""
    settings = _sources()
    assert settings["zim_dir"][0] == server.DEFAULT_ZIM_DIR
    assert settings["data_dir"][0] == os.path.join(server.DEFAULT_ZIM_DIR, ".zimi")
    assert settings["host"][0] == server.DEFAULT_HOST
    assert settings["port"][0] == server.DEFAULT_PORT


def test_resolve_data_paths_default_signature_is_unchanged():
    """The pre-existing entry point, called the pre-existing way."""
    zim_dir, data_dir = server.resolve_data_paths(env={})
    assert (zim_dir, data_dir) == ("/zims", os.path.join("/zims", ".zimi"))


def test_resolve_data_paths_takes_a_config_below_env():
    zim_dir, _ = server.resolve_data_paths(
        env={"ZIM_DIR": "/env/zims"}, config={"zim_dir": "/file/zims"}
    )
    assert zim_dir == "/env/zims"
    zim_dir, _ = server.resolve_data_paths(env={}, config={"zim_dir": "/file/zims"})
    assert zim_dir == "/file/zims"


def test_empty_string_env_still_wins_over_a_config_file():
    """`ZIM_DIR=` resolves to the empty string today. Adding a layer below it
    must not turn "set to empty" into "unset"."""
    zim_dir, _ = server.resolve_data_paths(
        env={"ZIM_DIR": ""}, config={"zim_dir": "/file/zims"}
    )
    assert zim_dir == ""


def test_env_host_and_port_are_read():
    settings = _sources(env={"ZIMI_HOST": "127.0.0.1", "ZIMI_PORT": "8883"})
    assert settings["host"] == ("127.0.0.1", "env: ZIMI_HOST")
    assert settings["port"] == (8883, "env: ZIMI_PORT")


def test_port_zero_from_a_flag_is_kept():
    """`--port 0` (ask the OS for a free port) must not be mistaken for
    "flag omitted"."""
    settings = _sources(port_flag=0, config={"port": 9000})
    assert settings["port"][0] == 0


# ---------------------------------------------------------------------------
# Parsing and the failure modes
# ---------------------------------------------------------------------------


def test_missing_file_is_normal_and_silent(cfg_dir):
    config, path = server.load_config(data_dir_flag=cfg_dir, env={})
    assert config == {}
    assert path is None


def test_empty_file_parses_as_no_settings(cfg_dir):
    """`touch zimi.json` is a normal first step; it must not be a JSON error."""
    _write(cfg_dir, server.CONFIG_FILENAME, "")
    config, path = server.load_config(data_dir_flag=cfg_dir, env={})
    assert config == {}
    assert path == os.path.join(cfg_dir, server.CONFIG_FILENAME)


def test_empty_object_parses_as_no_settings(cfg_dir):
    _write_config(cfg_dir, {})
    config, _ = server.load_config(data_dir_flag=cfg_dir, env={})
    assert config == {}


def test_partial_file_only_supplies_what_it_sets(cfg_dir):
    _write_config(cfg_dir, {"port": 8883})
    config, path = server.load_config(data_dir_flag=cfg_dir, env={})
    settings = server.resolve_settings(env={}, config=config, config_path=path)
    assert settings["port"][0] == 8883
    assert settings["host"] == (server.DEFAULT_HOST, "default")


def test_malformed_json_names_the_file(cfg_dir):
    path = _write(cfg_dir, server.CONFIG_FILENAME, '{"zim_dir": broken}')
    with pytest.raises(server.ConfigError) as exc:
        server.load_config(data_dir_flag=cfg_dir, env={})
    message = str(exc.value)
    assert path in message
    assert "invalid JSON" in message


def test_top_level_array_is_rejected_with_the_filename(cfg_dir):
    path = _write(cfg_dir, server.CONFIG_FILENAME, "[1, 2, 3]")
    with pytest.raises(server.ConfigError) as exc:
        server.load_config(data_dir_flag=cfg_dir, env={})
    assert path in str(exc.value)
    assert "JSON object" in str(exc.value)


def test_unknown_keys_warn_but_do_not_fail(cfg_dir, caplog):
    _write_config(cfg_dir, {"zim_dir": "/file/zims", "zimdir": "/typo", "colour": 1})
    with caplog.at_level("WARNING", logger="zimi"):
        config, _ = server.load_config(data_dir_flag=cfg_dir, env={})
    assert config == {"zim_dir": "/file/zims"}
    warning = "\n".join(r.getMessage() for r in caplog.records)
    assert "zimdir" in warning and "colour" in warning


def test_wrong_typed_value_is_rejected(cfg_dir):
    _write_config(cfg_dir, {"zim_dir": ["/a", "/b"]})
    with pytest.raises(server.ConfigError) as exc:
        server.load_config(data_dir_flag=cfg_dir, env={})
    assert "zim_dir must be a string" in str(exc.value)


def test_non_numeric_port_is_rejected(cfg_dir):
    _write_config(cfg_dir, {"port": "eightyeightninetynine"})
    with pytest.raises(server.ConfigError) as exc:
        server.load_config(data_dir_flag=cfg_dir, env={})
    assert "port must be a number" in str(exc.value)


def test_out_of_range_port_is_rejected(cfg_dir):
    _write_config(cfg_dir, {"port": 70000})
    with pytest.raises(server.ConfigError) as exc:
        server.load_config(data_dir_flag=cfg_dir, env={})
    assert "outside 0-65535" in str(exc.value)


def test_numeric_string_port_is_accepted(cfg_dir):
    """JSON has numbers, but hand-written files and env vars both hand us
    strings; accept them rather than being pedantic."""
    _write_config(cfg_dir, {"port": "8883"})
    config, _ = server.load_config(data_dir_flag=cfg_dir, env={})
    assert config["port"] == 8883


# ---------------------------------------------------------------------------
# Discovery: --config, ZIMI_CONFIG, <data dir>/zimi.json
# ---------------------------------------------------------------------------


def test_config_flag_beats_the_env_var(cfg_dir):
    flag_path = _write_config(cfg_dir, {"zim_dir": "/from/flag"}, name="flag.json")
    env_path = _write_config(cfg_dir, {"zim_dir": "/from/env"}, name="env.json")
    config, path = server.load_config(
        config_flag=flag_path, env={server.CONFIG_ENV_VAR: env_path}
    )
    assert path == flag_path
    assert config["zim_dir"] == "/from/flag"


def test_env_var_beats_the_implicit_location(cfg_dir):
    _write_config(cfg_dir, {"zim_dir": "/from/implicit"})
    env_path = _write_config(cfg_dir, {"zim_dir": "/from/env"}, name="env.json")
    config, path = server.load_config(
        data_dir_flag=cfg_dir, env={server.CONFIG_ENV_VAR: env_path}
    )
    assert path == env_path
    assert config["zim_dir"] == "/from/env"


def test_implicit_location_is_the_data_dir(cfg_dir):
    implicit = _write_config(cfg_dir, {"host": "127.0.0.1"})
    _, path = server.load_config(data_dir_flag=cfg_dir, env={})
    assert path == implicit


def test_implicit_location_follows_a_zim_dir_flag(cfg_dir):
    """With only `--zim-dir`, the file is looked for in the derived
    `<zim-dir>/.zimi` — which is what makes a USB stick self-describing."""
    data_dir = os.path.join(cfg_dir, ".zimi")
    os.makedirs(data_dir)
    implicit = _write_config(data_dir, {"host": "127.0.0.1"})
    _, path = server.load_config(zim_dir_flag=cfg_dir, env={})
    assert path == implicit


def test_explicitly_named_missing_file_is_an_error(cfg_dir):
    missing = os.path.join(cfg_dir, "nope.json")
    with pytest.raises(server.ConfigError) as exc:
        server.load_config(config_flag=missing, env={})
    assert missing in str(exc.value)
    with pytest.raises(server.ConfigError):
        server.load_config(env={server.CONFIG_ENV_VAR: missing})


# ---------------------------------------------------------------------------
# `zimi config` — the report and its provenance
# ---------------------------------------------------------------------------


def _run_cli(args, env_overrides):
    env = os.environ.copy()
    for k in ("ZIM_DIR", "ZIMI_DATA_DIR", "ZIMI_HOST", "ZIMI_PORT", "ZIMI_CONFIG"):
        env.pop(k, None)
    env.update(env_overrides)
    return subprocess.run(
        [sys.executable, "-m", "zimi", *args],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
    )


def _parse_report(stdout):
    """`key value (source)` lines back into {key: (value, source)}."""
    rows = {}
    for line in stdout.splitlines():
        line = line.strip()
        if not line or not line.endswith(")"):
            continue
        head, _, source = line[:-1].rpartition("(")
        key, value = head.split()
        rows[key] = (value, source.strip())
    return rows


def test_config_subcommand_reports_all_four_sources(cfg_dir):
    """One value from each layer at once, which is the whole point of the
    command: four settings, four different provenances."""
    path = _write_config(cfg_dir, {"zim_dir": "/srv/zims"})
    proc = _run_cli(
        ["config", "--config", path, "--port", "8883"],
        {"ZIMI_DATA_DIR": "/var/lib/zimi"},
    )
    assert proc.returncode == 0, proc.stderr
    # Parsed rather than matched verbatim: the columns are padded to the widest
    # value, which depends on the temp path this test happened to get.
    reported = _parse_report(proc.stdout)
    assert reported["zim_dir"] == ("/srv/zims", f"config file: {path}")
    assert reported["data_dir"] == ("/var/lib/zimi", "env: ZIMI_DATA_DIR")
    assert reported["host"] == ("0.0.0.0", "default")
    assert reported["port"] == ("8883", "flag: --port")


def test_config_subcommand_says_when_no_file_is_in_use():
    proc = _run_cli(["config"], {"ZIM_DIR": "/srv/zims"})
    assert proc.returncode == 0, proc.stderr
    assert "no config file in use" in proc.stdout
    assert os.path.join("/srv/zims", ".zimi", "zimi.json") in proc.stdout


def test_cli_refuses_a_malformed_file_without_a_traceback(cfg_dir):
    path = _write(cfg_dir, server.CONFIG_FILENAME, "{oops")
    proc = _run_cli(["config", "--config", path], {})
    assert proc.returncode == 2
    assert "Traceback" not in proc.stderr
    assert path in proc.stderr
    assert "invalid JSON" in proc.stderr


# ---------------------------------------------------------------------------
# End to end: boot a real server from a config file
# ---------------------------------------------------------------------------


def _boot_serve(extra_args, env_overrides):
    """Boot `python -m zimi serve` with nothing but the given args/env, wait
    for READY, return the port it reported."""
    env = os.environ.copy()
    for k in ("ZIM_DIR", "ZIMI_DATA_DIR", "ZIMI_HOST", "ZIMI_PORT", "ZIMI_CONFIG"):
        env.pop(k, None)
    env.update(env_overrides)
    env["ZIMI_AUTO_UPDATE"] = "0"
    env["ZIMI_TORRENT"] = "0"
    env["ZIMI_PEER_DISCOVERY"] = "0"
    env["PYTHONUNBUFFERED"] = "1"

    log_fd, log_path = tempfile.mkstemp(prefix="zimi-config-log-")
    os.close(log_fd)
    with open(log_path, "w") as log_f:
        proc = subprocess.Popen(
            [sys.executable, "-m", "zimi", "serve", *extra_args],
            cwd=REPO_ROOT,
            env=env,
            stdout=log_f,
            stderr=subprocess.STDOUT,
        )
    try:
        return _wait_for_ready(proc, log_path)
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=2)
        try:
            os.remove(log_path)
        except OSError:
            pass


def test_serve_boots_entirely_from_a_config_file(cfg_dir):
    """The deliverable, proven: a file and nothing else. The server comes up on
    the port the file names and its state lands in the directory the file
    names."""
    zim_dir = os.path.join(cfg_dir, "zims")
    data_dir = os.path.join(cfg_dir, "state")
    os.makedirs(zim_dir)
    path = _write_config(
        cfg_dir,
        {"zim_dir": zim_dir, "data_dir": data_dir, "host": "127.0.0.1", "port": 8883},
    )
    port = _boot_serve(["--config", path], {})
    assert port == 8883
    assert os.path.isdir(data_dir)
    assert not os.path.exists(os.path.join(zim_dir, ".zimi"))


def test_serve_config_file_loses_to_the_environment(cfg_dir):
    """The compatibility contract at the process level: ZIM_DIR in the
    environment wins, and the config file's zim_dir is not touched."""
    file_zims = os.path.join(cfg_dir, "file-zims")
    env_zims = os.path.join(cfg_dir, "env-zims")
    os.makedirs(file_zims)
    os.makedirs(env_zims)
    path = _write_config(cfg_dir, {"zim_dir": file_zims, "port": 0})
    _boot_serve(["--config", path], {"ZIM_DIR": env_zims})
    assert os.path.isdir(os.path.join(env_zims, ".zimi"))
    assert not os.path.exists(os.path.join(file_zims, ".zimi"))
