# Tokenomy — identity exports

All SVGs are vector, transparent-background, no rasterization. Drop straight into the repo / README / npm card / GitHub social.

## Primary mark (recommended)

| file | use |
|---|---|
| `mark-primary-512.svg` | general purpose, social image |
| `mark-primary-256.svg` | README header |
| `mark-primary-128.svg`, `-64.svg`, `-32.svg`, `-16.svg` | app icon / favicon sizes |
| `mark-A-bracket-t.svg` | same geometry, 512 |
| `mark-A-bracket-t-mono-ink.svg` | monochrome (no crimson tick) |
| `mark-A-bracket-t-reversed.svg` | light mark on dark surface |

## Alternate marks (for reference / pick-your-favorite)

`mark-B-caliper-t.svg`, `mark-C-reduction.svg`, `mark-D-stack.svg`, `mark-E-slash.svg`, `mark-F-corner.svg` — each also has `-mono-ink` and `-reversed` variants.

## Wordmark + mark lockup (wide)

| file | use |
|---|---|
| `wordmark-wide-light.svg` | light-surface README header (1200×320) |
| `wordmark-wide-dark.svg`  | dark-surface social / terminal banner |
| `wordmark-wide-mono.svg`  | monochrome — no accent |

The wide lockups embed JetBrains Mono via `@import`. Viewers with internet access render the correct type; offline viewers fall back to a system monospace (still looks fine). For bullet-proof print / print-safe PDFs, open in Figma/Illustrator and outline the text.

## Palette

```
ink     #0d0d0f
paper   #fafaf7
crimson #c8342b   ← only used as the single "trim tick"
```

## Favicon

Convert `mark-primary-32.svg` with any SVG→ICO tool, or use the SVG favicon directly:

```html
<link rel="icon" type="image/svg+xml" href="mark-primary-512.svg">
```
