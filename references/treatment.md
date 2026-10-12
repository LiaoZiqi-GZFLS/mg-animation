# Treatment & style bible

Write this **before** the shot table, in the project as `TREATMENT.md`, and keep it the file a shot
must answer to. It is cheap: an hour of prose saves a day of re-authoring, and it is the only place
where a decision ("no outlined type", "act three turns pink") is recorded somewhere a later shot can
read. The layout and the plate table are borrowed in shape from
[pdoom-video](https://github.com/mexicat/pdoom-video)'s `docs/TREATMENT.md` (MIT); the words below are ours.

## The idea in one paragraph

Five sentences at most: what the film argues, who is speaking, and what the viewer should feel at the
end. If you cannot write this, the shot table will not save you.

> *Example (the skill's own showcase film): a motion-graphics engine that renders a film from code,
> arguing that a frame is a pure function of song time. The voice is a terminal, not a narrator. It
> should feel like watching an instrument panel play a song.*

## Tone

Three or four adjectives with a reason attached, e.g. *instrument-cold, but not sterile: every pass is
audible, so nothing needs to shout.* These decide the grade, not the mood board.

## Palette

Per act, with the time it takes over and **why it changes there** (a key change, a lyric, a drop):

| act | window | key | fill | background | the reason |
|---|---|---|---|---|---|
| 1 | 0 – 50.7 | `#7ef0ff` | `#3f7d94` | `0.004,0.008,0.014` | the panel is off, only instruments glow |
| 2 | 50.7 – 100.6 | `#7ef0ff` | `#ffb36b` | … | the human enters: amber |
| 3 | 100.6 – end | `#ff6b8a` | `#ffd166` | … | the argument turns warm and worried |

Rules that belong here: base surfaces stay under 1.0 linear so only highlights bloom; `fill` is the
second voice and never carries a title; a shot may not introduce a hue that is not in this table.

## Typography — who speaks in which face

| voice | face | weight | case | example |
|---|---|---|---|---|
| statement | Space Grotesk | 700–800 | as written | `ONE FRAME, GRADED` |
| instrument | JetBrains Mono | 500–600 | lowercase | `rms 0.412` |
| prose | system CJK | 400 | 中文 | `每一个镜头是一段函数` |

Then the hard rules (see [craft.md](craft.md) for the full list): no outlined or haloed type;
typographic punctuation everywhere except the instrument voice; at most one title-level string on
screen at a time.

## Karaoke / caption rules

Whether words are sung along at all, and if so: where they sit, how a word enters, what happens to a
line that crosses a cut. **If captions carry no information the picture does not already have, turn
them off** (`config.lyricsOff = true`) — a caption is a second narration, not a subtitle.

## Motifs

The two or three visual ideas the film repeats — the ones a viewer could name. Each motif gets a
sentence of what it must never become (e.g. *the particle sphere is a data object, so it never spins
for decoration*).

## Plates

One row per shot. This table **is** the storyboard; the shot list in `src/film.js` is its transcription,
and the two must agree.

| id | window (anchor) | what this shot says | motif | exit join |
|---|---|---|---|---|
| `open` | 0 → on(4) | a terminal boots and types its own name | HUD | wipe |
| `hook` | on(13) ×4 | the repeated line, once per treatment | sphere | iris |

Write the window as a **key** (`on(13)`, `B('chorus', 2)`), never a number: the beat grid moves when
the track is re-analysed, and a hard-coded second is a bug waiting to happen.

## After authoring

Re-read the plate table against `node scripts/sheet.mjs --project . --cuts`. Every row should be
findable in the sheet, and every cell should say what its row claims. That loop — page, sheet, fix —
is where the film actually gets made.
