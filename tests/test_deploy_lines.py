"""deploy.sh and scripts/nas-line against a fake NAS: a temp directory, and stubs for ssh, docker-compose
and curl that record what they are asked to do. Nothing here touches a network or a Docker daemon.

The promises: the plan comes from a manifest kept on the NAS (so any clone of any line deploys
correctly, and a switch between lines removes exactly the other line's files); a code-only deploy
sends only the changed files; the container is stopped before it is recreated; bad arguments
deploy nothing; --help and --dry-run change nothing.

Run: pytest tests/test_deploy_lines.py -v
"""

import hashlib
import os
import shutil
import stat
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
DEPLOY = ROOT / "deploy.sh"
NAS_LINE = ROOT / "scripts" / "nas-line"
PLAN = ROOT / "scripts" / "deploy_plan.py"

pytestmark = pytest.mark.skipif(
    sys.platform == "win32", reason="deploy.sh is a bash script"
)

SSH_STUB = r"""#!/bin/bash
# Fake ssh: skip options, take the host, run the command locally. The tar stream is kept so the
# test can see which files crossed the wire.
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    -O) exit 0 ;;
    -*) shift ;;
    *) break ;;
  esac
done
shift                     # the host
cmd="$*"
echo "ssh: $cmd" >> "$FAKE_LOG"
case "$cmd" in
  *"tar xf -"*)
    cat > "$FAKE_STATE/stream.tar"
    tar tf "$FAKE_STATE/stream.tar" | sed 's/^/tar: /' >> "$FAKE_LOG"
    bash -c "$cmd" < "$FAKE_STATE/stream.tar" ;;
  *) bash -c "$cmd" ;;
esac
"""

COMPOSE_STUB = r"""#!/bin/bash
echo "docker-compose $*" >> "$FAKE_LOG"
case "$1" in
  build) [ -n "${FAKE_BUILD_FAIL:-}" ] && { echo "build failed" >&2; exit 1; }; true ;;
  stop) rm -f "$FAKE_STATE/running" ;;
  up) [ -f "$FAKE_STATE/running" ] && echo "RECREATE-WHILE-RUNNING" >> "$FAKE_LOG"; : > "$FAKE_STATE/running" ;;
esac
exit 0
"""

DOCKER_STUB = '#!/bin/bash\necho "docker $*" >> "$FAKE_LOG"\nexit 0\n'
CURL_STUB = '#!/bin/bash\n[[ "$*" == *"-o /dev/null"* ]] && exit 0\necho \'{"status":"ok","version":"1.2.3"}\'\n'


def run(cmd, cwd=None, env=None, check=True, stdin=subprocess.DEVNULL):
    p = subprocess.run(
        cmd, cwd=cwd, env=env, text=True, capture_output=True, stdin=stdin
    )
    if check and p.returncode != 0:
        raise AssertionError(f"{cmd} exited {p.returncode}\n{p.stdout}\n{p.stderr}")
    return p


def git(cwd, *args):
    return run(["git", *args], cwd=cwd).stdout.strip()


def write(root, rel, text):
    p = Path(root) / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def tree_of(
    root,
    tops=("zimi", "docker", "requirements.txt", "Dockerfile", "docker-compose.nas.yml"),
):
    """{path: sha256} of the deployable files under root, like the NAS should hold."""
    out = {}
    for top in tops:
        base = Path(root) / top
        files = (
            [base]
            if base.is_file()
            else (
                sorted(f for f in base.rglob("*") if f.is_file())
                if base.exists()
                else []
            )
        )
        for f in files:
            if "__pycache__" in f.parts or f.suffix == ".pyc":
                continue
            out[str(f.relative_to(root))] = hashlib.sha256(f.read_bytes()).hexdigest()
    return out


