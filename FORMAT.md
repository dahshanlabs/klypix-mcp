# The `.klypix` format (v4)

`.klypix` is an **open, local-first, agent-neutral** canvas file. It's a plain
**ZIP** of JSON + assets — no proprietary binary, fully inspectable (`unzip
your.klypix`), and parseable with the Apache-2.0 library in this package. You own it;
any agent or app can read and write it.

## Container layout

```
your.klypix              (a ZIP archive)
├── manifest.json        metadata + stats
├── canvas.json          spatial layout: order, positions, connections, lines, strokes, settings
├── items/
│   └── <2-hex>/<id>.json one file per item (content only; position lives in canvas.json)
└── assets/
    └── <assetId>        embedded binaries (images, PDFs, audio, video, files)
```

Item files are **sharded** by the first 2 hex chars of the id's random part
(e.g. `items/a3/txt_a3f9…json`) so a canvas with thousands of items stays fast
to read partially.

## `manifest.json`

```json
{
  "format": "klypix",
  "version": 4,
  "schemaVersion": 4,
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "title": "My board",
  "stats": { "itemCount": 12, "assetCount": 3, "totalBytes": 0 }
}
```

## `canvas.json`

```json
{
  "version": 4,
  "view": { "panX": 0, "panY": 0, "zoom": 0.8 },
  "order": ["<id>", "..."],                       // z-order (render order)
  "positions": {                                   // per-item geometry, by id
    "<id>": { "x": 0, "y": 0, "w": 280, "h": 80, "zKey": "a001", "zIndex": 1, "parentId": null }
  },
  "connections": [                                 // arrows between items
    { "id": "con_…", "fromId": "<id>", "toId": "<id>", "relationship": "leads_to", "arrowHead": true }
  ],
  "lines": [], "strokes": [],                      // freehand drawing
  "settings": { "background": "#0a0a0f" }
}
```

Position/geometry is kept in `canvas.json.positions`, **not** in the item file —
so moving an item never rewrites its content, and the spatial layout can be read
without loading every item.

## Item files — `items/<shard>/<id>.json`

Content only (no x/y/w/h). Common types: `text`, `box`, `image`, `file`,
`code`, `video`, `audio`, `link`, `canvasLink`, `container`. Example text item:

```json
{
  "type": "text",
  "content": "Decision: ship the open format first",
  "fontSize": 15,
  "color": "#e8e8ed",
  "border": true,
  "heading": false,
  "createdBy": "agent"
}
```

Items can reference an embedded binary in `assets/` (e.g. an `image`/`file`/
`video`/`audio` item points at its asset id).

## Connections, links, tags

- **Arrows:** `canvas.json.connections` (`fromId`/`toId`, optional
  `relationship` ∈ `leads_to | depends_on | relates_to | conflicts_with |
  supports | questions | costs | blocks`).
- **`[[wikilinks]]`** inside text content cross-link cards (and auto-draw edges).
- **`#tags`** inside text content group cards.

## Legacy `.any` (v1–v3)

Older files keep an inline `items` array at the root of `canvas.json` instead of
the `items/` folder + `positions` map. The parser in this package handles both.

## Read / write it

```js
import { parseKlypix, buildKlypix, appendToKlypix, structToMarkdown } from 'klypix-mcp';

const { struct } = await parseKlypix(fs.readFileSync('board.klypix'));
console.log(structToMarkdown(struct));            // cards + graph + links + tags

const buf = await buildKlypix({ title: 'Plan', cards: [{ text: 'kickoff' }] });
fs.writeFileSync('plan.klypix', buf);
```

That's the whole contract: **a ZIP you own, that any model can read and write.**
