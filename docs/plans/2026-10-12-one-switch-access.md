# One switch for managing Zimi (1.13.3)

Eric, 2026-10-12, after the outside switch and a reverse proxy produced a password that could not be turned off at home: "I'm feeling like we stop trying to determine local or remote ... and just have one toggle to require a password to manage." Go given the same night: "Yeah built it."

## The model

- **Require a password to manage**: the only switch.
  - On: whoever has the password manages Zimi, from anywhere.
  - Off: anyone who can reach Zimi manages it. Turning it off takes one named press ("Turn off password", on a first run too) under the cost line, plus the current password when one exists. The password is kept for when the switch comes back on.
- Zimi stops judging where a request came from when deciding who manages. The only place it still asks is the first-run gate (the machine running Zimi, or the setup key: GHSA-5mw2-53vv-9pw6). That gate is unchanged, and so is the rule that no password is never a default.

## Removed

- The "Allow managing from outside my network" switch, and the saved wall it wrote (`manage_external` in prefs is no longer read).
- "Anyone on my network" as a choice on the page.
- The page's proxy lock and the server refusals `behind_proxy` and `outside_here`.
- The API token rule that refused password-off while a token exists. The token is kept and works again when the password returns. Its row shows only while a password is on.

## Kept, for installs that chose them deliberately

- `ZIMI_LAN_ADMIN=1` and a saved network-only answer (`lan_admin` in prefs) keep working as saved: the page shows the switch off with "Anyone on your network can manage Zimi." Nobody's install widens on upgrade.
- `ZIMI_MANAGE_EXTERNAL=0` still walls Manage inside the network. It is environment only, with no switch.
- `ZIMI_MANAGE_OPEN` and `ZIMI_MANAGE_PASSWORD` are unchanged.

## Rules kept

- No password on a first run is allowed only through the gate (host or setup key), with the cost line and an explicit press.
- While the password is off, nothing that outlives it can be made: tokens, accounts, BitTorrent client, private captures.
- With a kept password, turning the switch on restores that password. A new password can be set while it is off only when none is kept (else a visitor could replace the owner's).

## Checklist

- [ ] manage.py: `_handle_access` without external and lan, open allowed on a first run behind the gate, `manage_external()` env only, the token rule gone from both places
- [ ] app.js: one switch, cost line, first-run variant, token row only with a password, stale error cleared
- [ ] i18n x10: drop the outside and proxy strings; add the first-run cost line
- [ ] tests: rewrite the access tests to the new model; prove the new ones fail on the old code
- [ ] docs/features/access.md and CHANGELOG
- [x] Full suite, deploy to the NAS, the owner's three addresses (the LAN name behind a proxy, the public name, the direct address) at 390px
- [ ] Independent review before the PR is called ready
