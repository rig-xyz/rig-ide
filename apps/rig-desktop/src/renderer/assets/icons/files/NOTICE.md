# File-type icon assets — attribution and license

The raster glyphs in this directory (`document`, `table`, `image`, `note`,
`skill`, `archive`, each shipped as `@1x` 18×18 and `@2x` 36×36 PNGs) are
derived from **Microsoft Fluent Emoji** (3D style), used under the MIT
License. Source: https://github.com/microsoft/fluentui-emoji

| Icon type | Source glyph (Fluent Emoji, 3D) | Source path |
| --- | --- | --- |
| `document` | Page facing up | `assets/Page facing up/3D/page_facing_up_3d.png` |
| `table` | Bar chart | `assets/Bar chart/3D/bar_chart_3d.png` |
| `image` | Framed picture | `assets/Framed picture/3D/framed_picture_3d.png` |
| `note` | Memo | `assets/Memo/3D/memo_3d.png` |
| `skill` | Sparkles | `assets/Sparkles/3D/sparkles_3d.png` |
| `archive` | Package | `assets/Package/3D/package_3d.png` |

Each source PNG (256×256) was resized only (no recoloring or recomposition)
to 18×18 (`@1x`) and 36×36 (`@2x`) with macOS `sips` for use at the file
navigator's ~18px row-icon size.

The folder glyph used elsewhere in the navigator is NOT one of these
assets — it's an owned SVG (see `src/renderer/features/workspace/folder-icon.tsx`),
using Fluent's folder only as a shape reference, not vendored artwork.

**3dicons** (https://github.com/realvjy/3dicons, CC0) was evaluated as an
alternative source per the file-navigator design doc but not used for this
pass — Fluent Emoji 3D's coverage of the curated set (document/table/image/
note/skill/archive) was sufficient and is the preferred source per the
design doc. Noted here for completeness since the doc calls it out as a
verified-license option; no CC0 attribution is legally required if it's
used later.

## Microsoft Fluent Emoji license (MIT)

```
MIT License

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