class World:
    def __init__(self, base: Path):
        self.base = base
        self.nas = base / "nas"
        self.bin = base / "bin"
        self.state = base / "state"
        self.tmp = base / "tmp"
        self.log = base / "calls.log"
        for d in (self.nas, self.bin, self.state, self.tmp):
            d.mkdir()
        for name, body in (
            ("ssh", SSH_STUB),
            ("docker-compose", COMPOSE_STUB),
            ("docker", DOCKER_STUB),
            ("curl", CURL_STUB),
        ):
            f = self.bin / name
            f.write_text(body, encoding="utf-8")
            f.chmod(f.stat().st_mode | stat.S_IEXEC)
        self.log.write_text("", encoding="utf-8")
        (self.nas / "zimi-data").mkdir()
        (self.nas / "zimi-data" / "keep.db").write_text("user data", encoding="utf-8")
        (self.nas / "wikipedia.zim").write_text("a library file", encoding="utf-8")
        self.origin = self._make_origin()
        self.env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "ZIMI_NAS_HOST": "nas",
            "ZIMI_NAS_DIR": str(self.nas),
            "ZIMI_NAS_BIN": str(self.bin),
            "ZIMI_DEPLOY_NO_CF": "1",
            "FAKE_LOG": str(self.log),
            "FAKE_STATE": str(self.state),
            "TMPDIR": str(self.tmp),
            "ZIMI_LINES_REPO": str(self.origin),
        }
        self.env.pop("ZIMI_DEPLOY_SRC", None)
        self.env.pop("ZIMI_DEPLOY_REF", None)

    def _make_origin(self):
        """A bare repo with line/patch and line/minor; minor adds, changes and drops files."""
        seed = self.base / "seed"
        seed.mkdir()
        git(seed, "init", "-q", "-b", "line/patch")
        git(seed, "config", "user.email", "t@example.com")
        git(seed, "config", "user.name", "t")
        git(seed, "config", "commit.gpgsign", "false")
        write(seed, "zimi/__init__.py", "x = 1\n")
        write(seed, "zimi/a.py", "a = 'patch'\n")
        write(seed, "zimi/patch_only.py", "p = 1\n")
        write(seed, "zimi/sub/deep.py", "d = 1\n")
        write(seed, "docker/entry.sh", "echo hi\n")
        write(seed, "requirements.txt", "libzim\n")
        write(seed, "Dockerfile", "FROM scratch\n")
        write(seed, "docker-compose.nas.yml", "services: {}\n")
        write(seed, "README.md", "not deployed\n")
        shutil.copy(DEPLOY, seed / "deploy.sh")
        (seed / "scripts").mkdir()
        shutil.copy(PLAN, seed / "scripts" / "deploy_plan.py")
        git(seed, "add", "-A")
        git(seed, "commit", "-q", "-m", "patch line")
        git(seed, "checkout", "-q", "-b", "line/minor")
        write(seed, "zimi/a.py", "a = 'minor'\n")
        write(seed, "zimi/minor_only.py", "m = 1\n")
        write(seed, "zimi/sub/deeper/new.py", "n = 1\n")
        (seed / "zimi" / "patch_only.py").unlink()
        git(seed, "add", "-A")
        git(seed, "commit", "-q", "-m", "minor line")
        bare = self.base / "origin.git"
        git(self.base, "clone", "-q", "--bare", str(seed), str(bare))
        return bare

    def clone(self, branch, name):
        dest = self.base / name
        git(self.base, "clone", "-q", "--branch", branch, str(self.origin), str(dest))
        git(dest, "config", "user.email", "t@example.com")
        git(dest, "config", "user.name", "t")
        git(dest, "config", "commit.gpgsign", "false")
        return dest

    def deploy(self, tree, *args, check=True):
        return run(
            ["bash", str(tree / "deploy.sh"), *args],
            cwd=tree,
            env=self.env,
            check=check,
        )

    def calls(self):
        return self.log.read_text(encoding="utf-8").splitlines()

    def reset_log(self):
        self.log.write_text("", encoding="utf-8")

    def manifest(self):
        return (self.nas / ".zimi-deploy" / "manifest").read_text(encoding="utf-8")

    def nas_tree(self):
        return tree_of(self.nas)

    def nas_snapshot(self):
        return {
            str(f.relative_to(self.nas)): f.read_bytes()
            for f in sorted(self.nas.rglob("*"))
            if f.is_file()
        }


@pytest.fixture
def world(tmp_path):
    return World(tmp_path)


