# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0]

### Added

- Cost carry-over. A markdown document that contains the line
  `<!-- doom-hud:carry -->` gets the session's accumulated usage stamped into a
  fenced `doom-hud-carry` block whenever that document is written or edited.
  Reading such a block in another session adopts those totals, so COST, the
  token buckets and BLENDED continue where the previous session left off. The
  adopted totals are kept in a `doom-hud:carry` session entry, which survives a
  resume and never enters the model's context.
- `CARRY` row in the stats tile, showing the part of COST that came from a
  carry block, so the big number stays auditable against its buckets.
- `/doomhud carry stamp <file>` to stamp a document by hand, and
  `/doomhud carry clear` to drop an adopted carry for the session.
- A one-line transcript entry recording where carried cost came from, so a
  non-zero COST at session start explains itself after a resume.

### Fixed

- `OTHER` now prints in the same cost column as the token buckets. It and the
  new `CARRY` row pad the token column instead of starting a column early.

### Changed

- The usage total that both the bar and a stamped block use now comes from one
  aggregation helper, so the two cannot disagree.

## [1.0.2]

- Previous release. Changes before 1.1.0 were not recorded in this file.
