# GHSA-5mw2-53vv-9pw6 — response plan (DRAFT, for Eric's approval)

**Status:** advisory is in `triage` (private). Nothing below is posted. Every public step is Eric's explicit go.

## The finding, in one line
Passwordless bootstrap let any private-tier client (LAN / Docker bridge / tailnet) claim the first admin password and lock out the owner. CWE-306. Reported by EQSTLab, CVSS self-assessed 8.8 (AV:A).

## My severity read
Real and worth fixing; 8.8 is a touch high for the typical home case (attacker must already be on your trust network and win a race in the first-launch window). The sharp, legitimate part is the tailnet/CGNAT trust — a mesh-VPN peer being treated as "you". Fixed at the root.

## The fix (landed, commit 8fc884f)
Bootstrap now has exactly two doors: the host itself (loopback) sets the first password freely; every remote client presents a one-time setup key the server prints to its log and invalidates the moment a password is set. Private LAN/tailnet peers are out of the bootstrap path entirely. Pinned by `tests/test_bootstrap_takeover.py`, which reproduces the advisory's own PoC and shows it refused.

## Disclosure decisions for Eric

1. **Ship the fix in 1.9.0** (already in the release). Yes.
2. **Advisory workflow — pick the timeline:**
   - a. Fix ships in 1.9.0, THEN publish the advisory with 1.9.0 named as the patched version and 1.8.2/earlier as affected. Cleanest — never publish a live vuln without a released fix.
   - b. Also backport a 1.8.3 patch for users who can't jump to 1.9.0. (Optional; 1.8.x is a week old, most will move to 1.9.0.)
3. **Credit:** EQSTLab, as requested in their report. (Already in the CHANGELOG line.)
4. **CVE:** GitHub can assign one when the advisory publishes. Recommend yes — it's a real CWE-306 and a CVE is the honest record.
5. **The reporter's PoC repo/artifacts** referenced a private `reports/github_web_1881_...` path — that's theirs, not ours; nothing to host.

## Draft advisory comment to EQSTLab (for Eric to post, or adapt)
> Thanks for the careful report and the reproducible PoC. Confirmed and fixed: bootstrap now requires either being on the host or presenting a one-time setup key the server logs on first start, so an adjacent client can no longer claim the first admin password. Landing in 1.9.0. Credited to EQSTLab in the changelog. Appreciate the responsible disclosure.

## What I need from Eric
- Go/no-go on publishing the advisory after 1.9.0 tags (2a), and whether to also cut 1.8.3 (2b).
- Go on requesting a CVE.
- Approval (or edits) on the reporter comment above — it is public text under your name; I will not post it.
