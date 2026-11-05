/* ZimCity while you are away: the city lives on between visits. Our own code, GPL-3.0.

   A save carries the real time it was made. When the city opens again, the time since then becomes game time at the
   pace the player chose (Settings, While I'm away): Pause (none), Slow (a game month for each real hour, the default)
   or Normal (the middle speed, as if the game had been left running), never more than CAP_YEARS. That time runs with
   no picture, in chunks with a breath between them so the page stays alive, and can be stopped part way. Chance in it
   is seeded from the save and the length of the absence, so the same save away the same time becomes the same city. */

export var PACES = ['pause', 'slow', 'normal'];
export var DEFAULT_PACE = 'slow';
export var TICKS_PER_YEAR = 48, STEPS_PER_TICK = 16;
export var CAP_YEARS = 5;
var MS_PER_HOUR = 3600000;
var TICKS_PER_HOUR = { pause: 0, slow: TICKS_PER_YEAR / 12, normal: 20 / STEPS_PER_TICK * 3600 };   // normal: 20 steps a second
var CHUNK_STEPS = 12 * STEPS_PER_TICK;   // a quarter of a year, then a breath

// How many game ticks an absence of `ms` is worth at `pace`.
export function ticksFor(ms, pace) {
  if (!isFinite(ms)) return 0;   // a save with no time on it, or a broken one, adds nothing
  var r = TICKS_PER_HOUR[pace] || 0;
  return Math.max(0, Math.min(CAP_YEARS * TICKS_PER_YEAR, Math.floor(Math.max(0, ms) * r / MS_PER_HOUR)));
}

// A 32-bit seed from the city's own seed, the save's moment and the length of the absence.
export function seedFor(seed, savedAt, ticks) {
  var h = 2166136261 >>> 0, s = String(seed) + '|' + String(savedAt) + '|' + String(ticks);
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

// Run `ticks` of the city. o: { ticks, time() -> the city's tick, step() -> false when the city cannot go on (a budget
// waiting for the player), random: a seeded generator, progress(done, total), done(result) }. Math.random is the seeded
// generator only while a chunk runs. Returns { cancel() }; result: { ran, stalled, cancelled }.
export function run(o) {
  var start = o.time(), stop = false, finished = false;
  if (!(o.ticks > 0)) { setTimeout(function () { o.done({ ran: 0 }); }, 0); return { cancel: function () {} }; }
  function ran() { return o.time() - start; }
  function finish(r) { if (finished) return; finished = true; r.ran = ran(); o.done(r); }
  function chunk() {
    if (stop) { finish({ cancelled: true }); return; }
    var real = Math.random, stalled = false;
    Math.random = o.random;
    try {
      for (var i = 0; i < CHUNK_STEPS && ran() < o.ticks; i++) if (o.step() === false) { stalled = true; break; }
    } finally { Math.random = real; }
    if (o.progress) o.progress(ran(), o.ticks);
    if (stalled) { finish({ stalled: true }); return; }
    if (ran() >= o.ticks) { finish({}); return; }
    setTimeout(chunk, 0);
  }
  setTimeout(chunk, 0);
  return { cancel: function () { stop = true; } };
}
