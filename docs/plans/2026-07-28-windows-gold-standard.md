# Windows gold-standard update test (1.8.0 → 1.8.1)

**Goal:** prove, on the maintainer's real Windows PC, that a Zimi Windows
install auto-updates end-to-end via WinSparkle — detect → download → verify
signature → run installer **silently** → relaunch at the new version — before
1.8.1 ships. ~10 minutes.

---

## The one thing you must know first: prerelease tags are NOT safe

A prerelease tag like `v1.8.1-rc1` **is unsafe** as a staging mechanism. It is
not a theoretical risk — here is exactly what it does:

- `desktop-release.yml` triggers on `push: tags: ['v*.*.*']`. The glob matches
  `v1.8.1-rc1` (`v1` . `8` . `1-rc1`), so the tag **builds all platforms**.
- Its `release` job then runs unconditionally for any tag and, in the same run:
  1. **rewrites `appcast-windows.xml`, `appcast-arm64.xml`, `appcast-intel.xml`
     on `main` and pushes them** (job "Sign updates and update appcasts",
     `git push origin main`). Every existing 1.8.0 user's app polls those files
     — they would immediately be told to "update" to the RC.
  2. **pushes a Homebrew cask bump** to `epheterson/homebrew-zimi`.
  3. creates a GitHub draft release for the RC.

So a prerelease tag mutates the three **production** appcasts and the Homebrew
tap. Do not use one for testing. (If we ever want RC tags to be safe, the fix is
to gate the "update appcasts" + "Homebrew cask" steps on
`!contains(github.ref_name, '-')` — out of scope here, noted for later.)

**The safe lever instead:** `ZIMI_APPCAST_URL` (added to `zimi_winsparkle.py`
this release). Setting it points a build at a throwaway feed without touching
anything on `main`. Caveat that shapes the whole procedure below: **the shipped
1.8.0 predates this override**, so the real 1.8.0 artifact cannot be redirected
— it can only ever read the production feed. We therefore split the test.

---

## Part A — sanity-check the real shipped 1.8.0 (2 min)

Confirms the artifact users actually have is wired to the right feed.

