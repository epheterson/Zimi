/* Flags: the built-in flags, for a page with no library (or a library with no pictures) behind it. Plain data, no logic.
   Each flag is a name and the shapes to draw on a 90 by 60 field, in order (flags.js turns them into one SVG):
     ['h', c, c, ...] or ['v', ...]  equal bands, top to bottom or left to right; a band may be [color, weight]
     ['rect', c, x, y, w, h]   ['disc', c, cx, cy, r]   ['ring', c, cx, cy, r, width]   ['star', c, cx, cy, r]
     ['poly', c, 'x,y x,y ...']   ['line', c, width, 'x,y x,y ...']  (a closed outline)
     ['cross', c, x, y, thickness]  (a bar down at x and a bar across at y)
     ['stars', c, x, y, cols, rows]  (a grid of small stars from x, y, 5.6 apart)
   The colors are the flags' own, so they are the one place hex belongs. */
(function (root) {
  var WHITE = '#fff';
  root.FLAGS_MINI = [
    ['France', [['v', '#0055a4', WHITE, '#ef4135']]],
    ['Italy', [['v', '#009246', WHITE, '#ce2b37']]],
    ['Ireland', [['v', '#169b62', WHITE, '#ff883e']]],
    ['Belgium', [['v', '#000', '#fdda24', '#ef3340']]],
    ['Germany', [['h', '#000', '#dd0000', '#ffce00']]],
    ['The Netherlands', [['h', '#ae1c28', WHITE, '#21468b']]],
    ['Russia', [['h', WHITE, '#0039a6', '#d52b1e']]],
    ['Austria', [['h', '#ed2939', WHITE, '#ed2939']]],
    ['Hungary', [['h', '#cd2a3e', WHITE, '#436f4d']]],
    ['Bulgaria', [['h', WHITE, '#00966e', '#d62612']]],
    ['Estonia', [['h', '#0072ce', '#000', WHITE]]],
    ['Lithuania', [['h', '#fdb913', '#006a44', '#c1272d']]],
    ['Luxembourg', [['h', '#ed2939', WHITE, '#00a1de']]],
    ['Romania', [['v', '#002b7f', '#fcd116', '#ce1126']]],
    ['Poland', [['h', WHITE, '#dc143c']]],
    ['Ukraine', [['h', '#0057b7', '#ffd700']]],
    ['Indonesia', [['h', '#ce1126', WHITE]]],
    ['Colombia', [['h', ['#fcd116', 2], '#003893', '#ce1126']]],
    ['Armenia', [['h', '#d90012', '#0033a0', '#f2a800']]],
    ['Spain', [['h', '#aa151b', ['#f1bf00', 2], '#aa151b']]],
    ['Nigeria', [['v', '#008751', WHITE, '#008751']]],
    ['Mali', [['v', '#14b53a', '#fcd116', '#ce1126']]],
    ['Guinea', [['v', '#ce1126', '#fcd116', '#009460']]],
    ['Ivory Coast', [['v', '#f77f00', WHITE, '#009e60']]],
    ['Sierra Leone', [['h', '#1eb53a', WHITE, '#0072c6']]],
    ['Gabon', [['h', '#009e60', '#fcd116', '#3a75c4']]],
    ['Yemen', [['h', '#ce1126', WHITE, '#000']]],
    ['Peru', [['v', '#d91023', WHITE, '#d91023']]],
    ['Bolivia', [['h', '#d52b1e', '#f9e300', '#007934']]],
    ['Senegal', [['v', '#00853f', '#fdef42', '#e31b23'], ['star', '#00853f', 45, 31, 10]]],
    ['Ghana', [['h', '#ce1126', '#fcd116', '#006f3f'], ['star', '#000', 45, 31, 10]]],
    ['Ethiopia', [['h', '#078930', '#fcdd09', '#da121a'], ['disc', '#0f47af', 45, 30, 12], ['star', '#fcdd09', 45, 31, 8]]],
    ['Japan', [['rect', WHITE, 0, 0, 90, 60], ['disc', '#bc002d', 45, 30, 18]]],
    ['Bangladesh', [['rect', '#006a4e', 0, 0, 90, 60], ['disc', '#f42a41', 40, 30, 18]]],
    ['Sweden', [['rect', '#006aa7', 0, 0, 90, 60], ['cross', '#fecc00', 28, 30, 8]]],
    ['Finland', [['rect', WHITE, 0, 0, 90, 60], ['cross', '#003580', 28, 30, 10]]],
    ['Denmark', [['rect', '#c8102e', 0, 0, 90, 60], ['cross', WHITE, 28, 30, 8]]],
    ['Norway', [['rect', '#ba0c2f', 0, 0, 90, 60], ['cross', WHITE, 28, 30, 12], ['cross', '#00205b', 28, 30, 6]]],
    ['Iceland', [['rect', '#02529c', 0, 0, 90, 60], ['cross', WHITE, 28, 30, 12], ['cross', '#dc1e35', 28, 30, 6]]],
    ['Switzerland', [['rect', '#da291c', 0, 0, 90, 60], ['rect', WHITE, 40, 12, 10, 36], ['rect', WHITE, 27, 25, 36, 10]]],
    ['Turkey', [['rect', '#e30a17', 0, 0, 90, 60], ['disc', WHITE, 34, 30, 15], ['disc', '#e30a17', 39, 30, 12], ['star', WHITE, 53, 30, 7]]],
    ['Vietnam', [['rect', '#da251d', 0, 0, 90, 60], ['star', '#ff0', 45, 31, 17]]],
    ['China', [['rect', '#de2910', 0, 0, 90, 60], ['star', '#ffde00', 15, 15, 9], ['star', '#ffde00', 30, 6, 3], ['star', '#ffde00', 36, 12, 3], ['star', '#ffde00', 36, 20, 3], ['star', '#ffde00', 30, 26, 3]]],
    ['Canada', [['v', '#d80621', ['#fff', 2], '#d80621'], ['poly', '#d80621', '45,12 49,22 55,19 53,31 58,30 50,38 51,42 46,41 46,49 44,49 44,41 39,42 40,38 32,30 37,31 35,19 41,22']]],
    ['Brazil', [['rect', '#009b3a', 0, 0, 90, 60], ['poly', '#fedf00', '45,6 82,30 45,54 8,30'], ['disc', '#002776', 45, 30, 13]]],
    ['Argentina', [['h', '#74acdf', WHITE, '#74acdf'], ['disc', '#f6b40e', 45, 30, 5]]],
    ['Chile', [['h', WHITE, '#d52b1e'], ['rect', '#0039a6', 0, 0, 30, 30], ['star', WHITE, 15, 16, 9]]],
    ['India', [['h', '#ff9933', WHITE, '#138808'], ['ring', '#000080', 45, 30, 8, 1.2]]],
    ['Czechia', [['h', WHITE, '#d7141a'], ['poly', '#11457e', '0,0 45,30 0,60']]],
    ['The Bahamas', [['h', '#00abc9', '#fad900', '#00abc9'], ['poly', '#000', '0,0 38,30 0,60']]],
    ['Jamaica', [['rect', '#fed100', 0, 0, 90, 60], ['poly', '#009b3a', '5,0 85,0 45,25'], ['poly', '#009b3a', '5,60 85,60 45,35'], ['poly', '#000', '0,5 25,30 0,55'], ['poly', '#000', '90,5 65,30 90,55']]],
    ['The United States', [['h', '#b22234', WHITE, '#b22234', WHITE, '#b22234', WHITE, '#b22234', WHITE, '#b22234', WHITE, '#b22234', WHITE, '#b22234'],
      ['rect', '#3c3b6e', 0, 0, 36, 32], ['stars', WHITE, 4, 4, 5, 6]]],
    ['Israel', [['rect', WHITE, 0, 0, 90, 60], ['rect', '#0038b8', 0, 5, 90, 6], ['rect', '#0038b8', 0, 49, 90, 6], ['line', '#0038b8', 1.6, '45,18 56,37 34,37'], ['line', '#0038b8', 1.6, '45,42 56,23 34,23']]]
  ];
})(this);
