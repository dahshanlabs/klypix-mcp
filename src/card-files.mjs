// card-files — hand an AI tool the bytes a .klypix canvas already holds.
//
// Founder decision D2 (2026-10-05): "the AI tool pays where it can". KLYPIX
// gives the calling AI the raw material that is ALREADY embedded in the saved
// canvas — a text file's words, a photo, a PDF or Office file on disk — and the
// AI reads it with its own model and its own file tools. Nothing here extracts
// text from a document, runs OCR, transcribes or watches anything: those are the
// KLYPIX app's readers (app-value test). The only transformation is making a
// photo SMALLER when the original would not fit what AI apps accept, so the AI
// can see it at all.
//
// What the hosts accept (researched 2026-10-05, cited in the PR):
//   • Claude Desktop refuses a whole tool result over 1 MB ("Tool result is too
//     large. Maximum size is 1MB.") — so the images in ONE result share a
//     budget well under that, and a large photo goes as a smaller copy.
//   • The Claude API takes jpeg/png/gif/webp only, downscales anything over a
//     1568 px (or 2576 px) long edge itself, and caps an image at 10 MB of
//     base64 (5 MB on Bedrock / Vertex).
//   • An MCP embedded resource carrying a PDF blob is rejected by claude.ai's
//     connector layer (-32602) and was misread by Claude Desktop, so PDFs and
//     Office files are handed over as a local file path (Claude Code's Read tool
//     opens PDFs and images), plus any preview KLYPIX already saved.
//
// The cache: every file handed over by path is copied ONCE to
//   <plugin data>/extracted           (plugin mode: pluginDataDir(), i.e.
//                                      KLYPIX_PLUGIN_DATA or CLAUDE_PLUGIN_DATA)
//   <os tmpdir>/klypix-mcp/extracted  (otherwise)
// as <sha256 prefix>-<safe original name>, written atomically.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import * as autoUpdateLib from './mcp-auto-update.mjs';

const MiB = 1024 * 1024;

/** Caps. Mutable only so tests can shrink them; never changed at runtime. */
export const LIMITS = {
  // base64 characters of images in ONE tool result (Claude Desktop: 1 MB per result).
  imageResultBudget: 800_000,
  // below this an image is not worth attaching (it would be a postage stamp)
  minImageB64: 40_000,
  // a file copied out to the cache
  cacheMaxBytes: 150 * MiB,
  // a folder card's embedded zip opened to reach entries inside it
  folderZipMaxBytes: 512 * MiB,
  // one entry inside a folder zip
  entryMaxBytes: 64 * MiB,
  // zip-bomb guard: an entry that inflates more than this many times its
  // compressed size is refused once it would exceed entryRatioFloor
  entryMaxRatio: 200,
  entryRatioFloor: 4 * MiB,
  // a JPEG decoded to make a smaller copy
  jpegMaxMegapixels: 64,
};

