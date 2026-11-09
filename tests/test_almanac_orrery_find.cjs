// Find it in the sky, from the solar system (zimi/static/almanac-orrery.js, almanac-look.js):
// the Sun's and the visible planets' tips carry a small magnifier that opens Look aimed at them;
// the Earth, where we stand, and what the eye cannot see have none.
//
// Run: node tests/test_almanac_orrery_find.cjs   (exit 0 = pass)

const { makeSky, read, check, done } = require('./sky_harness.cjs');
const { S, run } = makeSky();
const hit = (type, name) => JSON.stringify({ type, data: { name } });
const id = (type, name) => run('_orreryFindId(' + hit(type, name) + ')');

check(id('sun') === 'sun', 'the Sun is found by "sun"');
check(id('planet', 'Mars') === 'planet:Mars', 'Mars by "planet:Mars", the id Find leads to it by');
for (const p of ['Mercury', 'Venus', 'Jupiter', 'Saturn', 'Uranus', 'Neptune']) check(id('planet', p) === 'planet:' + p, p + ' can be found');
check(id('planet', 'Earth') === null, 'the Earth is where we stand: nothing to find');
check(id('planet', 'Pluto') === null, 'Pluto is beyond the eye');
check(id('voyager', 'Voyager 1') === null && id('belt', 'Asteroid belt') === null, 'a probe and a belt have none');

// Every id it offers is one Find knows (almanac-skyfind.js builds 'sun', 'moon', 'planet:<name>').
const find = read('almanac-skyfind.js');
check(/add\('sun', 'sun'/.test(find) && /'planet:' \+ nm/.test(find), 'and those are the ids Find builds');

// The button: there when Look can be opened, absent when it cannot (the Almanac as a ZIM in a reader that has no Look).
S.openAlmanacLook = undefined;
run('var openAlmanacLook');
check(run('_orreryFindHtml(' + hit('planet', 'Mars') + ')') === '', 'without Look there is no button');
run('openAlmanacLook = function () {}');
const html = run('_orreryFindHtml(' + hit('planet', 'Mars') + ')');
check(/data-orr-find="planet:Mars"/.test(html) && /orrery-tip-find/.test(html) && /aria-label="sky_find_btn/.test(html), 'with Look it is a round button named "Find in the sky"');
check(run('_orreryFindHtml(' + hit('planet', 'Earth') + ')') === '', 'and the Earth still has none');

// The tap and Look: the orrery asks for Look with a thing to find; Look opened for one leads to it at once.
const orr = read('almanac-orrery.js'), look = read('almanac-look.js');
check(/openAlmanacLook\(\{ find: find\.getAttribute\('data-orr-find'\) \}\)/.test(orr), 'the tap opens Look for the id on the button');
check(/if \(opts\.find && typeof openAlmanacFind === 'function'\) openAlmanacFind\('look', opts\.find\)/.test(look), 'and Look, opened for it, hands the id to Find');
check(/_tipHasAction\(\) \{ return !!tooltip\.querySelector\('\.alm-link, \.orrery-tip-btn, \.orrery-tip-find'\)/.test(orr), 'a tip with only the magnifier is still a tip with an action (it stays while the pointer travels to it)');

done();
