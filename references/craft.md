# Craft numbers worth copying

Everything here is a starting point that already looks right at 1080p. Deviate on purpose.

## Time

| Move | Duration | Notes |
|---|---|---|
| Hard cut | 0 frames | Default. Most of a film is cuts. |
| Wipe / slide join | 0.20–0.25 s | Reads as "next item", not "next scene". |
| Glitch join | 0.22–0.30 s | Row displacement must resolve before the new shot's own entrance. |
| Dissolve | 0.35–0.50 s | One beat at 120 BPM is 0.5 s — a beat-length dissolve always feels placed. |
| Zoom / punch-in join | 0.25–0.35 s | |
| Entrance ramp (exposure flash) | 5–7 frames | `applyRamps` default 6; longer reads as a fade, which is weak. |
| Punch settle after a cut | 8 frames | `post.zoom` 1.04 → 1.0. |
| Decode-reveal of a key word | 0.40–0.60 s | `heroWord({decode})`; per-letter lock adds `lock 0.06` each. |
| Typewriter | 18–40 chars/s | 34 for code, 22 for narration-like text. |
| Word-by-word lyric reveal | start−0.03 → start+0.09 | Already in `drawLyrics`. |
| Stagger across N siblings | 0.06–0.12 s each, ≤0.4 s total | Beyond that the group stops reading as one idea. |
| Pop overshoot decay | `1 + 0.12·e^(−age/0.05)` | Only after something locks in or lands. |
| Fresh-tick flash | `e^(−age·18)` | For newly lit bars, ticks, rows. |
| Hold before a cut | ≥0.3 s of stillness | The eye needs the last frame of an idea. |

## Easing — pick by intent, never linear for entrances

| Intent | Curve |
|---|---|
| Something arrives, opens, grows | `ease.outCubic` |
| Camera travel, anything that must look unhurried | `ease.inOutSine` |
| Something leaves, drains, collapses | `ease.inCubic` |
| Lock-in, stamp, button press | `ease.outBack` |
| Impact, elastic settle | `ease.outElastic` (sparingly) |
| Slow drift, rotation, orbit | **linear** — easing a continuous drift makes it look animated-by-tween |

Rule of thumb: overshoot on things with physical presence, never on text opacity.

## Layout (design grid 1920×1080, `MARGIN`)

| Slot | Value |
|---|---|
| Frame inset (HUD brackets) | 44 px |
| Bracket arm length | 26 px |
| Safe area | x 96…1824, y 96…984 |
| Title band | y 240…420, centred |
| Section label (top-left) | (44, 30), 20 px mono 600 |
| Timecode (top-right) | (1876, 30), right-aligned |
| Readout block | x 1480, y 150, 19 px mono, 26 px line gap |
| Caption / lyric line | y 968, 38 px, glow 14 |
| Body copy size | 22–30 px; nothing under 17 px survives compression |
| Gutter between column groups | ≥96 px |

Two-column MG layouts read best with the diagram left (x 136…1000) and the numeric column right
(x 1100…1784). Do not let a chart's own labels share a column with a readout.

## Colour

One hue story per act, two semantic accents. The template's `THEME`:

```
primary #7ef0ff   (subject / "system")
accent  #ffb36b   (counterparty / "peak", "warning-adjacent")
hot     #ff5a6a   (error, cutoff)
good    #6cf0a8   (pass, confirm)
ink     #eef4f8   dim #7f8f9c   faint #33404a   grid #1b2530
```

- Keep the accents doing the same job in every shot; a palette change is a scene change.
- Match **luminance**, not hue, when several colours must read as equals: `rgb(hex, gain)` with a
  per-colour gain so a cyan and an orange sit at the same brightness.
- Text that must stay crisp goes in `ctx.text.overlay` (post-grade, exact colour). Text that should
  pick up bloom goes in `ctx.text.scene`.
- Backgrounds: 0.004–0.05 linear. Anything above 0.08 flattens the foreground.

## Grade (`POST_DEFAULTS`)

```
bloom 0.5   threshold 1.0  knee 0.4  radius 1.0
ca 0.18     glitch 0       scan 0.06  vignette 0.34  grain 0.035
sat 1.0     contrast 1.0   tonemap ACES (1)
```

Defaults are deliberately mild: a shot should look finished because of layout and timing. Per-shot
tweaks that are almost always right: `vignette 0.5` on dark shots, `scan 0.15` on terminal shots,
`sat 0.9` when a frame is competing with a bright neighbour, `bloom 0.35` when type is on screen.
Zero the grade (`tonemap 0, bloom 0, grain 0, vignette 0.15`) for deliberate 1-bit / dither looks —
a filtered monochrome view is no longer monochrome.

## Sync

- Cuts on `HIT(...)` (measured onset) not `beatTime(...)` (grid): grids drift by tens of ms.
- Cut one frame early (`lead = 1/renderFps`), already applied by `K.HIT`/`K.VOX`.
- Big camera or state milestones on **downbeats**; small element entrances on **words**.
- Modulate with audio gently: `1 + 0.2 * F.env('onset', t)` reads as breathing; `1 + 1.5 * env` reads
  as a strobe. Use `env` (decay peak-hold) rather than raw `get` for anything visible.
- Leave the last 0.3 s of a shot quiet — no new elements right before a cut.

## Motion

- One moving thing per layer: background drifts slowly (≤0.15°/frame of camera), midground carries
  the action, foreground furniture (HUD) stays put.
- Elements enter from the direction they will travel in, not from nothing.
- Rotation speed under ~0.6 rad/s reads as calm; above ~2 rad/s reads as a spinner.
- Parallax: 6–12 px of counter-motion per 100 px of camera travel is enough to read as depth.
- If a shot feels dead, add a *second* time scale (a slow drift under the fast entrance), not more objects.