export const MODEL_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const TEXT_EXT = new Set([
  'txt', 'text', 'md', 'markdown', 'mdx', 'rst', 'adoc', 'org', 'csv', 'tsv', 'psv', 'json', 'jsonl', 'ndjson', 'geojson',
  'xml', 'html', 'htm', 'xhtml', 'svg', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'log', 'out',
  'srt', 'vtt', 'tex', 'bib', 'rtf', 'sql', 'graphql', 'gql', 'proto', 'csl',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte', 'astro', 'css', 'scss', 'sass', 'less',
  'py', 'pyi', 'ipynb', 'rb', 'php', 'java', 'kt', 'kts', 'scala', 'groovy', 'gradle', 'go', 'rs', 'c', 'h', 'cc', 'cpp',
  'cxx', 'hpp', 'hh', 'cs', 'fs', 'vb', 'swift', 'm', 'mm', 'dart', 'lua', 'pl', 'pm', 'r', 'jl', 'ex', 'exs', 'erl',
  'clj', 'hs', 'elm', 'nim', 'zig', 'sol', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd', 'make', 'mk',
  'cmake', 'dockerfile', 'tf', 'hcl', 'nix', 'gitignore', 'gitattributes', 'editorconfig', 'lock',
]);
const BINARY_EXT = new Set([
  'pdf', 'doc', 'docx', 'docm', 'dot', 'dotx', 'xls', 'xlsx', 'xlsm', 'xlsb', 'ppt', 'pptx', 'pptm', 'odt', 'ods', 'odp',
  'pages', 'numbers', 'key', 'epub', 'zip', '7z', 'rar', 'gz', 'tgz', 'bz2', 'xz', 'tar', 'exe', 'dll', 'msi', 'bin',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif', 'ico', 'psd', 'ai', 'sketch', 'fig',
  'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma', 'mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm', 'wmv',
  'klypix', 'any', 'sqlite', 'db', 'woff', 'woff2', 'ttf', 'otf', 'jar', 'class', 'pyc', 'wasm', 'dwg', 'dxf', 'step', 'stl',
]);
const OFFICE_EXT = new Set(['doc', 'docx', 'docm', 'dot', 'dotx', 'xls', 'xlsx', 'xlsm', 'xlsb', 'ppt', 'pptx', 'pptm', 'odt', 'ods', 'odp', 'rtf', 'pages', 'numbers', 'key']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm', 'wmv']);

export const extOf = (name) => {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : base.toLowerCase() === 'dockerfile' || base.toLowerCase() === 'makefile' ? base.toLowerCase() : '';
};
export const isOfficeExt = (ext) => OFFICE_EXT.has(String(ext || '').toLowerCase());
export const isAudioExt = (ext) => AUDIO_EXT.has(String(ext || '').toLowerCase());
export const isVideoExt = (ext) => VIDEO_EXT.has(String(ext || '').toLowerCase());

export const mb = (n) => {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} bytes`;
  if (v < MiB) return `${Math.round(v / 1024)} KB`;
  return `${(v / MiB).toFixed(v < 10 * MiB ? 1 : 0)} MB`;
};
const b64Length = (bytes) => Math.ceil(bytes / 3) * 4;

// ── The cache folder ─────────────────────────────────────────────────────────
export function cacheDir(env = process.env) {
  // Plugin mode (KLYPIX_PLUGIN=1) keeps its private files in the plugin's data
  // folder. pluginDataDir() (mcp-auto-update.mjs) already ignores a literal
  // "${…}" a host did not expand, so no folder of that name is ever created.
  const plugin = autoUpdateLib.pluginDataDir(env);
  if (plugin) return path.join(plugin, 'extracted');
  return path.join(os.tmpdir(), 'klypix-mcp', 'extracted');
}

/** A file name safe on every OS: no separators, no reserved characters, ≤ 100 chars. */
export function safeFileName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  let clean = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '');
  if (!clean) clean = 'file';
  if (clean.length > 100) {
    const ext = extOf(clean);
    const keep = ext && ext.length < 12 ? `.${ext}` : '';
    clean = clean.slice(0, 100 - keep.length) + keep;
  }
  return clean;
}

/**
 * Copy bytes to the cache once. → { path, sha256, bytes, reused }
 * The name is <first 16 hex of sha256>-<safe name>, so the same bytes always
 * land on the same path and a second call writes nothing.
 */
export function cacheBytes(buf, originalName) {
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sha256.slice(0, 16)}-${safeFileName(originalName)}`);
  try {
    if (fs.statSync(file).size === buf.length) return { path: file, sha256, bytes: buf.length, reused: true };
  } catch { /* not cached yet */ }
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`;
  fs.writeFileSync(tmp, buf);
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    // Another process wrote the same bytes first (Windows refuses to rename over
    // an open file): theirs is identical by construction.
    try { fs.unlinkSync(tmp); } catch { /* */ }
    if (!fs.existsSync(file)) throw error;
  }
  return { path: file, sha256, bytes: buf.length, reused: false };
}

// ── Reading bytes out of a canvas ────────────────────────────────────────────
/** Where an asset id lives inside the canvas zip, or null. */
export function locateAsset(parsed, id) {
  if (!id || typeof id !== 'string' || !parsed?.zip) return null;
  const direct = `assets/${id}`;
  if (parsed.zip.file(direct)) return direct;
  const stem = id.split('.')[0];
  return (parsed.assetPaths || []).find(p => p.endsWith(`/${id}`) || path.basename(p).split('.')[0] === stem) || null;
}

const declaredSize = (entry) => {
  const n = Number(entry?._data?.uncompressedSize);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const declaredCompressed = (entry) => {
  const n = Number(entry?._data?.compressedSize);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * Inflate one zip entry, never holding more than maxBytes: the declared size is
 * checked first, then the real byte count while streaming (a declared size can
 * lie). → { buf, size } | { tooLarge: true, size }
 */
export function readEntryCapped(entry, maxBytes) {
  const declared = declaredSize(entry);
  if (declared != null && declared > maxBytes) return Promise.resolve({ tooLarge: true, size: declared });
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const stream = entry.internalStream('uint8array');
    stream.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        try { stream.pause(); } catch { /* */ }
        resolve({ tooLarge: true, size: total });
        return;
      }
      chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length));
    });
    stream.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
    stream.on('end', () => { if (!settled) { settled = true; resolve({ buf: Buffer.concat(chunks), size: total }); } });
    stream.resume();
  });
}

/** The bytes of a canvas asset. → { buf } | { tooLarge, size } | { missing: true } */
export async function assetBytes(parsed, assetId, maxBytes = LIMITS.cacheMaxBytes) {
  const where = locateAsset(parsed, assetId);
  const entry = where ? parsed.zip.file(where) : null;
  if (!entry) return { missing: true };
  try { return await readEntryCapped(entry, maxBytes); } catch { return { missing: true } }
}

/** The bytes of a file on this PC, capped. → { buf } | { tooLarge, size } | { missing: true } */
export function diskBytes(file, maxBytes = LIMITS.cacheMaxBytes) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { missing: true };
    if (st.size > maxBytes) return { tooLarge: true, size: st.size };
    return { buf: fs.readFileSync(file) };
  } catch { return { missing: true }; }
}

// ── Text ─────────────────────────────────────────────────────────────────────
const hasUtf16Bom = (b) => b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff));

/** True for a text file: by extension, or sniffed as clean UTF-8 / UTF-16. */
export function looksLikeText(ext, buf) {
  const e = String(ext || '').toLowerCase();
  if (TEXT_EXT.has(e)) return true;
  if (BINARY_EXT.has(e) || !buf || !buf.length) return false;
  const head = buf.subarray(0, 65_536);
  if (hasUtf16Bom(head)) return true;
  if (head.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    return true;
  } catch { return false; }
}

/** Decode at most maxChars of text (BOM-aware). → { text, cut } */
export function decodeText(buf, maxChars) {
  const limit = Math.max(1, Number(maxChars) || 1);
  let encoding = 'utf-8';
  let start = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3;
  else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) { encoding = 'utf-16le'; start = 2; }
  else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) { encoding = 'utf-16be'; start = 2; }
  const end = Math.min(buf.length, start + limit * 4 + 4);
  let text = new TextDecoder(encoding).decode(buf.subarray(start, end), { stream: end < buf.length });
  let cut = end < buf.length;
  if (text.length > limit) { text = text.slice(0, limit); cut = true; }
  return { text, cut };
}

/** KLYPIX's saved DOCX preview (sanitised HTML from mammoth) as plain text. */
export function htmlPreviewToText(html) {
  const entity = (m, d) => { const n = Number(d); try { return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; } catch { return ''; } };
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|ul|ol|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, entity)
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** KLYPIX's saved XLSX preview (first rows of the first sheet) as tab-separated text. */
export function sheetPreviewToText(sheet) {
  if (!sheet || typeof sheet !== 'object') return '';
  const clean = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');
  const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
  const headers = Array.isArray(sheet.headers) ? sheet.headers : [];
  const lines = [];
  if (headers.length) lines.push(headers.map(clean).join('\t'));
  for (const r of rows) lines.push((Array.isArray(r) ? r : []).map(clean).join('\t'));
  return lines.join('\n');
}

// ── Images ───────────────────────────────────────────────────────────────────
/** An image's type from its first bytes, or null. */
export function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  if (buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand)) return 'image/heic';
    if (/^avi[fs]$/.test(brand)) return 'image/avif';
  }
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a) || (buf[0] === 0x4d && buf[1] === 0x4d && buf[3] === 0x2a)) return 'image/tiff';
  return null;
}

/** The EXIF orientation (1-8) of a JPEG, 1 when absent or unreadable. */
export function exifOrientation(buf) {
  try {
    if (!buf || buf[0] !== 0xff || buf[1] !== 0xd8) return 1;
    let i = 2;
    while (i + 4 <= buf.length) {
      if (buf[i] !== 0xff) return 1;
      const marker = buf[i + 1];
      if (marker === 0xd9 || marker === 0xda) return 1;
      const len = buf.readUInt16BE(i + 2);
      if (marker === 0xe1 && buf.toString('latin1', i + 4, i + 10) === 'Exif\u0000\u0000') {
        const t = i + 10;
        const le = buf.toString('latin1', t, t + 2) === 'II';
        const r16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
        const r32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
        const ifd = t + r32(t + 4);
        const count = r16(ifd);
        for (let k = 0; k < count; k++) {
          const e = ifd + 2 + k * 12;
          if (e + 12 > buf.length) break;
          if (r16(e) === 0x0112) { const v = r16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
        }
        return 1;
      }
      i += 2 + len;
    }
  } catch { /* malformed: treat as upright */ }
  return 1;
}

// Area-average downscale of an RGBA image so its long edge is ≤ edge.
function downscale(img, edge) {
  const { width: w, height: h, data } = img;
  const scale = Math.min(1, edge / Math.max(w, h));
  const W = Math.max(1, Math.round(w * scale));
  const H = Math.max(1, Math.round(h * scale));
  if (W === w && H === h) return img;
  const out = new Uint8Array(W * H * 4);
  const xMap = new Int32Array(w);
  for (let x = 0; x < w; x++) xMap[x] = Math.min(W - 1, Math.floor((x * W) / w));
  const acc = new Uint32Array(W * 4);
  const cnt = new Uint32Array(W);
  const flush = (dy) => {
    const row = dy * W * 4;
    for (let dx = 0; dx < W; dx++) {
      const n = cnt[dx] || 1;
      const a = dx * 4;
      out[row + a] = Math.round(acc[a] / n);
      out[row + a + 1] = Math.round(acc[a + 1] / n);
      out[row + a + 2] = Math.round(acc[a + 2] / n);
      out[row + a + 3] = 255;
    }
    acc.fill(0);
    cnt.fill(0);
  };
  let cur = 0;
  for (let y = 0; y < h; y++) {
    const dy = Math.min(H - 1, Math.floor((y * H) / h));
    if (dy !== cur) { flush(cur); cur = dy; }
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      const a = xMap[x] * 4;
      const s = row + x * 4;
      acc[a] += data[s];
      acc[a + 1] += data[s + 1];
      acc[a + 2] += data[s + 2];
      cnt[xMap[x]]++;
    }
  }
  flush(cur);
  return { width: W, height: H, data: out };
}

// Apply an EXIF orientation to a (small) RGBA image, so the copy stands upright
// without its EXIF block.
export function orient(img, o) {
  if (!o || o === 1) return img;
  const { width: w, height: h, data } = img;
  const swap = o >= 5;
  const W = swap ? h : w;
  const H = swap ? w : h;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sx; let sy;
      switch (o) {
        case 2: sx = w - 1 - x; sy = y; break;
        case 3: sx = w - 1 - x; sy = h - 1 - y; break;
        case 4: sx = x; sy = h - 1 - y; break;
        case 5: sx = y; sy = x; break;
        case 6: sx = y; sy = h - 1 - x; break;
        case 7: sx = w - 1 - y; sy = h - 1 - x; break;
        case 8: sx = w - 1 - y; sy = x; break;
        default: sx = x; sy = y;
      }
      const s = (sy * w + sx) * 4;
      const d = (y * W + x) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
    }
  }
  return { width: W, height: H, data: out };
}

let jpegModule;
async function loadJpeg() {
  if (jpegModule !== undefined) return jpegModule;
  try {
    const m = await import('jpeg-js');
    jpegModule = m.default || m;
  } catch { jpegModule = null; }
  return jpegModule;
}

const STEPS = [[1568, 82], [1280, 78], [1024, 74], [800, 70], [640, 66], [480, 62], [360, 60]];

/**
 * Make an image fit maxB64 base64 characters, for a vision model.
 *   → { ok: true, data, mime, downscaled, width?, height? }
 *   → { ok: false, reason: 'not-image' | 'unsupported-type' | 'too-large' | 'decode-failed' | 'no-encoder', mime }
 * The original is sent whenever it already fits and is a type the model reads.
 * Otherwise only a JPEG is re-encoded smaller (jpeg-js, pure JS): the app never
 * stores a smaller copy of a photo in the canvas file (its 320 px thumbnail is
 * rebuilt on open and never saved — KLYPIX src/canvas/file/useAnyFile.ts).
 */
export async function fitImage(buf, maxB64) {
  const mime = sniffImageMime(buf);
  if (!mime) return { ok: false, reason: 'not-image', mime: null };
  if (MODEL_IMAGE_MIME.has(mime) && b64Length(buf.length) <= maxB64) {
    return { ok: true, data: buf.toString('base64'), mime, downscaled: false };
  }
  if (mime !== 'image/jpeg') return { ok: false, reason: MODEL_IMAGE_MIME.has(mime) ? 'too-large' : 'unsupported-type', mime };
  const jpeg = await loadJpeg();
  if (!jpeg) return { ok: false, reason: 'no-encoder', mime };
  let raw;
  try {
    raw = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: LIMITS.jpegMaxMegapixels, maxMemoryUsageInMB: 1024 });
  } catch { return { ok: false, reason: 'decode-failed', mime }; }
  const orientation = exifOrientation(buf);
  let source = raw;
  for (const [edge, quality] of STEPS) {
    const scaled = downscale(source, edge);
    source = scaled; // each smaller step starts from the last, not the 12 MP original
    const upright = orient(scaled, orientation);
    let encoded;
    try { encoded = jpeg.encode({ data: upright.data, width: upright.width, height: upright.height }, quality).data; } catch { return { ok: false, reason: 'decode-failed', mime }; }
    if (b64Length(encoded.length) <= maxB64) {
      return { ok: true, data: Buffer.from(encoded).toString('base64'), mime: 'image/jpeg', downscaled: true, width: upright.width, height: upright.height };
    }
  }
  return { ok: false, reason: 'too-large', mime };
}

/** A data: URL's image bytes (KLYPIX's saved PDF preview / video poster). */
export function dataUrlImage(s) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(s || ''));
  if (!m) return null;
  try { return Buffer.from(m[2], 'base64'); } catch { return null; }
}

/** Plain-language reason an image was not attached. */
export function imageSkipReason(reason, mime) {
  if (reason === 'unsupported-type') return `${String(mime || 'this format').replace('image/', '').toUpperCase()} is not a format AI vision models take`;
  if (reason === 'too-large') return 'it is too large for this answer even as a smaller copy';
  if (reason === 'decode-failed') return 'its image data could not be decoded';
  if (reason === 'no-encoder') return 'it is too large to attach, and the smaller-copy step is not installed here';
  if (reason === 'budget') return 'this answer already carries all the image data AI apps accept in one reply (about 1 MB) — ask for this card on its own';
  if (reason === 'count') return 'this answer already carries its maximum number of images — ask for this card on its own';
  return 'it is not an image';
}

// ── Folder cards ─────────────────────────────────────────────────────────────
/**
 * A path INSIDE a folder, normalised, or null when it could point outside it
 * (.., absolute, drive letter, NUL).
 */
export function normalizeEntryPath(p) {
  const s = String(p ?? '').replace(/\\/g, '/');
  if (!s || s.includes('\u0000') || s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return null;
  const parts = s.split('/').filter(x => x !== '' && x !== '.');
  if (!parts.length || parts.some(x => x === '..')) return null;
  return parts.join('/');
}

/** Open a folder card's embedded zip. → { zip } | { tooLarge, size } | { missing } | { broken } */
export async function openFolderZip(parsed, assetId) {
  const got = await assetBytes(parsed, assetId, LIMITS.folderZipMaxBytes);
  if (!got.buf) return got;
  try { return { zip: await JSZip.loadAsync(got.buf) }; } catch { return { broken: true }; }
}

/** One entry of a folder zip by its normalised path (exact, then ignoring case). */
export function findZipEntry(zip, wanted) {
  const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
  const norm = new Map();
  for (const n of names) {
    // JSZip rewrites "../evil.txt" to "evil.txt" on load and keeps what the
    // archive really said in unsafeOriginalName: an entry whose ORIGINAL name
    // escapes the folder is never matched, under either name.
    const original = zip.files[n].unsafeOriginalName ?? n;
    const k = normalizeEntryPath(original) && normalizeEntryPath(n);
    if (k) norm.set(n, k);
  }
  for (const [n, k] of norm) if (k === wanted) return zip.files[n];
  const lower = wanted.toLowerCase();
  for (const [n, k] of norm) if (k.toLowerCase() === lower) return zip.files[n];
  return null;
}

/**
 * Read one folder-zip entry under the size and ratio caps.
 * → { buf } | { tooLarge, size } | { bomb, size, compressed }
 */
export async function readFolderEntry(entry) {
  const size = declaredSize(entry);
  const compressed = declaredCompressed(entry);
  if (size != null && compressed != null && compressed > 0 && size > LIMITS.entryRatioFloor && size / compressed > LIMITS.entryMaxRatio) {
    return { bomb: true, size, compressed };
  }
  return readEntryCapped(entry, LIMITS.entryMaxBytes);
}

/**
 * A file inside an in-place folder (bytes left on disk), only when it really
 * resolves inside that folder (symlinks and junctions included). → path | null
 */
export function resolveInPlaceEntry(folder, wanted) {
  try {
    const root = fs.realpathSync.native(folder);
    const target = fs.realpathSync.native(path.resolve(root, wanted));
    const rel = path.relative(root, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return target;
  } catch { return null; }
}
