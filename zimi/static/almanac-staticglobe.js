// The Earth, lit as it is now, drawn once: what stands behind the plain line where the 3D view is set aside (capability.js,
// almanac-earth.js _aeCapAside). One render of the day map on a sphere, with the Sun's real direction, into a picture; then the
// GL context is lost and dropped. No loop, no three.js, no context held: a weak device is given the globe and nothing else.
//
// Loaded the first time the plain line shows. The picture is drawn again only when the page's clock has moved by more than
// ASG_REDRAW_MS since it was made (checked each time the view opens).

var ASG_REDRAW_MS = 600000;            // ten minutes: the terminator has moved a visible amount
var ASG_SIZE_PX = 512;                 // the picture's side; the page scales it
var ASG_RADIUS = 0.94;                 // the globe's share of the picture's half-width
var ASG_AMBIENT = 0.07;                // the night side, in the day map's light
var ASG_DEFAULT_PLACE = [20, 0];       // where it looks without a place chosen: lat, lon
var ASG_MAP_URL = _almAsset('/static/earth/earth-day-v1.webp');
var _asg = { ms: null, canvas: null, busy: false };

var ASG_VS = '#version 300 es\nin vec2 p;out vec2 q;void main(){q=p;gl_Position=vec4(p,0.,1.);}';
var ASG_FS = '#version 300 es\nprecision highp float;in vec2 q;out vec4 o;uniform sampler2D map;uniform vec3 right,up,view,sun;uniform float R,amb;' +
  'void main(){vec2 s=q/R;float r2=dot(s,s);if(r2>1.){o=vec4(0.);return;}' +
  'vec3 n=right*s.x+up*s.y+view*sqrt(1.-r2);float lon=atan(n.y,n.x),lat=asin(clamp(n.z,-1.,1.));' +
  'vec3 c=texture(map,vec2(lon/6.2831853+.5,.5-lat/3.1415927)).rgb;float l=max(dot(n,sun),0.);' +
  'float edge=smoothstep(1.,.985,sqrt(r2));o=vec4(c*(amb+(1.-amb)*smoothstep(0.,.35,l)*(.4+.6*l))*edge,edge);}';

// The viewer's direction in the Earth-fixed frame (the place chosen, else a default), and the Sun's in the same frame.
function _asgFrame(ms) {
  var sc = _aeSceneAt(ms);
  var obs = typeof _aeObserver === 'function' ? _aeObserver() : null;
  var lat = obs && typeof obs.lat === 'number' ? obs.lat : ASG_DEFAULT_PLACE[0];
  var lon = obs && typeof obs.lon === 'number' ? obs.lon : ASG_DEFAULT_PLACE[1];
  var view = _aeNorm(_aeGeodeticToFixed(lat, lon));
  var sun = _aeNorm(_aeRotZ(sc.sun, -sc.gast));   // the scene's frame turns by the sidereal angle; this undoes it
  var right = _aeNorm(_aeCross([0, 0, 1], view));
  if (_aeLen(right) < 1e-6) right = [1, 0, 0];
  return { view: view, sun: sun, right: right, up: _aeCross(view, right) };
}

// One draw on a throwaway GL canvas, copied into the picture; the context is then lost on purpose.
function _asgRender(img, fr, picture) {
  var gc = document.createElement('canvas');
  gc.width = gc.height = ASG_SIZE_PX;
  var gl = gc.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
  if (!gl) return false;
  var sh = function (type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  var pr = gl.createProgram();
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, ASG_VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, ASG_FS));
  gl.linkProgram(pr); gl.useProgram(pr);
  var buf = gl.createBuffer(), loc = gl.getAttribLocation(pr, 'p');
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  var tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  var u = function (n) { return gl.getUniformLocation(pr, n); };
  gl.uniform1i(u('map'), 0);
  gl.uniform3fv(u('right'), fr.right); gl.uniform3fv(u('up'), fr.up); gl.uniform3fv(u('view'), fr.view); gl.uniform3fv(u('sun'), fr.sun);
  gl.uniform1f(u('R'), ASG_RADIUS); gl.uniform1f(u('amb'), ASG_AMBIENT);
  gl.viewport(0, 0, ASG_SIZE_PX, ASG_SIZE_PX);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  picture.width = picture.height = ASG_SIZE_PX;
  picture.getContext('2d').drawImage(gc, 0, 0);
  var lose = gl.getExtension('WEBGL_lose_context');
  gl.deleteTexture(tex);
  if (lose) lose.loseContext();
  _asg.lost = lose ? gl.isContextLost() : null;   // for the test: nothing is left held
  return true;
}

// The picture behind the plain line (`host` is the view's element): made now, or kept while the clock is near the moment it shows.
function _asgDraw(host) {
  if (_asg.busy || !host) return;
  var ms = _aeDisplayMs();
  var pic = document.getElementById('ae-static-globe');
  if (pic && _asg.ms !== null && Math.abs(ms - _asg.ms) < ASG_REDRAW_MS) return;
  if (!pic) {
    pic = document.createElement('canvas');
    pic.id = 'ae-static-globe'; pic.className = 'ae-static-globe'; pic.setAttribute('role', 'img'); pic.setAttribute('aria-hidden', 'true');
    host.insertBefore(pic, host.firstChild);
  }
  _asg.busy = true;
  fetch(ASG_MAP_URL).then(function (r) { return r.blob(); }).then(createImageBitmap).then(function (img) {
    if (_asgRender(img, _asgFrame(ms), pic)) _asg.ms = ms;
    if (img.close) img.close();
  }).catch(function () {}).then(function () { _asg.busy = false; });
}
