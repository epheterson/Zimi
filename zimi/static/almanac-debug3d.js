// The 3D debug log's viewer (loaded only while the log is on: almanac-earth.js, `?debug3d=1`). A small pill over the Almanac opens the log, with Copy and Clear.
var AD_PILL_Z = 100000;
function _aeDbgPill() {
  if (document.getElementById('ae-dbg-pill')) return;
  var pill = document.createElement('button'), sheet = null;
  pill.type = 'button'; pill.id = 'ae-dbg-pill'; pill.textContent = 'log';
  pill.style.cssText = 'position:fixed;left:50%;bottom:calc(2px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:' + AD_PILL_Z + ';padding:2px 10px;border-radius:10px;border:1px solid #777;background:rgba(0,0,0,.6);color:#ccc;font:11px monospace;opacity:.7';
  function close() { if (sheet) { sheet.remove(); sheet = null; } }
  function open() {
    close();
    sheet = document.createElement('div');
    sheet.style.cssText = 'position:fixed;inset:0;z-index:' + (AD_PILL_Z + 1) + ';display:flex;flex-direction:column;background:#000;color:#9f9;font:10px/1.35 monospace';
    var bar = document.createElement('div'), pre = document.createElement('pre');
    bar.style.cssText = 'display:flex;gap:8px;padding:8px;padding-top:calc(8px + env(safe-area-inset-top))';
    pre.style.cssText = 'flex:1;overflow:auto;margin:0;padding:8px;white-space:pre-wrap;word-break:break-all;-webkit-user-select:text;user-select:text';
    pre.textContent = _aeDbgText();
    function btn(label, run) { var b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.style.cssText = 'padding:8px 14px;font:13px sans-serif'; b.onclick = run; bar.appendChild(b); return b; }
    var copy = btn('Copy', function () {
      var done = function () { copy.textContent = 'Copied'; };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(pre.textContent).then(done, function () { pre.focus(); });
      else { var r = document.createRange(); r.selectNodeContents(pre); var s = getSelection(); s.removeAllRanges(); s.addRange(r); try { document.execCommand('copy'); done(); } catch (e) {} }
    });
    btn('Refresh', function () { pre.textContent = _aeDbgText(); pre.scrollTop = pre.scrollHeight; });
    btn('Clear', function () { _aeDbgLog.length = 0; _aeDbgLast = ''; pre.textContent = _aeDbgText(); });
    btn('Close', close);
    sheet.appendChild(bar); sheet.appendChild(pre);
    document.body.appendChild(sheet);
    pre.scrollTop = pre.scrollHeight;
  }
  pill.onclick = open;
  document.body.appendChild(pill);
}
