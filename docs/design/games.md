# ZimiGames design rules

Every game is the same well-made Zimi product: the same place for the same control, the same word for the same action, the same look, and the mark where a maker's mark belongs. The ZIM must still run alone in Kiwix, so everything here lives in the ZIM's own files (games.css, shell.js, cards.js, board.css, the shelf). The icon and mark recipe is in `icons.md`.

Each rule names the shared file that enforces it. A game that needs an exception says why in a comment where it happens.

## Colour

Games take Zimi's tokens (`zimi/static/app.css`) under their existing names in games.css, so no game's CSS has to change to follow them:

- Light: ground `#f2efe8`, surface `#fbfaf6`, surface2 `#ffffff`, line `#e4dfd4`, ink `#26241f`, ink2 `#6a675e`.
- Dark: ground `#0a0a0b`, surface `#141416`, surface2 `#1c1c20`, line `#27272b`, ink `#e8e8ed`, ink2 `#8a8a94`.
- There are no blue-tinted greys anywhere.

Amber is the only accent: the primary action, the selection, focus and the current turn.

- Light uses `#9d4a08` for text and outlines. A filled button uses a fill that gives white text 4.5:1 (`#b45309` or darker).
- Dark is `#f59e0b` with near-black text.
- `--accent-glow` (8 percent) and `--accent-line` (25 percent) give the hover and selected states, as in Zimi.
- Each screen has at most one filled amber button.

A game's CSS uses hex literals only for materials: felt, wood, card faces, suits, pieces and tiles. It never uses them for UI neutrals.

Felt is the cards' table. It is one hue from `--felt`: deeper and less saturated than before, with a soft vignette. In dark it is darker, never brighter. The trays, pills and chips on felt are translucent black over it, never another green.

Wood is a board-frame material. There is one pair, `--wood` and `--wood-dark`, shared by every board, cribbage included. In dark a board is a lit object at no more than about 45 percent lightness.

Saturated boards (Ludo, Reversi, Hex, Four in a Row, Ur, Mahjong) pull non-material fills about 20 percent toward neutral in light and 30 percent in dark. Reversi's and Mahjong's greens become the felt green.

Suit red is `#b3261e`. A card you cannot play is not greyed; the cards you can play are lifted.

## Type

The face is Zimi's: `-apple-system, Inter, "Segoe UI", Roboto, sans-serif`. Mono is used for numbers only (clocks, scores), never for sentences.