def test_first_deploy_sends_everything_and_records_the_manifest(world):
    tree = world.clone("line/patch", "a1")
    out = world.deploy(tree).stdout
    assert world.nas_tree() == tree_of(tree)
    assert "send 8, remove 0" in out
    man = world.manifest()
    assert "# ref\tline/patch" in man and "# state\tdeployed" in man
    assert f"# commit\t{git(tree, 'rev-parse', '--short', 'HEAD')}" in man
    assert not (world.nas / ".deploy.lock").exists()
    assert (world.nas / "docker-compose.yml").read_text(encoding="utf-8") == "services: {}\n"
    assert (world.nas / "zimi-data" / "keep.db").read_text(encoding="utf-8") == "user data"


def test_code_only_redeploy_sends_only_changed_files(world):
    tree = world.clone("line/patch", "a1")
    world.deploy(tree)
    write(tree, "zimi/a.py", "a = 'changed'\n")
    git(tree, "commit", "-qam", "edit")
    world.reset_log()
    out = world.deploy(tree).stdout
    assert "send 1, remove 0, unchanged 7" in out
    assert [c for c in world.calls() if c.startswith("tar: ")] == ["tar: zimi/a.py"]
    assert world.nas_tree() == tree_of(tree)


def test_a_file_deleted_in_the_tree_is_removed_from_the_nas(world):
    tree = world.clone("line/patch", "a1")
    world.deploy(tree)
    git(tree, "rm", "-q", "zimi/sub/deep.py")
    git(tree, "commit", "-qm", "drop")
    out = world.deploy(tree).stdout
    assert "send 0, remove 1" in out
    assert not (world.nas / "zimi/sub/deep.py").exists()


def test_switching_lines_removes_the_other_lines_files_and_back(world):
    a = world.clone("line/patch", "a1")
    b = world.clone("line/minor", "b1")
    world.deploy(a)
    before_a = world.nas_tree()
    out = world.deploy(b).stdout
    assert "line/patch@" in out and "-> line/minor@" in out
    assert world.nas_tree() == tree_of(b)
    assert not (world.nas / "zimi/patch_only.py").exists()
    assert (world.nas / "zimi/minor_only.py").exists()
    assert "# ref\tline/minor" in world.manifest()
    world.deploy(a)
    assert world.nas_tree() == before_a == tree_of(a)
    assert not (world.nas / "zimi/minor_only.py").exists()
    assert not (world.nas / "zimi/sub/deeper/new.py").exists()
    assert (world.nas / "zimi-data" / "keep.db").read_text(encoding="utf-8") == "user data"
    assert (world.nas / "wikipedia.zim").read_text(encoding="utf-8") == "a library file"


def test_a_second_clone_with_no_local_state_deploys_correctly(world):
    a = world.clone("line/patch", "a1")
    world.deploy(a)
    b = world.clone("line/minor", "b-fresh")
    world.deploy(b)
    assert world.nas_tree() == tree_of(b)
    again = world.clone("line/minor", "b-other-clone")
    out = world.deploy(again).stdout
    assert "send 0, remove 0" in out
    a2 = world.clone("line/patch", "a-other-clone")
    world.deploy(a2)
    assert world.nas_tree() == tree_of(a2)


def test_unknown_arguments_refuse_and_deploy_nothing(world):
    tree = world.clone("line/patch", "a1")
    for args in (["--bogus"], ["-x"], ["now"], ["--dry-run", "extra"]):
        p = world.deploy(tree, *args, check=False)
        assert p.returncode == 2, args
        assert "nothing deployed" in p.stderr
    assert world.calls() == []
    assert (
        not (world.nas / ".zimi-deploy").exists() and not (world.nas / "zimi").exists()
    )


def test_help_and_dry_run_change_nothing(world):
    tree = world.clone("line/patch", "a1")
    p = world.deploy(tree, "--help")
    assert "--dry-run" in p.stdout and world.calls() == []
    assert not (world.nas / "zimi").exists()

    b = world.clone("line/minor", "b1")
    world.deploy(tree)
    snap = world.nas_snapshot()
    world.reset_log()
    out = world.deploy(b, "--dry-run").stdout
    assert "line/patch@" in out and "-> line/minor@" in out
    assert "send 3, remove 1, unchanged 6" in out
    assert world.nas_snapshot() == snap
    calls = world.calls()
    assert len(calls) == 1 and calls[0].startswith("ssh: cat ") and "/manifest" in calls[0], calls


