# The `.klypix` format (v4)

`.klypix` is an **open, local-first, agent-neutral** canvas file. It's a plain
**ZIP** of JSON + assets — no proprietary binary, fully inspectable (`unzip
your.klypix`), and parseable with the Apache-2.0 library in this package. You own it;
any agent or app can read and write it.

Two working examples ship in this package under [`examples/`](examples/). Both are
text-and-arrows only (14 cards, no `assets/` entry), so they demonstrate the card /
container / connection model, not the embedded-binary half described below.

## Container layout

```
your.klypix                      (a ZIP archive)
├── manifest.json                metadata + stats; read FIRST
├── canvas.json                  spatial layout: order, positions, connections, lines, strokes, view, settings
├── items/
│   └── <shard>/<id>.json        one file per item (content only; geometry lives in canvas.json)
└── assets/                      embedded binaries — any non-directory entry here is an asset
    ├── images/<shard>/<sha256>.<ext>
    ├── files/<shard>/<sha256>.bin
    └── thumbs/<itemId>.png
```

`<shard>` is the **first two characters of the id (or sha) after its namespace
prefix is stripped**, lowercased, left-padded with `_` if shorter — e.g.
`txt_hto5hb3r_0_0` → `items/ht/txt_hto5hb3r_0_0.json`, and sha `a3f9…` →
`assets/images/a3/a3f9….png`. Ids are base36-ish, not strictly hex, so treat the
shard as "two characters", not "two hex digits". Sharding bounds files-per-directory
and lets a canvas with thousands of items be read partially.

Readers should treat the `assets/` sub-layout as **convention, not contract**: this
package's parser counts and reads *any* non-directory entry under `assets/`, so a
writer that flattens to `assets/<assetId>` still parses. Only the KLYPIX app's own
writer guarantees the content-addressed `images/ files/ thumbs/` split.

## `manifest.json`

```json
{
  "format": "klypix",
  "version": 4,
  "schemaVersion": 4,
  "kind": "brain",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "title": "My board",
  "stats": { "itemCount": 12, "assetCount": 3, "totalBytes": 0 },
  "sync": { "enabled": false, "lastSyncRev": null, "lastSyncAt": null, "deviceId": "dev_…" }
}
```

- `version` — on-disk **layout** version (the container shape).
- `schemaVersion` — **document** version (item/connection shapes).
- **`kind: "brain"`** — optional and additive; present only on a **project brain**.
  A brain is the co-owned agent/human memory file, and it gets stricter write
  semantics: union-merge-on-save under a capture lock, tombstone-only deletes. It is
  detected as `manifest.kind === "brain"` **OR** a `brain.*` basename — the filename
  convention keeps working forever, and the flag makes those semantics survive a
  rename. Plain canvases omit `kind` entirely, and older readers ignore it.
- `stats` is **informational only.** `totalBytes` is an uncompressed estimate (the
  on-disk size depends on compression), and `itemCount` is derived from
  `canvas.json.order`, which can disagree with the number of files actually under
  `items/`. Never use `stats` as an integrity check.
- `sync` records whether the file is opted into the app's cloud sync; it carries no
  content and no credentials.

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
    { "id": "con_…", "fromId": "<id>", "toId": "<id>",
      "relationship": "conflicts_with", "label": "corrects",   // both optional
      "arrowHead": true, "width": 2, "color": "#10b981", "style": "solid" }
  ],
  "lines": [], "strokes": [],                      // freehand drawing
  "nextGroupNumber": 4,                            // container auto-naming counter
  "settings": { "background": "#0a0a0f", "gridStyle": "dots", "gridColor": "…" }  // all optional
}
```

Position/geometry is kept in `canvas.json.positions`, **not** in the item file —
so moving an item never rewrites its content, and the spatial layout can be read
without loading every item. `zKey` is a fractional index and is the source of truth
for z-order; `zIndex` is a numeric cache kept in step with the `order[]` index.
`settings` is optional and captures the *sender's* visual context, so a recipient
does not see someone else's canvas in their own theme.

`order` and `positions` are the two indexes a reader walks. A tolerant reader skips
an `order` entry with no `positions` row and an entry with no file under `items/`
(this package's parser does both) — but note that a writer which then re-serializes
that state can make the omission permanent.

## Item files — `items/<shard>/<id>.json`

Content only — no `id` (it is in the path) and no `x/y/w/h/zIndex/zKey/parentId`
(those are in `canvas.json.positions`). The `type` field is one of exactly eleven
strings: `text`, `box`, `image`, `file`, `container`, `approval`, `link`,
`canvas-link`, `video`, `audio`, `code`. Example text item:

```json
{
  "type": "text",
  "content": "Decision: ship the open format first",
  "fontSize": 15,
  "color": "#e8e8ed",
  "border": true,
  "heading": false,
  "createdBy": "agent",
  "createdVia": "claude-code"
}
```

`createdBy` (`user` | `agent`) and the optional `createdVia` (which agent/channel
captured it) are the provenance bits the brain surfaces as badges and lenses.

## Bytes: when they are embedded vs referenced

**Embedded** — the bytes live inside the ZIP under `assets/`, and the item JSON
references them by key/sha:

| Item type | What is embedded |
|---|---|
| `image` | the original image (plus an optional downscaled `thumbnailAssetId`). Non-destructive crop/rotate/annotation data lives in the item JSON; the original asset stays canonical. |
| `file` | the original file bytes. A **folder card** (`isFolder: true`) embeds the whole directory as one ZIP asset, with a `folderManifest` listing what's inside so the card renders without unzipping. |
| `video`, `audio` | the media bytes, streamed from the asset at render time rather than loaded whole. |

**Referenced, never embedded** — nothing is copied into the file:

| Item type | What it points at |
|---|---|
| `link` | a remote `url` (+ cached Open Graph title/description; the OG image is fetched live, not stored) |
| `canvas-link` | another `.klypix` file by **absolute path on disk** — so it breaks if you email the file alone |
| `text`, `code`, `box`, `container`, `approval` | content is inline in the item JSON; there is no asset at all |

`file` / `video` / `audio` items may also carry `originalPath` — a convenience
pointer for "open in the OS app". The bytes are still embedded; the path is not the
source of truth.

Legacy files may carry an `image` item's bytes as an inline base64 `src` data URL
instead of an asset. New writers use `assetId` and leave `src` empty.

**This package reads assets but does not create them.** `create_canvas`,
`add_to_canvas` and `buildKlypix` write `manifest.json`, `canvas.json` and item
files — cards and arrows. Embedding binaries is done by the KLYPIX app when you drop
a file onto a canvas.

## Connections, links, tags

- **Arrows:** `canvas.json.connections` (`fromId`/`toId`, optional
  `relationship` ∈ `leads_to | depends_on | relates_to | conflicts_with |
  supports | questions | costs | blocks`).
- **`[[wikilinks]]`** inside text content cross-link cards (and auto-draw edges).
- **`#tags`** inside text content group cards.

