/* Zimi's footer: "Zimi 1.15.5 · Powered by Kiwix", the line Home ends on, drawn the same on the Games' and the Almanac's pages.
   One file for all three: Zimi's server inlines it (and zimifooter.css) into the shell's head; each own ZIM carries it (the Games'
   folder, almanacstage for the Almanac). The address is written here, once. Home's own markup (templates/index.html) is this
   function's output, and a test keeps the two equal.
     ZimiFooter.html({ version: '1.15.5', year: 2026, poweredBy: 'Powered by' })  ->  the <footer> as a string
     ZimiFooter.inner(opts)                                                           ->  what goes inside it
   Inside Zimi the page says its version; read from a file or from Kiwix, the version the ZIM was built with, else the build's year
   (both from zimibuild.js, which ownzims writes into each ZIM, never the reader's clock; the year with a copyright sign). The words after the name are the
   caller's (each page has its own language files). */
(function (root) {
  var HOME = 'https://github.com/epheterson/Zimi';
  var KIWIX = 'https://kiwix.org';
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function inner(o) {
    o = o || {};
    var stamp = o.version ? esc(o.version) + ' ' : o.year ? '© ' + esc(o.year) + ' ' : '';
    return '<a href="' + HOME + '" target="_blank" rel="noopener" class="footer-brand zimi-brand">Zimi</a> ' +
      '<span class="footer-version">' + stamp + '</span>&middot; <span>' + esc(o.poweredBy || 'Powered by') + '</span> ' +
      '<a href="' + KIWIX + '" target="_blank" rel="noopener">Kiwix</a>';
  }
  function html(o) { return '<footer class="footer zimi-footer">' + inner(o) + '</footer>'; }
  root.ZIMI_HOME = HOME;
  root.ZimiFooter = { html: html, inner: inner };
})(typeof window !== 'undefined' ? window : globalThis);
