/* ZimiGames: the pictures the picture games share, drawn here, 64 x 64, flat colours. Our own art, GPL-3.0.
   ZimiPictures.sets is { key: { label, pics: [[Name, svg inner], ...] } }; Memory plays with the first two, Odd One Out with all. */
(function (root) {
  'use strict';
  var SETS = {
    animals: { label: 'Animals', pics: [
      ['Cat', '<path d="M11 30 13 7l16 11zM53 30 51 7 35 18z" fill="#e8923a"/><circle cx="32" cy="37" r="21" fill="#f0a04b"/><circle cx="24" cy="33" r="3.2" fill="#222"/><circle cx="40" cy="33" r="3.2" fill="#222"/><path d="M29.5 39h5L32 42.5z" fill="#d9626f"/><path d="M12 38l12 2M12 45l12-3M52 38l-12 2M52 45l-12-3" stroke="#6b4a2a" stroke-width="1.6" fill="none" stroke-linecap="round"/>'],
      ['Dog', '<ellipse cx="13" cy="32" rx="7" ry="15" fill="#7a5230" transform="rotate(12 13 32)"/><ellipse cx="51" cy="32" rx="7" ry="15" fill="#7a5230" transform="rotate(-12 51 32)"/><ellipse cx="32" cy="35" rx="18" ry="20" fill="#d2a87a"/><ellipse cx="32" cy="43" rx="10" ry="8" fill="#f1dcc0"/><circle cx="24" cy="30" r="3" fill="#222"/><circle cx="40" cy="30" r="3" fill="#222"/><ellipse cx="32" cy="38" rx="4.5" ry="3.2" fill="#222"/><path d="M32 41v4M27 46q5 4 10 0" stroke="#222" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M29 47q3 8 6 0z" fill="#e5707e"/>'],
      ['Fish', '<path d="M44 32 60 18v28z" fill="#2f86b5"/><ellipse cx="28" cy="32" rx="22" ry="14" fill="#3fa7d6"/><path d="M24 20q6-8 14-4-4 6-6 8z" fill="#2f86b5"/><circle cx="16" cy="29" r="3.6" fill="#fff"/><circle cx="15.2" cy="29" r="1.8" fill="#222"/><path d="M26 22q4 10 0 20M34 23q4 9 0 18" stroke="#2f86b5" stroke-width="2" fill="none"/>'],
      ['Bird', '<path d="M10 44 2 52M14 48 8 58" stroke="#2f6fc0" stroke-width="4" stroke-linecap="round"/><ellipse cx="30" cy="38" rx="20" ry="16" fill="#4f8fe0"/><circle cx="43" cy="26" r="11" fill="#4f8fe0"/><path d="M52 24l10 4-10 5z" fill="#f2a516"/><circle cx="45" cy="24" r="2.6" fill="#fff"/><circle cx="45.6" cy="24" r="1.3" fill="#222"/><path d="M14 36q10-10 22 2-8 8-20 4z" fill="#2f6fc0"/><path d="M26 54v6M34 54v6" stroke="#f2a516" stroke-width="2.4" stroke-linecap="round"/>'],
      ['Frog', '<ellipse cx="32" cy="40" rx="25" ry="17" fill="#58b85f"/><circle cx="20" cy="24" r="10" fill="#58b85f"/><circle cx="44" cy="24" r="10" fill="#58b85f"/><circle cx="20" cy="24" r="6" fill="#fff"/><circle cx="44" cy="24" r="6" fill="#fff"/><circle cx="21" cy="25" r="3" fill="#222"/><circle cx="43" cy="25" r="3" fill="#222"/><path d="M18 44q14 12 28 0" stroke="#2b6b30" stroke-width="2.4" fill="none" stroke-linecap="round"/><circle cx="27" cy="38" r="1.2" fill="#2b6b30"/><circle cx="37" cy="38" r="1.2" fill="#2b6b30"/>'],
      ['Rabbit', '<ellipse cx="23" cy="17" rx="6.5" ry="16" fill="#ece8e2" stroke="#bbb4ab"/><ellipse cx="41" cy="17" rx="6.5" ry="16" fill="#ece8e2" stroke="#bbb4ab"/><ellipse cx="23" cy="18" rx="3" ry="11" fill="#f4b6c2"/><ellipse cx="41" cy="18" rx="3" ry="11" fill="#f4b6c2"/><circle cx="32" cy="42" r="17" fill="#ece8e2" stroke="#bbb4ab"/><circle cx="25" cy="40" r="2.8" fill="#222"/><circle cx="39" cy="40" r="2.8" fill="#222"/><path d="M29.5 46h5L32 49z" fill="#e5707e"/><path d="M32 49v3M28 53q4 2 4-1 0 3 4 1" stroke="#555" stroke-width="1.4" fill="none"/>'],
      ['Owl', '<path d="M14 18 20 8 26 16zM50 18 44 8 38 16z" fill="#7a5a3a"/><ellipse cx="32" cy="36" rx="21" ry="24" fill="#8b6b4a"/><ellipse cx="32" cy="44" rx="12" ry="14" fill="#d8bd96"/><circle cx="22" cy="28" r="9" fill="#fff"/><circle cx="42" cy="28" r="9" fill="#fff"/><circle cx="22" cy="28" r="4.2" fill="#222"/><circle cx="42" cy="28" r="4.2" fill="#222"/><path d="M28 33h8l-4 7z" fill="#f2a516"/><path d="M24 46q4 3 8 0M32 46q4 3 8 0M26 52q3 2 6 0M32 52q3 2 6 0" stroke="#a98962" stroke-width="1.6" fill="none"/>'],
      ['Turtle', '<path d="M8 41q0-25 26-25t26 25z" fill="#3d9a4a"/><path d="M34 16v25M20 22l8 19M48 22l-8 19" stroke="#2b6b30" stroke-width="2" fill="none"/><circle cx="56" cy="38" r="7" fill="#8fcf8a"/><circle cx="58" cy="36" r="1.6" fill="#222"/><rect x="14" y="41" width="9" height="10" rx="4" fill="#8fcf8a"/><rect x="40" y="41" width="9" height="10" rx="4" fill="#8fcf8a"/><path d="M8 41 2 46 9 45z" fill="#8fcf8a"/><path d="M6 41h54v4q-27 5-54 0z" fill="#2b6b30"/>'],
      ['Bee', '<ellipse cx="22" cy="20" rx="9" ry="13" fill="#bfe3f5" stroke="#7fb4d0" transform="rotate(-25 22 20)"/><ellipse cx="38" cy="18" rx="9" ry="13" fill="#bfe3f5" stroke="#7fb4d0" transform="rotate(25 38 18)"/><ellipse cx="32" cy="40" rx="20" ry="15" fill="#f4c22b"/><path d="M26 27q-4 13 0 26M34 26q-4 14 0 28M42 29q-4 11 0 22" stroke="#222" stroke-width="5" fill="none"/><circle cx="14" cy="38" r="2.4" fill="#222"/><path d="M12 31 8 26M17 29 16 23" stroke="#222" stroke-width="1.6" stroke-linecap="round"/><path d="M52 40l8 2-8 2z" fill="#222"/>'],
      ['Penguin', '<ellipse cx="32" cy="36" rx="19" ry="24" fill="#2b3340"/><ellipse cx="32" cy="41" rx="12" ry="17" fill="#f4f6f8"/><circle cx="25" cy="25" r="3.6" fill="#fff"/><circle cx="39" cy="25" r="3.6" fill="#fff"/><circle cx="26" cy="25.5" r="1.7" fill="#222"/><circle cx="38" cy="25.5" r="1.7" fill="#222"/><path d="M27 30h10l-5 6z" fill="#f2a516"/><path d="M14 42 6 54l10-4zM50 42l8 12-10-4z" fill="#2b3340"/><ellipse cx="25" cy="59" rx="7" ry="3" fill="#f2a516"/><ellipse cx="39" cy="59" rx="7" ry="3" fill="#f2a516"/>']
    ] },
    shapes: { label: 'Shapes', pics: [
      ['Circle', '<circle cx="32" cy="32" r="22" fill="#e8574a" stroke="#2b3340" stroke-width="2.5"/>'],
      ['Square', '<rect x="10" y="10" width="44" height="44" rx="4" fill="#3a63c9" stroke="#2b3340" stroke-width="2.5"/>'],
      ['Triangle', '<path d="M32 8 58 54H6z" fill="#f2c12e" stroke="#2b3340" stroke-width="2.5" stroke-linejoin="round"/>'],
      ['Star', '<path d="M32 6l7.4 16.2 17.7 2-13.2 12 3.7 17.5L32 44.6 16.4 53.7l3.7-17.5-13.2-12 17.7-2z" fill="#f2a516" stroke="#2b3340" stroke-width="2.5" stroke-linejoin="round"/>'],
      ['Heart', '<path d="M32 56C10 40 8 22 20 15c6-3 11 0 12 6 1-6 6-9 12-6 12 7 10 25-12 41z" fill="#e0457b" stroke="#2b3340" stroke-width="2.5" stroke-linejoin="round"/>'],
      ['Moon', '<path d="M40 8a24 24 0 1 0 0 48 19 19 0 1 1 0-48z" fill="#7a6bd6" stroke="#2b3340" stroke-width="2.5" stroke-linejoin="round"/>'],
      ['Diamond', '<path d="M32 6 54 32 32 58 10 32z" fill="#3fc1e8" stroke="#2b3340" stroke-width="2.5" stroke-linejoin="round"/>'],
      ['Hexagon', '<path d="M18 10h28l14 22-14 22H18L4 32z" fill="#58b85f" stroke="#2b3340" stroke-width="2.5" stroke-linejoin="round"/>'],
      ['Plus', '<path d="M24 8h16v16h16v16H40v16H24V40H8V24h16z" fill="#8a55c9" stroke="#2b3340" stroke-width="2.5" stroke-linejoin="round"/>'],
      ['Drop', '<path d="M32 6C44 22 52 32 52 42a20 20 0 0 1-40 0C12 32 20 22 32 6z" fill="#3a8fd6" stroke="#2b3340" stroke-width="2.5" stroke-linejoin="round"/>']
    ] }
  };
  // the tenth shape: a ring, so a set of ten pairs is always there
  SETS.shapes.pics.push(['Ring', '<circle cx="32" cy="32" r="20" fill="none" stroke="#d1473f" stroke-width="10"/><circle cx="32" cy="32" r="25" fill="none" stroke="#2b3340" stroke-width="2"/><circle cx="32" cy="32" r="15" fill="none" stroke="#2b3340" stroke-width="2"/>']);


  // ── sets for Odd One Out ─────────────────────────────────────────────────
  SETS.food = { label: 'Food', pics: [
    ['Apple', '<path d="M32 18C22 10 8 18 10 34c2 14 12 22 22 18 10 4 20-4 22-18 2-16-12-24-22-16z" fill="#d93a2f"/><path d="M32 18c0-6 2-10 7-12" stroke="#5b3a1a" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M36 12c5-5 12-3 12-3s-2 8-9 8z" fill="#58b85f"/>'],
    ['Banana', '<path d="M12 12C10 40 26 54 54 48" fill="none" stroke="#f2c12e" stroke-width="13" stroke-linecap="round"/><path d="M12 6l-1 6" stroke="#6b4a1e" stroke-width="4" stroke-linecap="round"/>'],
    ['Carrot', '<path d="M46 18C50 30 26 56 10 54 8 38 34 14 46 18z" fill="#f08a24"/><path d="M42 20l8-10M46 24l10-4M40 16l2-10" stroke="#3d9a4a" stroke-width="4" stroke-linecap="round"/>'],
    ['Pizza', '<path d="M32 58 8 14Q32 4 56 14z" fill="#f2c12e"/><path d="M8 14Q32 4 56 14" stroke="#c98a3c" stroke-width="7" fill="none" stroke-linecap="round"/><circle cx="26" cy="26" r="4.5" fill="#d93a2f"/><circle cx="38" cy="32" r="4.5" fill="#d93a2f"/><circle cx="32" cy="44" r="3.5" fill="#d93a2f"/>'],
    ['Cupcake', '<path d="M14 34h36l-5 22H19z" fill="#c98a3c"/><path d="M12 34c-2-12 8-18 12-16 2-8 14-8 16 0 6-2 14 4 12 16z" fill="#f4a6c0"/><circle cx="32" cy="12" r="4" fill="#d93a2f"/>'],
    ['Ice cream', '<path d="M20 30h24L32 60z" fill="#d9a05b"/><circle cx="32" cy="24" r="14" fill="#f4a6c0"/><circle cx="32" cy="13" r="9" fill="#f8e7b8"/>'],
    ['Egg', '<path d="M12 30C10 16 24 8 36 10c14 2 22 12 16 26-4 10-14 18-26 16C14 50 14 40 12 30z" fill="#fbfaf5" stroke="#d8d3c8" stroke-width="2"/><circle cx="32" cy="32" r="10" fill="#f2b81e"/>'],
    ['Cheese', '<path d="M6 44 58 24v22H6z" fill="#f2c12e"/><path d="M6 44 58 24 40 12 6 44z" fill="#f8dc6e"/><circle cx="24" cy="46" r="3.5" fill="#d9a21a"/><circle cx="42" cy="40" r="3" fill="#d9a21a"/>']
  ] };
  SETS.vehicles = { label: 'Vehicles', pics: [
    ['Car', '<path d="M6 40v-8l8-2 8-10h20l8 10 8 2v8z" fill="#d93a2f"/><path d="M22 22h9v8H16zM35 22h7l6 8H35z" fill="#bfe3f5"/><circle cx="18" cy="42" r="7" fill="#2b3340"/><circle cx="46" cy="42" r="7" fill="#2b3340"/><circle cx="18" cy="42" r="3" fill="#ccc"/><circle cx="46" cy="42" r="3" fill="#ccc"/>'],
    ['Bus', '<rect x="6" y="14" width="52" height="34" rx="6" fill="#f2c12e"/><rect x="11" y="19" width="12" height="11" fill="#bfe3f5"/><rect x="26" y="19" width="12" height="11" fill="#bfe3f5"/><rect x="41" y="19" width="12" height="11" fill="#bfe3f5"/><rect x="6" y="36" width="52" height="4" fill="#d9a21a"/><circle cx="18" cy="50" r="6" fill="#2b3340"/><circle cx="46" cy="50" r="6" fill="#2b3340"/>'],
    ['Bike', '<circle cx="14" cy="42" r="11" fill="none" stroke="#2b3340" stroke-width="4"/><circle cx="50" cy="42" r="11" fill="none" stroke="#2b3340" stroke-width="4"/><path d="M14 42 26 22h14l10 20M26 22l8 20H14M40 22l-2-8h8" fill="none" stroke="#d93a2f" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>'],
    ['Boat', '<path d="M6 40h52l-8 14H14z" fill="#3a63c9"/><path d="M32 6v32" stroke="#6b4a1e" stroke-width="3"/><path d="M35 8 54 36H35z" fill="#fbfaf5" stroke="#bbb4ab"/><path d="M29 14 14 36h15z" fill="#f4a6c0"/>'],
    ['Plane', '<path d="M34 4c4 0 6 3 6 8v14l20 12v6L40 36v12l8 6v4l-14-4-14 4v-4l8-6V36L4 44v-6l20-12V12c0-5 4-8 10-8z" fill="#9aa5b5"/>'],
    ['Rocket', '<path d="M32 4c10 8 14 20 12 34H20C18 24 22 12 32 4z" fill="#eceff4" stroke="#b9c2cf" stroke-width="1.5"/><circle cx="32" cy="24" r="6" fill="#3fc1e8"/><path d="M20 30 10 46l10-4zM44 30l10 16-10-4z" fill="#d93a2f"/><path d="M26 42h12l-6 16z" fill="#f2a516"/>'],
    ['Train', '<rect x="12" y="8" width="40" height="40" rx="8" fill="#3a63c9"/><rect x="18" y="14" width="28" height="14" rx="3" fill="#bfe3f5"/><circle cx="22" cy="38" r="3.5" fill="#f2c12e"/><circle cx="42" cy="38" r="3.5" fill="#f2c12e"/><path d="M18 52 12 60M46 52l6 8" stroke="#2b3340" stroke-width="4" stroke-linecap="round"/>'],
    ['Helicopter', '<path d="M8 12h48M32 12v8" stroke="#2b3340" stroke-width="4" stroke-linecap="round"/><ellipse cx="30" cy="34" rx="18" ry="13" fill="#d93a2f"/><path d="M46 32 60 28v8z" fill="#d93a2f"/><path d="M20 28h14v10H20z" fill="#bfe3f5"/><path d="M14 52h32M22 47v5M38 47v5" stroke="#2b3340" stroke-width="3" stroke-linecap="round"/>']
  ] };
  SETS.nature = { label: 'Nature', pics: [
    ['Sun', '<circle cx="32" cy="32" r="13" fill="#f2b81e"/><path d="M32 4v9M32 51v9M4 32h9M51 32h9M12 12l6 6M46 46l6 6M52 12l-6 6M18 46l-6 6" stroke="#f2b81e" stroke-width="4" stroke-linecap="round"/>'],
    ['Cloud', '<path d="M18 46a12 12 0 0 1 0-24 14 14 0 0 1 26-4 12 12 0 0 1 4 28z" fill="#dfe8f2" stroke="#9db0c6" stroke-width="2"/>'],
    ['Tree', '<rect x="28" y="38" width="8" height="20" fill="#7a5230"/><circle cx="32" cy="26" r="18" fill="#3d9a4a"/><circle cx="22" cy="32" r="10" fill="#4cae5a"/><circle cx="42" cy="32" r="10" fill="#4cae5a"/>'],
    ['Flower', '<path d="M32 36v24" stroke="#3d9a4a" stroke-width="4"/><g fill="#f08ac0"><circle cx="32" cy="13" r="9"/><circle cx="44.4" cy="22" r="9"/><circle cx="39.6" cy="36.7" r="9"/><circle cx="24.4" cy="36.7" r="9"/><circle cx="19.6" cy="22" r="9"/></g><circle cx="32" cy="26" r="7" fill="#f2c12e"/>'],
    ['Mushroom', '<path d="M6 34C6 14 20 6 32 6s26 8 26 28z" fill="#d93a2f"/><rect x="24" y="34" width="16" height="22" rx="5" fill="#f0e6d0"/><circle cx="20" cy="22" r="4" fill="#fff"/><circle cx="36" cy="16" r="4" fill="#fff"/><circle cx="46" cy="26" r="3.5" fill="#fff"/>'],
    ['Mountain', '<path d="M2 56 24 20l12 18 8-10 18 28z" fill="#7a8794"/><path d="M24 20l-7 12 5-3 4 5 4-6z" fill="#fff"/>'],
    ['Leaf', '<path d="M10 54C8 24 28 8 56 8c0 28-14 46-40 46z" fill="#58b85f"/><path d="M12 52 40 24" stroke="#2b6b30" stroke-width="3" stroke-linecap="round"/>'],
    ['Snowflake', '<g stroke="#5bb6e0" stroke-width="4" stroke-linecap="round" fill="none"><path d="M32 6v52M9.5 19l45 26M9.5 45l45-26"/><path d="M26 10l6 6 6-6M26 54l6-6 6 6"/></g>']
  ] };
  SETS.things = { label: 'Things', pics: [
    ['Cup', '<path d="M12 18h34v20a14 14 0 0 1-14 14h-6A14 14 0 0 1 12 38z" fill="#fbfaf5" stroke="#9aa5b5" stroke-width="2.5"/><path d="M46 24h4a7 7 0 0 1 0 14h-4" fill="none" stroke="#9aa5b5" stroke-width="3"/><path d="M20 8c-2 3 2 5 0 8M30 8c-2 3 2 5 0 8" stroke="#b9c2cf" stroke-width="2.5" fill="none" stroke-linecap="round"/>'],
    ['Key', '<circle cx="20" cy="32" r="12" fill="none" stroke="#d9a21a" stroke-width="6"/><path d="M32 32h26M48 32v10M56 32v8" stroke="#d9a21a" stroke-width="6" stroke-linecap="round" fill="none"/>'],
    ['Book', '<path d="M6 12h24v40H6zM34 12h24v40H34z" fill="#3a63c9"/><path d="M11 20h14M11 28h14M39 20h14M39 28h14" stroke="#fff" stroke-width="2.5"/>'],
    ['Lamp', '<path d="M20 8h24l8 26H12z" fill="#f2c12e"/><path d="M32 34v18M20 56h24" stroke="#2b3340" stroke-width="5" stroke-linecap="round"/>'],
    ['Clock', '<circle cx="32" cy="32" r="24" fill="#fbfaf5" stroke="#2b3340" stroke-width="4"/><path d="M32 18v15l10 6" stroke="#2b3340" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'],
    ['Umbrella', '<path d="M6 32C6 16 18 6 32 6s26 10 26 26z" fill="#d93a2f"/><path d="M32 32v20a6 6 0 0 1-12 0" fill="none" stroke="#2b3340" stroke-width="4" stroke-linecap="round"/>'],
    ['Scissors', '<path d="M24 8 44 40M40 8 20 40" stroke="#9aa5b5" stroke-width="5" stroke-linecap="round"/><circle cx="18" cy="48" r="8" fill="none" stroke="#d93a2f" stroke-width="5"/><circle cx="46" cy="48" r="8" fill="none" stroke="#d93a2f" stroke-width="5"/>'],
    ['House', '<path d="M6 30 32 8l26 22z" fill="#d93a2f"/><rect x="12" y="30" width="40" height="26" fill="#f0e6d0"/><rect x="27" y="38" width="10" height="18" fill="#7a5230"/><rect x="16" y="35" width="8" height="8" fill="#bfe3f5"/>']
  ] };
  SETS.fun = { label: 'Fun', pics: [
    ['Ball', '<circle cx="32" cy="32" r="24" fill="#fbfaf5" stroke="#2b3340" stroke-width="3"/><path d="M32 20l10 7-4 12H26l-4-12z" fill="#2b3340"/><path d="M32 8v12M10 26l12 1M54 26 42 27M18 50l8-11M46 50l-8-11" stroke="#2b3340" stroke-width="2.5" fill="none"/>'],
    ['Kite', '<path d="M32 4 50 26 32 44 14 26z" fill="#e8574a"/><path d="M32 4v40M14 26h36" stroke="#fff" stroke-width="2"/><path d="M32 44c-6 6 4 8-2 14" fill="none" stroke="#2b3340" stroke-width="2.5"/>'],
    ['Balloon', '<ellipse cx="32" cy="26" rx="17" ry="21" fill="#e0457b"/><path d="M29 47h6l-3 5z" fill="#e0457b"/><path d="M32 52c-5 4 5 6 0 10" fill="none" stroke="#2b3340" stroke-width="2.5"/><ellipse cx="25" cy="18" rx="4" ry="7" fill="rgba(255,255,255,.4)"/>'],
    ['Guitar', '<path d="M36 28 56 8" stroke="#7a5230" stroke-width="5" stroke-linecap="round"/><path d="M30 24c8-2 14 4 12 12-2 4 2 8-2 14-6 10-26 8-28-6-1-9 8-10 10-16 2-4 4-6 8-4z" fill="#d98a3a"/><circle cx="26" cy="40" r="5" fill="#2b3340"/>'],
    ['Drum', '<path d="M8 20v24c0 5 11 9 24 9s24-4 24-9V20z" fill="#d93a2f"/><ellipse cx="32" cy="20" rx="24" ry="9" fill="#e8d9b8" stroke="#9a8556" stroke-width="2.5"/><path d="M18 6l12 14M46 6 34 20" stroke="#7a5230" stroke-width="4" stroke-linecap="round"/>'],
    ['Trophy', '<path d="M18 8h28v18a14 14 0 0 1-28 0z" fill="#f2b81e"/><path d="M18 14h-8c0 10 4 14 10 14M46 14h8c0 10-4 14-10 14" fill="none" stroke="#f2b81e" stroke-width="4"/><rect x="28" y="38" width="8" height="10" fill="#f2b81e"/><rect x="20" y="48" width="24" height="8" rx="2" fill="#b8860b"/>'],
    ['Dice', '<rect x="10" y="10" width="44" height="44" rx="9" fill="#fbfaf5" stroke="#2b3340" stroke-width="3"/><g fill="#2b3340"><circle cx="22" cy="22" r="4"/><circle cx="42" cy="22" r="4"/><circle cx="32" cy="32" r="4"/><circle cx="22" cy="42" r="4"/><circle cx="42" cy="42" r="4"/></g>'],
    ['Bell', '<path d="M14 44c4-4 4-10 4-16a14 14 0 0 1 28 0c0 6 0 12 4 16z" fill="#f2b81e"/><circle cx="32" cy="48" r="5" fill="#b8860b"/><circle cx="32" cy="10" r="3.5" fill="#f2b81e"/>']
  ] };

  root.ZimiPictures = { sets: SETS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
