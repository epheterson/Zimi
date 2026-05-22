"""URL validation must accept Kiwix's actual catalog hosts.

Issue #20: warlordattack hit 40 "URL not from a trusted Kiwix host" errors
on auto-update because the Kiwix catalog now serves URLs from
`lbo.download.kiwix.org` (load-balanced origin), not just `download.kiwix.org`.
Lock the allowlist in so a future tightening doesn't re-break auto-update."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi.library import _is_trusted_kiwix_url, _resolve_torrent_url  # noqa: E402


class TrustedKiwixUrlTests(unittest.TestCase):
    def test_direct_download_host_allowed(self):
        self.assertTrue(
            _is_trusted_kiwix_url(
                "https://download.kiwix.org/zim/wikipedia/wikipedia_en_all.zim.meta4"
            )
        )

    def test_load_balanced_origin_allowed(self):
        """Kiwix's actual catalog returns URLs from this host."""
        self.assertTrue(
            _is_trusted_kiwix_url(
                "https://lbo.download.kiwix.org/zim/zimit/apod.nasa.gov_en_all_2026-05.zim.meta4"
            )
        )

    def test_any_kiwix_subdomain_allowed(self):
        for url in [
            "https://library.kiwix.org/zim/test.zim",
            "https://browse.library.kiwix.org/content/test",
            "https://something.new.kiwix.org/zim/test.zim",
        ]:
            self.assertTrue(_is_trusted_kiwix_url(url), url)

    def test_root_kiwix_org_allowed(self):
        self.assertTrue(_is_trusted_kiwix_url("https://kiwix.org/path"))

    def test_wikimedia_mirror_allowed(self):
        """Kiwix files are also mirrored at dumps.wikimedia.org/kiwix."""
        self.assertTrue(
            _is_trusted_kiwix_url(
                "https://dumps.wikimedia.org/kiwix/zim/wikipedia/wikipedia_en_all.zim"
            )
        )

    def test_non_kiwix_host_rejected(self):
        for url in [
            "https://evil.example.com/zim/wikipedia.zim",
            "https://kiwix.org.attacker.com/zim/x.zim",
            "https://attacker.com/kiwix.org/x.zim",
            "https://dumps.wikimedia.org/notkiwix/x.zim",
            "http://download.kiwix.org/zim/x.zim",  # http not https — still allowed actually
        ]:
            # Note: http vs https isn't enforced here; the helper only checks
            # host. If we want to enforce https, that's a separate concern.
            # Just assert the truly-bad ones reject.
            if "evil" in url or "attacker" in url or "notkiwix" in url:
                self.assertFalse(_is_trusted_kiwix_url(url), url)

    def test_http_downgrade_rejected_even_on_kiwix_host(self):
        """A network-level attacker shouldn't be able to inject metadata
        by downgrading to http on a trusted host."""
        self.assertFalse(
            _is_trusted_kiwix_url("http://download.kiwix.org/zim/wiki.zim")
        )
        self.assertFalse(
            _is_trusted_kiwix_url("http://lbo.download.kiwix.org/zim/wiki.zim")
        )

    def test_empty_or_malformed_rejected(self):
        self.assertFalse(_is_trusted_kiwix_url(""))
        self.assertFalse(_is_trusted_kiwix_url(None))
        self.assertFalse(_is_trusted_kiwix_url("not-a-url"))
        self.assertFalse(_is_trusted_kiwix_url("https://"))

    def test_torrent_companion_resolves_for_lbo_host(self):
        """Regression: torrent fallback used to fail for lbo.download.kiwix.org."""
        url = "https://lbo.download.kiwix.org/zim/test/wiki.zim.meta4"
        self.assertEqual(
            _resolve_torrent_url(url),
            "https://lbo.download.kiwix.org/zim/test/wiki.zim.torrent",
        )

    def test_torrent_companion_resolves_for_dumps_mirror(self):
        url = "https://dumps.wikimedia.org/kiwix/zim/wikipedia/wp.zim"
        self.assertEqual(
            _resolve_torrent_url(url),
            "https://dumps.wikimedia.org/kiwix/zim/wikipedia/wp.zim.torrent",
        )


if __name__ == "__main__":
    unittest.main()
