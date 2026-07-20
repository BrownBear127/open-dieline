# Changelog

All notable changes to Open Dieline are documented here.
This project follows [Semantic Versioning](https://semver.org/).

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

[1.2.0]: https://github.com/BrownBear127/open-dieline/releases/tag/v1.2.0
[1.1.0]: https://github.com/BrownBear127/open-dieline/releases/tag/v1.1.0
[1.0.0]: https://github.com/BrownBear127/open-dieline/releases/tag/v1.0.0