1. Download `Zimi-windows-x64-Setup.exe` from the published
   [1.8.0 release](https://github.com/epheterson/Zimi/releases/tag/v1.8.0) and
   run it (per-user, no UAC prompt).
2. Launch Zimi. Leave it open ~30 s.
3. **Pass:** the app opens, and the log shows WinSparkle initialising and
   checking against `raw.githubusercontent.com/.../appcast-windows.xml`. Because
   production still advertises 1.8.0, it reports "up to date" (no prompt). This
   proves the shipped updater is alive and pointed at the right URL. It cannot
   be driven to 1.8.1 here (no override in 1.8.0) — that is Part B's job.

---

## Part B — prove the auto-update mechanism, safely (6 min)

Rehearses 1.8.0 → 1.8.1 with the **real** WinSparkle path and a **local** feed.
Nothing on `main` is touched.

### One-time prep (done the night before, or first thing)

1. **Staged installer (the "1.8.1" the test updates *to*).** Bump
   `pyproject.toml` to `1.8.1` in a scratch checkout and build the installer —
   either locally with Inno Setup:
   ```
   iscc /DMyAppVersion=1.8.1 windows\zimi.iss   # → dist\Zimi-windows-x64-Setup.exe
   ```
   or grab the artifact from a **bare** `workflow_dispatch` run of
   `desktop-release.yml` with **no tag input** — that runs the build matrix only;
   the `release` job is skipped (`if: startsWith(github.ref,'refs/tags/') ||
   inputs.tag != ''`), so no appcast/tag/cask is touched. Rename the artifact to
   `Zimi-windows-x64-Setup.exe`.

2. **Sign it** with the same Ed25519 key the release uses (on the Mac, with
   `SPARKLE_PRIVATE_KEY` available):
   ```
   sign_update Zimi-windows-x64-Setup.exe --ed-key-file <(echo "$SPARKLE_PRIVATE_KEY")
   ```
   Note the `sparkle:edSignature="…"` and `length="…"` it prints.

3. **Write a test appcast** `appcast-windows-test.xml` next to the installer.
   Same shape the CI generates, advertising **1.8.1**, enclosure `url` pointing
   at the locally-served installer, with the signature/length from step 2 and
   the silent-install args:
   ```xml
   <?xml version="1.0" encoding="utf-8"?>
   <rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
     <channel>
       <title>Zimi Updates</title>
       <item>
         <sparkle:version>1.8.1</sparkle:version>
         <sparkle:shortVersionString>1.8.1</sparkle:shortVersionString>
         <enclosure
           url="http://localhost:8000/Zimi-windows-x64-Setup.exe"
           length="PASTE_LENGTH"
           type="application/octet-stream"
           sparkle:edSignature="PASTE_SIGNATURE"
           sparkle:installerArguments="/SILENT /SP-" />
       </item>
     </channel>
   </rss>
   ```

4. **Baseline app (the "1.8.0" the test updates *from*).** Build the current
   `v1.8.1` branch **as-is** (its `pyproject.toml` still reports `1.8.0`) — this
   is effectively "1.8.0 + the `ZIMI_APPCAST_URL` override", which is precisely
   what makes the redirect possible. Install it. It reports version 1.8.0, so
   WinSparkle will see 1.8.1 in the test feed as an upgrade.

### The test (run in the morning)

1. In the folder holding the signed installer + `appcast-windows-test.xml`:
   ```
   python -m http.server 8000
   ```
2. Point the baseline app at the test feed and launch it:
   ```
   set ZIMI_APPCAST_URL=http://localhost:8000/appcast-windows-test.xml
   "%LOCALAPPDATA%\Programs\Zimi\Zimi.exe"
   ```
3. WinSparkle checks on launch, finds 1.8.1, verifies the EdDSA signature
   against the bundled public key, and offers the update. Accept it.
4. Watch: the installer runs **silently** (a progress window, no wizard pages,
   no UAC), the old app closes, and Zimi **relaunches on its own** at 1.8.1.

### Pass criteria

- [ ] Update prompt appears (signature verified — a bad/missing signature is
      rejected and no prompt shows).
- [ ] Install is click-free: `/SILENT /SP-` means progress only, no wizard, no
      UAC (per-user install).
- [ ] The app **relaunches by itself** after install (this is the risky bit:
      WinSparkle 0.9.4 quits without relaunching, so the installer's `[Run]`
      entry — now without `skipifsilent` — must do it).
- [ ] Relaunched app reports **1.8.1** (About / `/api` version / window title).
- [ ] Exactly **one** Zimi instance is running afterwards (no double-launch).

If the relaunch check fails, that is the finding — the `skipifsilent` removal in
`windows/zimi.iss` is the fix under test; capture the behavior and iterate
before the real ship.

---

## The real ship (the ultimate truth)

Part B proves the mechanism; the release itself is the final 1.8.0 → 1.8.1
proof. After merging 1.8.1 (version bump → `auto-release.yml` tags + drafts →
`desktop-release.yml` builds/signs/attaches to the one draft), **publish** it.
The production `appcast-windows.xml` now advertises 1.8.1. On the Part-A machine
(real shipped 1.8.0, production feed), relaunch and let WinSparkle check — it
pulls 1.8.1 for real. Same pass criteria.

## Rollback

- **Part B:** nothing to undo — local only. Stop the `http.server`, `set
  ZIMI_APPCAST_URL=` (clear it).
- **Bad production 1.8.1:** revert the "Update appcasts for v1.8.1" commit on
  `main` so the feed re-advertises 1.8.0, and mark the 1.8.1 GitHub release as a
  draft / delete it. A user already on a bad 1.8.1 reinstalls 1.8.0 manually
  (the stable Inno `AppId` upgrades in place).