## Versioning — and a real limitation

`manifest.version` is the layout version and `manifest.schemaVersion` the document
version. Both are `4` today.

**There is no migration path registered for v4, and the v4 load path does not run
one.** Be precise about what that means, because it is a live limitation, not a
to-do that is quietly handled:

- The migration framework exists and works, but its table contains exactly two
  steps, `1 → 2` and `2 → 3`. Only the legacy `.any` (v1–v3) read path walks it; the
  v4 path never enters the migration runner.
- Both this package's parser and the KLYPIX app's v4 reader treat
  `manifest.version >= 4` as "this is v4" and dispatch on nothing else — the app's
  deserializer never reads `manifest.version`, `manifest.schemaVersion` or
  `canvas.json.version` at all.
- So a hypothetical v5 or v6 file **opens as v4**: fields the reader does not know
  are dropped, with no "this build is too old to open it" error anywhere. Saving it
  from the app then rewrites `version: 4` — a silent downgrade. (This package's
  `appendToKlypix` is non-destructive by construction: it mutates the parsed
  manifest and `canvas.json` in place and leaves every existing item file byte-for-byte
  untouched, so unknown fields survive a round trip through it.)

Consequences for anyone implementing against this format: do not assume a future
version will be rejected for you, and if you write `.klypix` files, do not bump
`manifest.version` past 4 expecting existing readers to refuse them safely. If you
extend the format, prefer **additive** optional fields (the way `manifest.kind` was
added) over a version bump.

## Legacy `.any` (v1–v3)

Older files keep an inline `items` array at the root of `canvas.json` instead of
the `items/` folder + `positions` map. The parser in this package handles both, and
detects the older shape by the absence of `positions` even if the manifest is
missing. Legacy files are migrated `1 → 2 → 3` on open by the app.

## Practical size limits

The format itself imposes no size limit — a `.klypix` is a ZIP. The limits below are
**guards in the KLYPIX app**, not properties of the format, and this package's
parser enforces none of them:

| Limit | Value | Where it applies |
|---|---|---|
| Per-file (leaf) on folder ingest | **200 MB** | a single file inside a dropped folder; anything larger is skipped and recorded in the card's `folderSkipped` list so you can see what was left out |
| Per folder card, total | **1 GB** | ingestion stops once a dropped folder would push the card past this |
| Per cloud share | **50 MB** | sharing a canvas through the app's cloud; a larger canvas is refused with a `too-large` result rather than truncated |

Nothing stops you writing a larger file locally with this library; expect the app's
share and folder-ingest paths to refuse it.

## Read / write it

```js
import { parseKlypix, buildKlypix, appendToKlypix, structToMarkdown } from 'klypix-mcp';

const { struct } = await parseKlypix(fs.readFileSync('board.klypix'));
console.log(structToMarkdown(struct));            // cards + graph + links + tags

const buf = await buildKlypix({ title: 'Plan', cards: [{ text: 'kickoff' }] });
fs.writeFileSync('plan.klypix', buf);
```

Or from a shell, against one of the examples in the tarball:

```bash
npm i klypix-mcp
npx klypix-read node_modules/klypix-mcp/examples/showcase-brain.klypix
```

That's the whole contract: **a ZIP you own, that any model can read and write.**
