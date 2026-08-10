"""The config file's environment-backed settings.

`tests/test_config_file.py` pins the four path/bind keys. This file covers the
widened ones — settings whose only input used to be an environment variable,
read at call time by whichever module owns the feature.

Two things have to hold at once, and every test here is one of them:

  * The precedence chain is the SAME chain. These keys have no flags, so it is
    env > config file > built-in default, resolved by the one `resolve_settings`
    call and reported with real provenance by `zimi config`.
  * Delivery cannot leak upward. A value is published into os.environ only when
    it actually came from the file, so an exported variable is never clobbered
    and an unset setting stays unset — `get_hot_zims` distinguishes "no
    ZIMI_HOT_ZIMS" (fall back to hot.json) from "ZIMI_HOT_ZIMS=" (empty list),
    and a published default would have quietly broken that.
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

from tests.test_serve_smoke import REPO_ROOT  # noqa: E402


@pytest.fixture
def cfg_dir():
    path = tempfile.mkdtemp(prefix="zimi-config-env-")
    yield path
    shutil.rmtree(path, ignore_errors=True)


def _write_config(dirpath, mapping, name=server.CONFIG_FILENAME):
    path = os.path.join(dirpath, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps(mapping))
    return path


def _sources(**kwargs):
    kwargs.setdefault("env", {})
    return server.resolve_settings(**kwargs)


# ---------------------------------------------------------------------------
# Precedence: env > config file > default, one chain, real provenance
# ---------------------------------------------------------------------------


def test_every_widened_key_is_reported_with_a_default():
    """Nothing configured anywhere still describes the instance completely."""
    settings = _sources()
    for setting in server.CONFIG_ENV_SETTINGS:
        value, source = settings[setting.key]
        assert value == setting.default
        assert source.startswith("default")


def test_config_file_supplies_a_widened_key():
    settings = _sources(
        config={"manage": "0", "offline": "1"}, config_path="/etc/zimi.json"
    )
    assert settings["manage"] == ("0", "config file: /etc/zimi.json")
    assert settings["offline"] == ("1", "config file: /etc/zimi.json")


def test_env_beats_the_config_file_for_widened_keys():
    """The compatibility contract, applied to the new keys: an exported
    variable keeps winning, so dropping a file next to a running deployment
    cannot change it."""
    settings = _sources(
        env={"ZIMI_MANAGE": "0", "ZIMI_HOT_ZIMS": "wikipedia"},
        config={"manage": "1", "hot_zims": ["stackoverflow"]},
        config_path="/etc/zimi.json",
    )
    assert settings["manage"] == ("0", "env: ZIMI_MANAGE")
    assert settings["hot_zims"] == ("wikipedia", "env: ZIMI_HOT_ZIMS")


def test_empty_string_env_still_beats_the_config_file():
    """`ZIMI_HOT_ZIMS=` means "no hot ZIMs", not "unset" — the `in` check, not
    truthiness. Adding a layer below must not turn one into the other."""
    settings = _sources(
        env={"ZIMI_HOT_ZIMS": ""},
        config={"hot_zims": ["wikipedia"]},
        config_path="/etc/zimi.json",
    )
    assert settings["hot_zims"] == ("", "env: ZIMI_HOT_ZIMS")


def test_widened_keys_do_not_disturb_the_path_keys():
    """The four original keys keep their exact values, types and order."""
    settings = _sources(config={"manage": False}, config_path="/etc/zimi.json")
    assert list(settings)[:4] == ["zim_dir", "data_dir", "host", "port"]
    assert settings["port"][0] == server.DEFAULT_PORT
    assert isinstance(settings["port"][0], int)
    assert settings["zim_dir"][0] == server.DEFAULT_ZIM_DIR


# ---------------------------------------------------------------------------
# Encoding: JSON types in, the string the environment variable would carry out
# ---------------------------------------------------------------------------


def test_json_booleans_become_the_canonical_env_string(cfg_dir):
    _write_config(cfg_dir, {"manage": False, "offline": True})
    config, _ = server.load_config(data_dir_flag=cfg_dir, env={})
    assert config == {"manage": "0", "offline": "1"}


def test_boolean_written_as_a_word_is_accepted(cfg_dir):
    """People copy `ZIMI_OFFLINE=true` out of a compose file."""
    _write_config(cfg_dir, {"offline": "true", "index_throttle": "off"})
    config, _ = server.load_config(data_dir_flag=cfg_dir, env={})
    assert config == {"offline": "1", "index_throttle": "0"}


def test_nonsense_boolean_is_rejected_by_name(cfg_dir):
    _write_config(cfg_dir, {"offline": "maybe"})
    with pytest.raises(server.ConfigError) as exc:
        server.load_config(data_dir_flag=cfg_dir, env={})
    assert "offline must be true or false" in str(exc.value)


def test_hot_zims_accepts_a_list_and_encodes_it_as_csv(cfg_dir):
    _write_config(cfg_dir, {"hot_zims": ["wikipedia_en_all", " stackoverflow "]})
    config, _ = server.load_config(data_dir_flag=cfg_dir, env={})
    assert config["hot_zims"] == "wikipedia_en_all,stackoverflow"


def test_hot_zims_also_accepts_the_env_spelling(cfg_dir):
    _write_config(cfg_dir, {"hot_zims": "wikipedia_en_all,stackoverflow"})
    config, _ = server.load_config(data_dir_flag=cfg_dir, env={})
    assert config["hot_zims"] == "wikipedia_en_all,stackoverflow"


def test_hot_zims_rejects_a_list_of_non_strings(cfg_dir):
    _write_config(cfg_dir, {"hot_zims": [1, 2]})
    with pytest.raises(server.ConfigError) as exc:
        server.load_config(data_dir_flag=cfg_dir, env={})
    assert "hot_zims must be a list of strings" in str(exc.value)


def test_wrong_typed_secret_is_rejected(cfg_dir):
    _write_config(cfg_dir, {"manage_password": 1234})
    with pytest.raises(server.ConfigError) as exc:
        server.load_config(data_dir_flag=cfg_dir, env={})
    assert "manage_password must be a string" in str(exc.value)


def test_a_typo_on_a_widened_key_still_only_warns(cfg_dir, caplog):
    _write_config(cfg_dir, {"offline": True, "off_line": True})
    with caplog.at_level("WARNING", logger="zimi"):
        config, _ = server.load_config(data_dir_flag=cfg_dir, env={})
    assert config == {"offline": "1"}
    assert "off_line" in "\n".join(r.getMessage() for r in caplog.records)


# ---------------------------------------------------------------------------
# Delivery: publication into os.environ
# ---------------------------------------------------------------------------


@pytest.fixture
def clean_env():
    """A process environment with none of the widened variables set, restored
    on the way out.

    Deliberately not monkeypatch: publication writes os.environ directly, and
    monkeypatch only restores variables it was itself told about — a variable
    that did not exist before the test would survive it. That leak escapes the
    file (ZIMI_OFFLINE=1 turns off BT for every test that runs afterwards), so
    the save/restore is explicit and covers ZIMI_MANAGE too.
    """
    saved = {
        s.env_var: os.environ.pop(s.env_var, None) for s in server.CONFIG_ENV_SETTINGS
    }
    saved_manage = server.ZIMI_MANAGE
    try:
        yield os.environ
    finally:
        for name, value in saved.items():
            os.environ.pop(name, None)
            if value is not None:
                os.environ[name] = value
        server.ZIMI_MANAGE = saved_manage


def test_publication_writes_only_file_sourced_values(clean_env):
    settings = _sources(
        config={"offline": "1", "api_token": "s3cret"}, config_path="/etc/zimi.json"
    )
    published = server.apply_env_settings(settings)
    assert set(published) == {"ZIMI_OFFLINE", "ZIMI_API_TOKEN"}
    assert os.environ["ZIMI_OFFLINE"] == "1"
    assert os.environ["ZIMI_API_TOKEN"] == "s3cret"


def test_defaults_are_never_published(clean_env):
    """An unset setting must stay unset. get_hot_zims() treats a missing
    ZIMI_HOT_ZIMS as "consult hot.json" and an empty one as "no hot ZIMs";
    publishing the default would silently disable hot.json for everyone."""
    assert server.apply_env_settings(_sources()) == []
    for setting in server.CONFIG_ENV_SETTINGS:
        assert setting.env_var not in os.environ


def test_publication_never_overwrites_an_exported_variable(clean_env, monkeypatch):
    monkeypatch.setenv("ZIMI_OFFLINE", "0")
    settings = server.resolve_settings(
        env=os.environ, config={"offline": "1"}, config_path="/etc/zimi.json"
    )
    assert server.apply_env_settings(settings) == []
    assert os.environ["ZIMI_OFFLINE"] == "0"


@pytest.mark.parametrize(
    "config,expected",
    [({"manage": False}, False), ({"manage": True}, True), ({}, True)],
)
def test_publication_rebinds_the_manage_global(
    clean_env, monkeypatch, config, expected
):
    """ZIMI_MANAGE is read into a global at import, so publishing alone would
    be too late for it."""
    monkeypatch.setattr(server, "ZIMI_MANAGE", not expected)
    encoded = {k: ("1" if v else "0") for k, v in config.items()}
    server.apply_env_settings(_sources(config=encoded, config_path="/etc/zimi.json"))
    assert server.ZIMI_MANAGE is expected


def test_manage_global_keeps_its_exact_env_semantics(clean_env, monkeypatch):
    """Only "1" ever enabled management via the environment. A file cannot
    loosen that, because the file's value is canonicalised to "1"/"0" and the
    env value is passed through untouched."""
    monkeypatch.setenv("ZIMI_MANAGE", "true")
    server.apply_env_settings(server.resolve_settings(env=os.environ))
    assert server.ZIMI_MANAGE is False


# ---------------------------------------------------------------------------
# `zimi config` — provenance and secret masking
# ---------------------------------------------------------------------------


def test_report_masks_secrets_but_keeps_their_provenance():
    settings = _sources(
        config={"manage_password": "hunter2", "api_token": "zzz123"},
        config_path="/etc/zimi.json",
    )
    report = server.format_config_report(settings)
    assert "hunter2" not in report and "zzz123" not in report
    assert server.CONFIG_SECRET_MASK in report
    assert "config file: /etc/zimi.json" in report


def test_report_shows_an_unset_value_as_visibly_empty():
    report = server.format_config_report(_sources())
    hot = [line for line in report.splitlines() if line.startswith("hot_zims")][0]
    assert server.CONFIG_EMPTY_MASK in hot
    assert "hot.json" in hot  # the default note says where it looks instead


def _run_cli(args, env_overrides):
    env = os.environ.copy()
    for k in ("ZIM_DIR", "ZIMI_DATA_DIR", "ZIMI_HOST", "ZIMI_PORT", "ZIMI_CONFIG"):
        env.pop(k, None)
    for setting in server.CONFIG_ENV_SETTINGS:
        env.pop(setting.env_var, None)
    env.update(env_overrides)
    return subprocess.run(
        [sys.executable, "-m", "zimi", *args],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
    )


def _parse_report(stdout):
    rows = {}
    for line in stdout.splitlines():
        line = line.strip()
        if not line or not line.endswith(")"):
            continue
        head, _, source = line[:-1].rpartition("(")
        key, value = head.split()
        rows[key] = (value, source.strip())
    return rows


def test_cli_reports_a_widened_key_as_coming_from_the_file(cfg_dir):
    """The deliverable: a setting with no flag, set only in the file, shown by
    `zimi config` with the file as its source."""
    path = _write_config(
        cfg_dir, {"offline": True, "hot_zims": ["wikipedia_en_all"], "manage": False}
    )
    proc = _run_cli(["config", "--config", path], {})
    assert proc.returncode == 0, proc.stderr
    reported = _parse_report(proc.stdout)
    assert reported["offline"] == ("1", f"config file: {path}")
    assert reported["hot_zims"] == ("wikipedia_en_all", f"config file: {path}")
    assert reported["manage"] == ("0", f"config file: {path}")
    assert reported["index_throttle"] == ("1", "default")


def test_cli_reports_env_over_file_for_a_widened_key(cfg_dir):
    path = _write_config(cfg_dir, {"offline": True})
    proc = _run_cli(["config", "--config", path], {"ZIMI_OFFLINE": "0"})
    assert proc.returncode == 0, proc.stderr
    assert _parse_report(proc.stdout)["offline"] == ("0", "env: ZIMI_OFFLINE")


def test_cli_never_prints_a_configured_secret(cfg_dir):
    path = _write_config(cfg_dir, {"manage_password": "hunter2", "api_token": "tok123"})
    proc = _run_cli(["config", "--config", path], {})
    assert proc.returncode == 0, proc.stderr
    assert "hunter2" not in proc.stdout
    assert "tok123" not in proc.stdout
    reported = _parse_report(proc.stdout)
    assert reported["manage_password"] == (
        server.CONFIG_SECRET_MASK,
        f"config file: {path}",
    )