The scale has six steps:
- 11: caption, decoration only
- 13: secondary text, stats
- 15: body, controls, the status line
- 17: bar title, weight 650
- 20: sheet title
- 26: shelf brand
- 32: display numerals (scores, 2048 tiles, the HUD's big value), tabular

Words a player needs mid-game are at least 13px, in ink or ink2. Ink3 is for decoration and disabled labels only.

## Space, shape, depth

- Spacing is a 4px grid: 4, 8, 12, 16, 24. The page gutter is 16.
- Radius takes three values: 6 for chips and cells, 10 for buttons, inputs and cards (Zimi's `--radius`), and 14 for sheets, tables and panels. Pill (999) is for toggles and filters. Pieces and discs keep their own shapes.
- Depth has two levels. Flat is a 1px line with no shadow. Raised is for sheets only, with one shadow (Zimi's popup shadow).
- Bevels are a material, only on tiles and pieces, never on UI controls.

## The bar (shell.js, games.css)

Left to right:
1. Back: the chevron and the pebble mark. One 44px target, labelled "Back".
2. The game's title.
3. One optional live stat (clock, score or chips) as a single value: 13px tabular sans in ink2.
4. Undo, if the game can undo.
5. Menu, last.

Nothing else goes in the bar:
- Arcade games are the one exception: Pause takes Undo's slot (one tap mid-action). Opening Menu also pauses, and so does leaving the page (blur).
- Flag, Rules, Hint and mode toggles go to the action row or Menu.
- Card games have no second line under the title. One fact at most, written in words ("Hand 1 of 6"), goes in the status line.

Inside Zimi, Zimi's top bar takes the bar's place (one header).

A long title ends in an ellipsis before it pushes the controls; the controls never wrap.

The theme comes from Zimi's `data-theme` first, with `prefers-color-scheme` as the Kiwix fallback.

On wide screens the bar and the content share one centred column (max 960px; boards up to 720px), so Back and Menu never sit a whole desktop apart.

Touch targets are 44px minimum on touch, and the bar is 56px tall. On a fine pointer, 36px is allowed.

## The Menu (shell.js)

The rows, in order:
1. New game
2. Settings
3. How to play
4. Stats
5. About this game

"About X" leaves the page footer and becomes this row. Credits and licences live in About.

New game is one tap. A confirm appears only when a game is in progress: "Start a new game?", then "Your current game will be lost.", with Cancel and New game. If the game has options, they show in that same pane, with Start last.

Back and close are 44px. The dialog is labelled with the game's title alone.

## Sheets (shell.js)

All sheets share one anatomy:
- The title (20px). A sheet over a bar carries no mark; a sheet on a page with no bar carries the 20px pebble beside it, aligned on the cap height (see the mark table).
- One line of text.
- On open, focus goes to the sheet itself (trapped, Esc closes), never into a field or button.
- Option rows: a 13px sentence-case label on the left, a 44px segmented control on the right.
- Actions last, with the primary last. On phone widths the primary is full width.
- The scrim is ground at 55 percent in light and black at 60 percent in dark. The sheet is surface2 with a visible line in dark.

A start sheet appears only when the choice changes the game (players, seats, mode), never just to ask for a difficulty. The board behind it is not drawn until Start. There are defaults for everything. The button says Start.

Games with no real choice open ready to play on the live board, with one short line: "Tap to start" or "Press any key".

The end sheet is shared by every game, from shell.js:
- The title is the result: "You win", "You lose" or "Draw". "Name wins" is for games with several people. "Game over" is only for solo score games with no win state.
- At most two stat chips.
- Close as a quiet ghost on the left (a third), New game in amber on the right (two thirds): one 44px row, the same anatomy as every sheet's actions.
- It appears about 600ms after the last animation. Keys are ignored for its first 600ms, so a player still pressing Space or Enter cannot dismiss or restart it unseen.
- A loss has the same size and tone as a win.
- Card games keep the cascade before it.

## The table and the board (cards.css, board.css, games.css)

On a phone, from top to bottom:
1. Status line
2. Board or table
3. Action row
4. A quiet record line

Space falls below the content, never above it. Boards span the width inside the gutter, and nothing is centred vertically on phone widths.

Card tables: opponents at the top, the trick or pile at about 40 percent of the height, then the status line and the tray directly above your hand, which sits at the bottom.

Solitaire, Spider, Pyramid and TriPeaks scale their columns to the width and let the fan grow to fill the height. Stock and waste are at least 44px.

Your hand at 390px:
- No card strip is narrower than 30px.
- Above nine cards the hand goes to two rows.
- The first tap lifts the card 14px with an amber outline. The second tap plays it.

Bare grids (2048, Sudoku, Minesweeper, Sokoban, the puzzles) sit in one frame: radius 14, a 1px line, a surface2 backing and 12px padding. A wood board is its own frame and gets no card around it. Felt tables stay full bleed under the bar.

Opponents' hands of more than five cards collapse to one back with a count chip ("13"). The Z stays on every back, and the space goes to the trick and your hand.

## Status, chips and feedback (shell.js, cards.js)

The status line is one slot: one sentence under 60 characters at 15px, in ink, saying whose turn it is and what to do. It is `aria-live="polite"`. On felt it sits in the translucent pill.

There is one chip for players: 13px, 28px tall, pill-shaped, with a dot, the name and a number. The current player gets an amber outline and glow, with the name in ink, never white on amber. Dealer is a "D" badge. Trump is a suit chip.

Zimi is "thinking" within 150ms and moves in 400 to 700ms. While it thinks, the opponent's chip pulses, the status line says "Zimi is thinking", and the layout does not jump.

An illegal move gets a 120ms shake (an outline flash under reduced motion). The status line gives the reason for 2 seconds, then goes back to whose turn it is.

Selection and legal moves use two shared tokens in the board kit and cards.js: `--select` (two rings, a dark 1px inner stroke and a 3px amber outer ring, so it reads on wood, felt and amber-toned materials alike) and `--legal` (an amber dot at 30 percent). The last move is an accent-glow fill.

## Action rows and trays

Undo is never in the action row; it lives in the bar.

Action rows hold moves only: Hint, Pass, Flip, Roll, Deal, Draw, Pencil, Erase, Flag, Shuffle. They sit in one row directly under the board, with Hint first.
- Buttons are ghost style: a 1px line, 44px tall, radius 10.
- One amber filled button when there is a clear next step.
- At most four are visible; the rest go to Menu.

A tray on felt has the same anatomy on translucent black, with the primary leftmost and at most three per row.

Disabled controls keep their place. They show ink3 text with the line border, not a faded whole button (ink3 is allowed here because the state is also in `aria-disabled`), carry `aria-disabled`, and give the reason when one is known. A control that can never apply to this game is absent.

Records ("Medium: 3 won, 1 lost") are 13px sans in ink2, on one line, hidden until the first game. The full record is in Stats, as a labelled list.

## Arcade

The HUD is one strip directly above the playfield: at most four values, each a 13px label over a 32px tabular value. It replaces the bar's stat slot. Lander's five readouts become four (fuel, speed down, speed across, lives; the score is on the end sheet and in Stats).

Games steered with a pad use the one shared touch pad: in portrait on a phone the pad fills the whole screen under the playfield, in rows the full width of the screen: the arrows first (two or three keys splitting the width, or a full-width d-pad block for four ways), then the actions as one row split evenly, every key at least 56px tall, the status line between the field and the pad and never under the keys, the field never shrunk for it beyond the pad's least height. It is written once (Play.pad, play.css) and ZimiKart's pad follows the same rule in kart.css. Labels: Left, Right, Up, Down, plus each game's verb (Fire, Jump, Thrust). Gesture games (Pinball, Road Rush, Snake, Kart) draw no pad. They say their gesture once in the ready line ("Swipe to turn").

In landscape on a phone (and in split screen) the pad is a d-pad on the left and the actions on the right, all 56px: the two halves move to the two sides of the playfield, and the bar stays.

Key hints sit in How to play, never in footnotes under the game.

## Focus, motion, colour-blindness

- Focus is a 2px amber ring at a 2px offset on everything, including cells and cards. Canvas games draw it through the shared helper.
- Tab order: bar, then board, then tray. A board has one tab stop, with arrow keys inside. A sheet traps focus and returns it, and Esc closes it.
- Motion: 120ms for presses, 200ms for state changes, 350ms for deals and wins, all ease-out. `prefers-reduced-motion` turns off sliding, spinning, shaking and cascades everywhere (one block in games.css, `reducedMotion()` in shell.js). Settings > Animation can override it.
- Colour never carries meaning alone. Suit, team, hit and miss each get a glyph, shape or label as well.

## The mark

The pebble is the mark. The games tile is the product's icon and appears where the product is named or installed. The bare Z is a material and never stands alone as a logo.

| Place | Element | Size | Clear space | Light and dark |
|---|---|---|---|---|
| ZIM icon, Zimi Home tile, Zimi's header | Games tile | Native 48, 96, 256 | Half the pebble's width | As drawn in both (felt is a material) |
| Shelf header | Games tile and "ZimiGames" | 40px tile, 12px gap | 16px page gutter | Tile as drawn; text in ink |
| Game bar | Chevron and pebble, one 44px target | Pebble 24px | 8px around it | Pebble as drawn; in dark a 1px ring (ink at 28 percent) |
| Inside Zimi, the game's page (its bar is hidden behind Zimi's header) | Pebble on the ground of the game: the felt of a card table, the page's ground elsewhere; under everything, never over a board, card or control | 20px, bottom-right | 12px from the edges | As drawn; in dark a 1px ring on the page's ground (the felt needs none) |
| Sheet over a bar | None | n/a | n/a | n/a |
| Sheet on a page with no bar (the shelf's) | Pebble | 20px, 8px to the title | 8px | As the bar, ring in dark |
| End screens, empty and loading states | None | n/a | n/a | n/a |
| Card back (Zimi) and Ace of Spades | Bare Z, same gradient and weight | Back: about 22 percent of the card width; Ace: inside the belly | Back: 25 percent margin; Ace: even margin | Same in both (the card is a material) |
| Tab icon (favicon.svg) | Pebble on the felt, no die, card or stick | 16 and 32, full bleed | Full bleed | Same in both |
| Kiwix and other viewers | Games tile | What the viewer imposes | n/a | n/a |

Conflicts between the brand and product reviews, and how they were settled:
- Bar: both said the pebble, not the tile (the tile loses the die and stick at 24px). The pebble stays beside the chevron in one 44px target, as built; product's wish to split Back from the stamp is dropped because the pebble is how a player gets home to the shelf, as in Zimi.
- Sheets: brand kept the pebble on full-screen sheets, product dropped it. Every sheet in a game opens over the bar, so it is dropped there; only a barless page keeps it.
- End screens: product wanted a 28px seal, brand none. None: the bar is on screen and a result is not a signature.
- About: brand wanted a 64px tile, product a 40px pebble. Neither: the About page has the bar, and a third stamp is wallpaper.
- Tab icon: brand said the tile, product the pebble. The pebble on the felt: the product colour and a mark that survives 16px.
- Sizes (bar 24 or 22, shelf tile 40 or 32): the measured 24px pebble and the 40px tile on the 4px grid.

Never recoloured, never a watermark, never inside a board. Below 20px the Z has no gradient to lose: use favicon.svg, not the full tile.

## The opponent and the end of a game

The one computer opponent is Zimi: a proper name, the same in all ten languages (`ZimiText.ZIMI`, `board.zimi`, and `ZimiSeats` at a two-seat table). With two or more computers the seats keep names (`seats.cpu.N`, the compass points); a partner is never Zimi.

A win lands (Shell.endSheet): the game's own flourish, then a pebble stamp, a ring, a scatter and confetti in the mark's colours (red, amber, orange, ink, cream), about 1.8 s, then the sheet with a heavier title and counting figures. A loss settles in softly, nothing moves over the board. A draw is plain. A tap or key skips the beat and the sheet opens at once (the skipping tap cannot press a sheet button for 250 ms); a tap on the bar cancels it. Haptic where available. Reduced motion: no beat, the sheet at once. A closed end sheet is never a dead end: the result line and a large New game stay over the bottom of the finished board until a new game starts (`.gs-rest`). A sheet shown with `after: 0` (a finished game coming back) has no beat.

## Words

US English, to match Zimi: color, favorite, center, gray. "Draughts" survives only as that game's name. A lint test fails on the British spellings in visible text.

Sentence case everywhere. Typographic apostrophes. No exclamation marks, no emoji, no jokes in controls. The one exception is a win's title ("You win!", and the same mark in each language where it is natural), because a win is the moment the product is allowed to cheer.

One verb per action:
- New game: start fresh. This covers puzzles too, so never New puzzle, New word or New code.
- Next hand: continue a card match. Next round: dice and dominoes. Next level: levelled games.
- Restart: replay the same position or deal only (Sokoban, a FreeCell deal).
- Undo, Hint, Start, Close, Cancel.
- Next: progression to the next item of a set (Chess Puzzles, Opening Trainer, Go Problems), not a new game.
- Give up and Show solution, where a game has them.
- Back: a real page-back in navigation games (Wiki Race), never Undo.
- Retired: Play again, Try again, Start over, Another, Reset, Back one.

Seats:
- Two-player games: You and Zimi (the computer opponent is named Zimi everywhere it speaks: status lines, move lists, hints).
- Partnership games: compass seats (Bridge, Spades, Euchre, Belote, Canasta).
- Every other multi-seat game: You plus named computer players from one shared list.
- In prose it is "Zimi" where it moves or speaks; "the computer" only names the kind of player (a setting, a how-to-play line).

Status lines are short and never end in a period unless they are two sentences. Instructions are under eight words ("Draw or take the pile."). The long rule lives behind Hint or How to play.

A toggle's label names the thing, never its state ("Sound", with aria-pressed). Binary settings are On and Off. "Confirm new game" becomes "Ask before a new game". A setting that duplicates Settings moves into Settings.

Blurbs are one fragment of 60 characters or fewer, with no full stop and no player counts. Family labels are plain ("Chess and cousins" stays; riddles go). The library section is "Library" (Eric, 2026-10-26: "Library is fine"; he dislikes "From your library").

How to play has four parts: Goal, Your turn, The end, Tip. Each part is one or two sentences of 25 words or fewer, in the imperative. A game term (trick, trump, meld, komi, yaku, sow) is defined once in a shared glossary, and idioms get plain words.

Every visible and aria string goes through `T(key, vars)` (ZimiText in shell.js), keyed by id. English JSON ships in the ZIM. Plurals use `Intl.PluralRules`, numbers and times use `Intl`, and sentences have named slots, never concatenation. The language comes from the hash Zimi passes, else `navigator.language`, and sets `<html lang dir>`. The translations themselves are the next pass. This pass makes every string ready for them.

## Third-party pages (Simon Tatham's puzzles, puzzles/zimi-fit.js)

Each of the 41 pages is wrapped in the same bar and Menu, and 38 of them are first class on the shelf, in the Logic puzzles family (one wordless tile each, a blurb of 60 characters or fewer, Tatham's own name). Mines, Solo and Guess are the same games as our Minesweeper, Sudoku and Code Breaker: they have no tile, and Back on their pages goes to ours, which links to them from New game ("More versions") for what they add (no-guess boards and odd grids, killer and jigsaw, your own pegs and colours). Random, Game of the Day, favourites and the Wikipedia link point at ours.
- Bar: Back, the name, Undo and Redo as arrows (absent while disabled), Menu. In Zimi's own header only Undo fits, so Redo is a button in the Menu's first row there. Restart and Show solution are the Menu's first row; Show solution asks, and a solved-by-solver game is never a win.
- Menu > New game: Type (every preset, and Custom size, which opens the puzzle's own size form as a sheet), then an Advanced fold (game ID, random seed, save files) that is closed until opened.
- Menu > Settings: This puzzle carries the puzzle's own preferences as rows, read from its preferences form, which is never shown. The keyboard-shortcut switch is left out.
- How to play (goal, a turn, the end, a tip) comes from the manual; History and About are as in every game; About carries the credit, the MIT licence and a link to the puzzle's manual page in the ZIM, which stays English.
- Hint: none of the 41 has one, so none is drawn.
- Touch: a tap is a left press, a long press is a right press, and Mark (Pencil, where there are digits) makes taps right presses until pressed again; no mouse-button words anywhere.
- The win is the status bar's COMPLETED, or, for the 26 puzzles with no status bar, the completion flash after the player's own move. Solving it yourself is a win with a sheet (Time and Best); loading a solved game, or the solver, is not. Best times are kept per Type name; a custom size has none.
- A dealt game is kept as well as a played one, so leaving and returning is the same puzzle, undo history included; a solved game is not kept.
- Words: the type names, grid names and the puzzle's own dialogs are put in the player's language where we have the words (pz.d.*, pz.t.*); anything else stays as the puzzle wrote it.
- The canvas palette is remapped to Zimi in light and dark: background surface2, grid lines and clues in ink, the cursor and selection in amber.

## The shelf (index.html, shelf.js)

It is the first screen, so it follows every rule above, plus these:
- The header is the games icon tile, then "ZimiGames" at 26.
- Filter chips are pills. The selected chip has an accent-glow fill, an accent line and ink text, as in Zimi, never a near-black fill.
- Game tiles share one shape: radius 14 and one art background family (surface2 plus the game's thumbnail), never a per-game navy.
- Game of the Day uses a 1px line with an amber label, not a thick amber border.
- "Start something" either shows a real game or isn't drawn; it is never an empty slab.
- Live tiles show the table as you left it.

## Leading out of a game (librarykit.js, almanac-gamesky.js, one hook in app.js)

A game that draws on the player's library may point at the real thing Zimi already has. The rules:
- One quiet link, on a round or an end sheet, never in the way of play and never before the answer. It is drawn only when the thing exists: the page is in the ZIM (RoundKit asks), the word is in a Wiktionary and the Dictionary is on, a map's box holds the place, a race passed through the page.
- Inside Zimi the link asks Zimi to open it (`Lib.leadOut`), so the reader has its own header and Back returns to the game. A modified click keeps the plain link. Outside Zimi there is no Zimi to ask: article links stay plain links, and Dictionary and map links are not drawn.
- Articles: Quizzical, Flags, Higher or Lower, First Lines (Bookshelf's own open is the same article open), Dictionary Bluff, Babel, Where in the World, Wiki Race (the route's pages, on the end sheet). Words: Bluff, Babel and Five Letters open the word in the Dictionary. Places: Drop Pin and Where in the World open the place on the StreetZim map (`Lib.mapFor`: the map the place came from, else a searchable map whose box holds it).
- The position survives the trip: the page saves on pagehide as always, and Zimi's Back brings the game back to it.
- The hook, in app.js beside `_gameDo`, is a message from the frame showing the game: `{zimi: 'open', zim, path}` (an article; a path may end in `#map=zoom/lat/lon`), `{zimi: 'game-app', app: 'dictionary', w}` and `{zimi: 'game-sky', place, ms, title, hint, start, close, az, alt, fov, ring}`, answered `{zimi: 'game-sky-done', started}`. No state and no strings live in Zimi for these: the game sends its own words, in the player's language.
- Sky Detective studies first: inside Zimi the Almanac's own `AlmanacSkyView` opens over the page (static/almanac-gamesky.js, loaded with the Almanac's modules on first use), names on, drag and pinch, for the game's own moment (the time machine's instant is set while it is up and put back). Anywhere else the page's own dome is drawn with every name on it. After an answer, "See it in the sky" turns the same view to the answer and rings it.