def test_the_container_is_stopped_before_it_is_recreated(world):
    tree = world.clone("line/patch", "a1")
    world.deploy(tree)
    write(tree, "zimi/a.py", "a = 2\n")
    git(tree, "commit", "-qam", "edit")
    world.reset_log()
    world.deploy(tree)
    calls = world.calls()
    idx = {
        k: next(i for i, c in enumerate(calls) if c.startswith(f"docker-compose {k}"))
        for k in ("build", "stop", "up")
    }
    assert idx["build"] < idx["stop"] < idx["up"], calls
    assert "RECREATE-WHILE-RUNNING" not in calls


def test_a_failed_build_leaves_the_manifest_honest_and_the_next_deploy_finishes(world):
    tree = world.clone("line/patch", "a1")
    world.env["FAKE_BUILD_FAIL"] = "1"
    p = world.deploy(tree, check=False)
    assert p.returncode != 0
    assert "# state\tsent" in world.manifest()
    assert not (world.nas / ".deploy.lock").exists()
    del world.env["FAKE_BUILD_FAIL"]
    world.deploy(tree)
    assert "# state\tdeployed" in world.manifest()


def test_a_concurrent_deploy_is_refused(world):
    tree = world.clone("line/patch", "a1")
    (world.nas / ".deploy.lock").mkdir()
    p = world.deploy(tree, check=False)
    assert p.returncode != 0 and "another deploy" in p.stderr
    assert (world.nas / ".deploy.lock").exists()


def test_pending_manifest_drops_the_entries_about_to_be_sent(tmp_path):
    remote = tmp_path / "remote"
    remote.write_text("# ref\tx\nh1\tzimi/a.py\nh2\tzimi/b.py\n", encoding="utf-8")
    sending = tmp_path / "send"
    sending.write_text("zimi/a.py\n", encoding="utf-8")
    out = run([sys.executable, str(PLAN), "pending", str(remote), str(sending)]).stdout
    assert "zimi/b.py" in out and "zimi/a.py" not in out and "# ref\tx" in out


def test_nas_line_show_and_use(world):
    nl = [str(NAS_LINE)]
    assert "no deploy manifest" in run(nl + ["show"], env=world.env).stdout

    # no terminal and no --yes: the plan is shown, nothing deploys
    p = run(nl + ["use", "patch"], env=world.env, check=False)
    assert p.returncode != 0 and "--yes" in p.stderr
    assert not (world.nas / "zimi").exists()

    out = run(nl + ["use", "patch", "--yes"], env=world.env).stdout
    assert (
        "Switched: NAS runs line patch (line/patch)" in out and "version 1.2.3" in out
    )
    assert world.nas_tree() == tree_of(world.clone("line/patch", "chk-a"))

    snap = world.nas_snapshot()
    plan = run(nl + ["use", "minor", "-n"], env=world.env).stdout
    assert "-> line/minor@" in plan and world.nas_snapshot() == snap

    run(nl + ["use", "minor", "--yes"], env=world.env)
    assert not (world.nas / "zimi/patch_only.py").exists()
    assert "line minor (line/minor)" in run(nl + ["show"], env=world.env).stdout
    assert not list(world.tmp.glob("zimi-line.*")), "the temporary clone is cleaned up"


def test_nas_line_uses_a_clean_clone_not_the_working_tree(world):
    """A dirty local checkout cannot leak in: the line is cloned from origin."""
    dirty = world.clone("line/patch", "dirty")
    write(dirty, "zimi/uncommitted.py", "oops = 1\n")
    run([str(NAS_LINE), "use", "patch", "--yes"], cwd=dirty, env=world.env)
    assert not (world.nas / "zimi/uncommitted.py").exists()


def test_scripts_are_shellcheck_clean():
    sc = shutil.which("shellcheck")
    if not sc:
        pytest.skip("shellcheck is not installed")
    run([sc, str(DEPLOY), str(NAS_LINE)])


def test_help_text_is_stable_and_executable_bits_set():
    for f in (DEPLOY, NAS_LINE):
        assert os.access(f, os.X_OK), f"{f} must be executable"
    assert "deploy this checkout" in textwrap.dedent(
        run([str(DEPLOY), "--help"]).stdout
    )
