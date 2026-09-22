# Changelog

## 1.0.0

First public release.

- Doom-style status bar widget: TOKENS, CONTEXT, MODEL, animated Doom Guy
  face, COST, and a session economics tile (CACHE / IN / OUT / BLENDED).
- Pixel face on terminals with inline-image support (Kitty graphics protocol
  or iTerm2 inline images), one single-row image per bar row so it composes
  with pi-tui's line diffing. Quadrant-block fallback everywhere else.
- Animated eyebrows with a random-walk walk cycle, occasional focus face, and
  the dead face while a compaction runs.
- `/doomhud` toggle command with `image` and `text` subcommands.
- `DOOM_HUD_IMAGE=0` and `DOOM_HUD_SLICE_SCALE=2` environment overrides.
