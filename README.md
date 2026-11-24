# Element to SVG

A Chrome extension that turns any part of a web page into a clean, editable SVG. Pick one or more container elements and it rebuilds their structure (boxes, text, images, icons) from SVG primitives, using the live layout and computed styles.

The output is real vector content, not a screenshot inside an `<svg>`. Text stays as `<text>`, and each element becomes a named `<g>` layer (`div.card`, `button-submit`, …), so it imports cleanly into Figma, Illustrator, Sketch or Inkscape.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose this folder.

There's no build step; the extension is plain JavaScript.

## Use

Click the toolbar icon (or press **Alt+Shift+S**) on any page, then:

| Action | |
| --- | --- |
| Hover | highlight an element (tag, class and size shown) |
| Click | select it |
| Shift/⌘/Ctrl + click | add to / remove from the selection |
| ↑ / ↓ | move the highlight to the parent / back down to the child |
| Space | toggle the highlighted element |
| Enter | export the selection |
| Esc | close the preview, or quit the picker |

The preview lets you **Download SVG**, **Download PNG** (2×) or **Copy SVG** (paste straight into Figma). Multiple selected elements are exported into one SVG at their relative positions.

### Options

- **Styled / Wireframe**: full styling, or a grayscale structural wireframe with outlined boxes and crossed-out media placeholders.
- **Text / Blocks**: real text, or rounded bars where each line of text sits (good for mockups).
- **Background**: paint the nearest ancestor background color behind the selection.
- **Embed images**: inline images as `data:` URLs so the SVG is self-contained. Cross-origin images are fetched by the background worker.

Options are remembered between sessions.

## What gets converted

- Boxes: background colors, linear and radial gradients, `url()` background images (size, position, repeat), per-corner border radii, uniform and per-side borders (solid/dashed/dotted), outer `box-shadow`
- Text: positioned line by line from the browser's own line breaks, with font family/size/weight/style, color, letter spacing, decoration, `text-transform`, `white-space: pre`, `text-overflow: ellipsis`, and gradient text (`background-clip: text`). Each line's width is pinned with `textLength`, so the layout holds when a font is substituted.
- `<img>` (incl. `object-fit` / `object-position`), inline `<svg>` (computed styles baked in, external `<use>` symbols and gradients copied into `<defs>`), `<canvas>`, `<video>` (current frame or poster)
- Form controls: text inputs and placeholders, textareas, selects, checkboxes, radios, range, color, buttons
- `overflow` clipping, opacity, approximate `z-index` painting order, list markers, open shadow DOM and slots, and visually-hidden (screen-reader-only) content is skipped

## Known limitations

- CSS transforms (rotate/skew) are flattened to the element's bounding box.
- `::before` / `::after` content, inset shadows, `filter`, `mix-blend-mode`, `clip-path` shapes and conic gradients aren't reproduced.
- Fonts are referenced by name, not embedded. Machines without the page's web fonts will substitute (line widths are preserved).
- PNG export renders the SVG as an isolated image, so web fonts fall back there as well.
- Cross-origin `<iframe>` content can't be read and is drawn as a placeholder.
- Protected pages (`chrome://`, the Chrome Web Store) can't be scripted. The icon shows a red `!` badge there.

## Project layout

```
manifest.json            MV3 manifest
src/background.js        injects the picker; fetches cross-origin images for embedding
src/content/serializer.js  DOM → SVG converter (globalThis.__elementToSvg.toSvg)
src/content/picker.js    in-page picker, toolbar and preview (shadow DOM)
icons/                   toolbar icons
```

## Permissions

- `activeTab` + `scripting`: inject the picker only when you click the icon
- `storage`: remember your options
- `<all_urls>` host access: lets the background worker download cross-origin images so they can be embedded. It is used for nothing else.
