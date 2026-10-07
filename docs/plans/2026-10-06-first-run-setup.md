# First-run setup: who can change settings (1.13.1, #107)

Eric, 2026-10-06: "don't we already have initial setup on the desktop platforms, can we piggyback on that as another page? Required to complete before using Zimi (unless filled in by env vars)? Allow Manage on external networks (default off?) then below it, on and uneditable if external is enabled, Require password for Manage / If enabled show an a user / pass / confirmation box right there and save it securely. Username must show for password managers and to allow them to edit from admin, empty with admin showing in background." Then: "Block for setup all new self hosted installs have a blocked setup. Yeah we take time in the .1 no hurry get it right".

Replaces the Settings card from 5bbd1bca (never released). Its server gate is reused.

## The page

Shown in the "Welcome to Zimi" overlay (the desktop onboarding card, now shared):

- **Allow changing settings from outside my network** (off)
- **Require a password to change settings** (on and locked while the row above is on, or when this browser reaches Zimi through a proxy)
  - Username (empty, placeholder `admin`, `autocomplete="username"`), Password, Confirm (`new-password`)
- **Continue**

Wording: "settings", the app's word for that place, not "Manage".

## States (server)

| Password | Outside | Meaning |
|---|---|---|
| no | no | `lan`: anyone directly on the network may change settings |
| yes | no | `password`, and requests from outside the network get no settings even with it |
| yes | yes | `password` from anywhere (every install before 1.13.1 that has a password) |

`unset` (no password, no choice) stays the GHSA-5mw2-53vv-9pw6 default: only the host or the setup key.

Precedence: `ZIMI_MANAGE_OPEN` > `ZIMI_MANAGE_PASSWORD` / password file > `ZIMI_LAN_ADMIN` > saved choice. New `ZIMI_MANAGE_EXTERNAL` (config `manage_external`) over the saved choice; the default with neither is on, so nobody upgrading loses remote settings.

"Outside my network" = `_is_private_client()` is false (the resolved client, so the LAN behind a Synology proxy counts as inside and a Cloudflare client as outside). `lan` keeps its stricter direct-only test.

## Who must finish it, and when

- A fresh self-hosted install (`zimi serve` / Docker not bound to loopback, data dir with no password, setup key, prefs or users file at first start) writes `setup_gate: true`. Until setup is done:
  - remote clients get only the shell, static files, `/health`, `/manage/has-password` and `/manage/access`; everything else answers 503 `setup_pending`; the SPA shows the setup overlay (setup key first when off-host, "being set up" for the internet).
  - the host's API keeps answering (local agents, tests); its browser shows the overlay.
- Existing installs never get the gate. Passwordless ones keep today's behaviour and see the page in Settings.
- Env vars that decide access (`ZIMI_MANAGE_OPEN`, `ZIMI_MANAGE_PASSWORD`, `ZIMI_LAN_ADMIN`) mean there is nothing to ask.
- Desktop (loopback by default): page 2 of onboarding is "Other devices on my network can use Zimi" (the existing `lan_access`), with the rows above revealed when on.

## One endpoint

`POST /manage/access {external, require_password, username, password}`

- Before a password exists: the bootstrap gate (host or setup key). After: admin auth.
- Env-owned fields → 403. `external` without a password → 400. No password from behind a proxy → 409 `behind_proxy`.
- Writes password+username (hash, line 2), `manage_external`, `lan_admin`, clears `setup_gate` and the setup key, mints an admin session cookie when it set a password.
- Settings → Server shows the same rows (minus the password fields once one exists; Change password stays where it is) and saves through the same endpoint.

## Checklist

- [ ] manage.py: `manage_external()`, `access_state()`, the wall in `_check_manage_auth`, `/manage/access` v2, set-password keeps `lan_admin` coherent
- [ ] server.py: `manage_external` ConfigSetting, fresh-install gate at startup, banner text
- [ ] http.py: `setup_pending` gate for remote clients
- [ ] envinfo.py: `ZIMI_MANAGE_EXTERNAL`
- [ ] tests: state table, wall in/out, gate, migration (existing installs never gated), env precedence, GHSA (neighbour without key cannot finish setup)
- [ ] index.html + app.js + app.css: shared setup page in the onboarding overlay; Settings rows; remove the 5bbd1bca card
- [ ] i18n x10
- [ ] desktop.py / desktop onboarding page 2
- [ ] browser test: fresh gated server, remote-shaped client sees key → page → library
- [ ] docs: features/access.md, deployment-networking.md, CHANGELOG
- [ ] screenshots for Eric (desktop, phone, dark/light), NAS deploy (NAS has a password: must not see the page)
- [ ] reword the #107 reply draft
