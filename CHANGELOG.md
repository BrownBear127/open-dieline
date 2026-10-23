# Changelog

All notable changes to Open Dieline are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **License now carries a Required Notice** — `LICENSE` opens with
  `Required Notice: Copyright (c) 2026 BrownBear127 (https://konvolut.art)`.
  Under the PolyForm Noncommercial terms, anyone who redistributes the
  software must keep this line. The license terms themselves are unchanged.

## [1.4.1] — 2026-08-06

### Fixed

- **Auto-rotate stops the moment it's switched off** — turning the toggle off
  used to leave a damped rotation tail, and its wall-clock length grew as the
  frame rate dropped; the residual momentum is now drained on release, so the
  camera halts within a frame at any frame rate.

## [1.4.0] — 2026-08-06

### Added

- **Telescope box 3D fold preview** — the two-piece box now folds up in the
  preview like the others: lid and base rise side by side, walls lift in a
  staggered sequence, corner flaps wrap onto their neighbouring walls, and the
  lid settles over the base at true material thickness. The motion is guarded
  by kinematic gates — no self-intersection, no reverse folds, per-piece
  envelopes — asserted down to the rendered mesh, with pixel-level checks on
  the finished pose.

### Fixed

- **Telescope dieline creases** — the corner flaps now carry their fold
  creases, and the side web is split at wall height, so the exported dieline
  folds the way the preview shows it.
- **Fold preview framing** — the preview opens framed on the finished box
  instead of the flat sheet, and while the telescope folds, the camera eases
  in from the sheet's envelope so no piece ever leaves the frame.
- **Sharper 3D rendering** — WebGL support was probed on the preview's own
  canvas, which locked its context before renderer options could apply;
  probing a throwaway canvas instead restores antialiasing.

## [1.3.0] — 2026-07-23

### Fixed

- **Fold preview accuracy** — the triangular tube's lock-seam strip now pre-curls
  progressively through the fold instead of swinging in as a rigid plate, and its
  end closures settle flush inside the folded silhouette: protruding friction-fit
  corners ease into the box outline, and edge-on flap corners bend slightly
  inward, the way paper actually tucks. These behaviours are guarded by physical
  gates — no self-intersection, no reverse folds, bounded angular rate, bounded
  easing displacement — asserted all the way down to the rendered mesh geometry.
- **Editor and template guides** — guide lines are drawn from the source 2D
  dieline paths again, restoring complete crease and slot lines that were
  previously reconstructed and truncated.

### Added

- **Two new box types** — the Tuck-Top Snap-Lock Carton and the Triangular
  Tube Box join the catalogue, each with a full parametric dieline, 3D fold
  preview, and SVG/DXF export.
- **Upload alignment guard-rail** — SVG artwork is anchored by its page frame
  when one is present, and flagged with a warning (box mismatch, stale template,
  or aspect anomaly) instead of silently mis-aligning; warnings re-evaluate live
  as you switch boxes or change parameters.

## [1.2.0] — 2026-07-20

### Added

- **3D fold preview** — a third mode that folds the flat dieline up into the finished
  box in real time; pull a slider to fold, and orbit to inspect any face. The printed
  face folds to the outside, so what you see is the box's exterior. Built on three.js.
- **Paper materials** — real board thickness, a contact shadow, and a procedural paper
  grain, in three recipes: white, kraft (default), and black.
- **Artwork editor** — lay images and set type on the flat canvas (multiple objects,
  undo, snap), watch it fold live, and download in three layers: white paper backing,
  artwork with the box outline, and the red/blue cut-and-crease dieline.
- SVG uploads now accept embedded raster images.
- Shareable page metadata (OpenGraph, Twitter cards, canonical), `robots.txt`, a
  sitemap, and cookieless, first-party analytics.

### Changed

- The app now serves from its own branded domain, and canonical/share links point to it.

## [1.1.0] — 2026-07-16

### Added

- Bilingual interface — English and Traditional Chinese — with an in-page language
  switcher and `hreflang` alternates.

### Changed

- Redesigned the tool and its marketing site around a single, consistent editorial
  vocabulary.

## [1.0.0] — 2026-07-12

- First public release: parametric packaging dielines for Reverse Tuck End and
  Telescope boxes, drawn to real production conventions, with SVG and DXF export.
  Free for noncommercial use.

[Unreleased]: https://github.com/BrownBear127/open-dieline/compare/v1.4.1...HEAD
[1.4.1]: https://github.com/BrownBear127/open-dieline/releases/tag/v1.4.1
[1.4.0]: https://github.com/BrownBear127/open-dieline/releases/tag/v1.4.0
[1.3.0]: https://github.com/BrownBear127/open-dieline/releases/tag/v1.3.0
[1.2.0]: https://github.com/BrownBear127/open-dieline/releases/tag/v1.2.0
[1.1.0]: https://github.com/BrownBear127/open-dieline/releases/tag/v1.1.0
[1.0.0]: https://github.com/BrownBear127/open-dieline/releases/tag/v1.0.0
