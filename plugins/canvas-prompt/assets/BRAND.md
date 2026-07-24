# Canvas Prompt Brand Assets — v1

## Standard mark

The sole product mark is **D2 Compact**, the static square mark selected on 2026-07-24.

It represents one hand-drawn wave becoming a red prompt cursor. It is the mark used in the Codex composer, plugin marketplace, browser favicon, and future product surfaces.

Do not substitute D1, D4 animation, the removed upward variant, arrows, generic palettes, or a separate AI-generated symbol for this mark.

## Canonical files

| Surface | File | Rule |
| --- | --- | --- |
| Light vector master | `logo.svg` | Canonical light static mark, 96 × 96 viewBox |
| Dark vector master | `logo-dark.svg` | Dark-surface counterpart |
| Marketplace / large raster | `logo.png`, `logo-dark.png` | 512 × 512 exports of the respective masters |
| Composer icon | `icon.png` | 128 × 128 export of the light master |
| Browser favicon | `../app/public/favicon.svg` | Must be byte-identical to `logo.svg` |

## Locked palette

- Light canvas: `#F6F1E7`
- Dark canvas: `#171512`
- Primary cursor red: `#C8462B`
- Dark-surface cursor red: `#E85D3D`

## Change rule

Any visual change is a brand decision: update the vector master first, regenerate all declared raster variants, update this document, run `scripts/verify-brand-assets.sh`, and record the replacement in FLG before it reaches a plugin or public repository.
