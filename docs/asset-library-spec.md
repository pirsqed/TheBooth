# External Sound Effects & Ambient Bed Library — Mini-Spec

**Target Audience:** Antigravity (Agy) / Jeff — Stage-2 Foley & Soundscape Upgrade  
**Author:** Ellie (with Jeff)  
**Date:** 2026-11-26  
**Status:** Ready for Implementation (Zero-DB, Build-for-Ourselves-First)

---

## 1. Goal & Design Principles

Full multi-scene audio dramas (e.g., Mercury Theatre's *Dracula*) need real foley—shattering mirrors, carriage hooves, howling wind, creaking doors, rain beds—without manually hand-copying files into `DATA_DIR/assets/` or deploying a vector database.

This upgrade adds **external read-only SFX library mounting**, **zero-DB local indexing & hybrid search**, **inline asset auditioning**, and **non-destructive source-clip slicing**, while preserving The Booth's core architecture:

1. **Zero external services / zero vector DB:** Plain JSON (`assets_index.json`) + optional flat binary `Float32Array` (`assets_embeddings.f32`). Even `10,000` assets at `256`-dim embeddings take `~10.2 MB` on disk and search in `< 5 ms` in plain TypeScript (`~30.7 MB` / `< 15 ms` at `768` dims).
2. **Works 100% offline out of the box:** Filename, folder hierarchy, embedded WAV BWF/INFO/ID3/Vorbis descriptions, Universal Category System (UCS) codes, and `ffprobe` duration/channel metadata power fast BM25 keyword + duration filtering with **zero API key**.
3. **Optional Gemini enrichment (pay once, cache forever):** Incremental one-time `gemini-3.5-flash` audio captioning and/or `gemini-embedding-2` embeddings solve messy filenames and semantic queries.
4. **Search narrows the drawer; ears & visuals verify the prop:** Embeddings can confuse *acoustic twins* (soft rain vs. frying bacon, distant thunder vs. subway rumble). Adding `booth_get_asset_audio` lets agents audition top hits before committing them to a mix.
5. **100% backwards-compatible:** Existing unprefixed paths (`rain_window.wav`) continue resolving against writable `DATA_DIR/assets/`.

---

## 2. External Read-Only Mounts (`ASSET_LIBRARY_DIRS`)

Mirror the existing `ALLOWED_EXPORT_DIRS` pattern in `src/config.ts`:

### `.env` Configuration

```env
# Optional path.delimiter-separated external read-only SFX/bed library roots.
# Supports optional "alias=path" prefixes (split on first '='); otherwise auto-slugs the folder basename.
# Windows uses ';', macOS/Linux uses ':'
ASSET_LIBRARY_DIRS=sonniss=D:/SFX/SonnissGDC;nps=D:/SFX/NPS_Nature;cc0=D:/SFX/FreesoundCC0

# Optional embedding model & Matryoshka dimension (128-3072; 256 compact default, 768 recommended recall tier)
GEMINI_EMBEDDING_MODEL=gemini-embedding-2
ASSET_EMBEDDING_DIMS=256
```

### Canonical Asset Addressing & Sandboxing

- **Writable local assets (existing):** Unprefixed relative path, e.g. `rain_window.wav` or `foley/latch.wav` → resolves under `DATA_DIR/assets/`.
- **External read-only mounts (new):** Prefixed with `@<alias>/`, e.g. `@sonniss/Glass/GLASSBrk_Mirror_01.wav` → resolves strictly inside that mount's root via `assertWithinRoot`.
- **Mount alias rules:** Split `alias=path` on the first `=` only. Slugify aliases to lowercase `[a-z0-9_-]+`. Reserve `"local"` for `DATA_DIR/assets/`; colliding aliases (including `"local"`) auto-suffix (`-2`, `-3`).
- **Symlink safety:** Skip symlinks during recursive directory walks to prevent infinite recursion or escaping the mounted library root.
- **Write protection:** `uploadAsset` and `deleteAsset` reject any `@<alias>/...` path with `StoreError(..., 403)` (*"External asset libraries are read-only"*).
- **Unified resolver (`ProjectStore.resolveAssetPath` + `resolveExistingAssetFile`):** Consolidate asset resolution and extensionless fallback (`.wav`, `.ogg`, `.mp3`, `.flac`, `.m4a`—aligning `mixdown.ts` with `ALLOWED_ASSET_EXTENSIONS`) into one shared `ProjectStore` helper so `mixdown.ts`, `inspectVisual`, and `getAssetAudio` behave identically for both local and `@alias/...` paths.
- **Scoped `booth_list_assets`:** Keep `booth_list_assets` / `GET /assets` scoped to writable `DATA_DIR/assets/` by default (so mounting 10,000 external files never dumps a context bomb into an agent), and include a compact `mounts` summary (`{ alias, readOnly, indexedCount }`) pointing agents to `booth_search_assets` for external libraries.

---

## 3. Zero-DB Local Index & Optional AI Enrichment

Store index artifacts directly under `DATA_DIR/`:
- `DATA_DIR/assets_index.json` — Atomic-written manifest of all scanned assets, including top-level header metadata (`schemaVersion`, `indexedAt`, `embeddingModel`, `embeddingDims`, `embeddingRowCount`, `mounts`).
- `DATA_DIR/assets_embeddings.f32` — Optional flat binary matrix of unit-normalized `Float32` vectors (`N × dims`), aligned by row index `embeddingRow` in `assets_index.json`.

### Pass 1 — Local Scan & Metadata Extraction (Always-On, Zero API Cost)

Walk `DATA_DIR/assets/` and each configured `ASSET_LIBRARY_DIRS` root recursively (skipping hidden files, symlinks, and `.tmp`). For each supported audio file (`.wav`, `.ogg`, `.mp3`, `.flac`, `.m4a`):

1. **Incremental cache check:** Match `(assetPath, sizeBytes, mtimeMs)` against existing `assets_index.json`. Skip unchanged files so re-indexing thousands of files takes milliseconds.
2. **Probe via `ffprobe` (`probeAudioWithTags`, bounded concurrency `4–8`):**
   - `durationMs`, `sampleRate`, `channels`
   - Embedded container metadata tags (`-show_entries ...:format_tags`): `title`, `comment`, `description`, `genre`, `ICMT`, `INAM`, `IART`, `originator` — **high value**, because pro libraries (Sonniss, Boom, Sound Ideas) and BWF/RIFF/ID3/Vorbis files embed human-written foley descriptions in their headers. *(Note: `ffprobe` reliably extracts BWF `bext`, RIFF `INFO`, ID3, and Vorbis comments; WAV `iXML` XML chunks are not always exposed by `ffprobe` and can be optionally sniffed via a lightweight RIFF chunk reader in a later pass if needed.)*
3. **Filename, folder & UCS tokenization:**
   - Split camelCase, underscores, hyphens, spaces, and directory segments (`Glass/GLASSBrk_Mirror_Hard_01.wav` → `glass`, `brk`, `mirror`, `hard`).
   - Lightweight lookup table for common **UCS CatID prefixes** (`WEATRain` → `weather rain`, `DOORWood` → `door wood`, `GLASSBrk` → `glass break`, `ANMLWolf` → `animal wolf`, `Foley` / `AMB` / `WIND` / `THUN` / `FIRE` / `FOOT` / `CREAK`).
4. **Heuristic `suggestedKind`:**
   - `"sfx"` if `durationMs < 12000` (12 seconds)
   - `"bed"` if `durationMs >= 12000`
5. **Optional `catalog.json` sidecar:** If a mounted root (or `DATA_DIR/assets/`) contains a `catalog.json` mapping relative paths to `{ description?, tags?, kind?, license?, loopable? }`, merge those fields with highest priority.

### Pass 2 — Optional Gemini Enrichment (Opt-In, Cached Forever)

Triggered explicitly via `booth_index_assets` / `POST /assets/index` (never runs unexpectedly on server boot):

- **Async job support (`JobTracker`):** Cold `ffprobe` scans of thousands of files on Windows or Gemini enrichment batches can take 30–90+ seconds. Mirror `startRenderAll` / `startDirectProject` by backing `booth_index_assets` / `POST /assets/index` with `JobTracker` and an optional `wait?: boolean` parameter (default `true` for quick scans; `false` returns `{ jobId, job }` immediately for polling via `booth_get_job`).

1. **Audio Auto-Captioning (`enrichCaptions: true`, bounded `maxCaptionCount`, default `50`):**
   - Skips files that already have a cached `aiCaption` (or rich BWF/sidecar description when `onlyMissingDescriptions: true`).
   - Transcodes a lightweight preview clip (first `<= 15s`, mono 24 kHz OGG) and sends it to `GEMINI_DIRECTOR_MODEL` (`gemini-3.5-flash`) requesting strict JSON:
     ```json
     {
       "caption": "Sharp single mirror glass shatter on stone floor, short decay, dry interior",
       "tags": ["glass", "shatter", "mirror", "crash", "impact", "interior"],
       "kind": "sfx",
       "loopable": false,
       "multiVariation": false
     }
     ```
   - `multiVariation: true` flags bundled multi-hit WAVs (e.g., 5 glass breaks in one file) so agents know to visually inspect & slice with `clipStartMs` / `clipDurationMs`.
2. **Semantic Embeddings (`enrichEmbeddings: true`, requires `GEMINI_API_KEY`):**
   - Calls `GEMINI_EMBEDDING_MODEL` (`gemini-embedding-2`, `outputDimensionality: ASSET_EMBEDDING_DIMS`, `taskType: 'RETRIEVAL_DOCUMENT'`) on each asset's rich searchable text card (`path tokens + UCS + BWF description + sidecar + aiCaption + kind + duration bucket`).
   - *(Optional Phase 2 enhancement: blend or fall back to direct raw-audio embedding via `gemini-embedding-2` for completely unlabeled clips without captions.)*
   - **Consistency & compaction:** L2-normalize each vector. On load, validate that `assets_index.json` header (`embeddingModel`, `embeddingDims`) matches current config and that `assets_embeddings.f32` byte length equals `embeddingRowCount * embeddingDims * 4`; if mismatched, ignore stale vectors and emit a warning/re-embed notice instead of computing invalid scores. Whenever embeddings change or files are deleted/renamed, compact and atomically rewrite `assets_embeddings.f32` alongside `assets_index.json` (retaining cached vectors in memory for unchanged rows) so row indices never fragment or drift.

---

## 4. Hybrid Search (`booth_search_assets`)

Fast, in-memory search over `assets_index.json` (+ `assets_embeddings.f32` when present):

### Parameters
- `query` (`string`, required): Natural language or keywords (e.g., `"sharp mirror glass shatter"`, `"howling castle wind storm"`).
- `kind` (`"sfx" | "bed" | "any"`, default `"any"`): Filter by spot foley vs. ambient bed.
- `mount` (`string`, optional): Restrict to `"local"` or a specific library alias (e.g., `"sonniss"`).
- `minDurationSec` / `maxDurationSec` (`number`, optional): Crucial for separating 1-second spot hits from 60-second beds.
- `stereoOnly` (`boolean`, optional): Useful for wide ambient beds.
- `limit` (`number`, default `8`, max `25`).

### Unindexed Behavior
- If `assets_index.json` does not exist yet:
  - When **no external mounts** are configured, auto-run a fast Pass 1 scan of `DATA_DIR/assets/` so local-only setups work seamlessly out of the box.
  - When **external mounts** are configured, return `{ indexed: false, mounts, results: [], hint: "Asset index not built yet. Run booth_index_assets first." }` so a first-time search never hangs or times out scanning thousands of external files.

### Ranking
- **Offline / Text-Only:** BM25 (or TF-IDF weighted by field: `sidecar/aiCaption/bwfDescription` > `filename/tags` > `folderPath`).
- **Hybrid (when compatible embeddings exist & `GEMINI_API_KEY` is set):** Embed the query once (`outputDimensionality: ASSET_EMBEDDING_DIMS`, `taskType: 'RETRIEVAL_QUERY'`), compute brute-force cosine similarity across filtered candidates, and combine with BM25 via Reciprocal Rank Fusion (`RRF`) or weighted blend (`0.65 * cosine + 0.35 * normBm25`).
- **Response:** Compact JSON array of candidate cards:
  ```json
  {
    "assetPath": "@sonniss/Glass/GLASSBrk_Mirror_x4.wav",
    "mount": "sonniss",
    "readOnly": true,
    "durationSec": 9.42,
    "channels": 2,
    "suggestedKind": "sfx",
    "description": "Four separate small mirror shatter hits on wood/stone",
    "tags": ["glass", "mirror", "shatter", "multi_variation"],
    "multiVariation": true,
    "score": 0.87
  }
  ```
  *(Never inline raw audio bytes inside search results.)*

---

## 5. Inline Asset Auditioning (`booth_get_asset_audio`)

Right now The Booth has `booth_list_assets` and `booth_inspect_visual(target={ type: "asset", assetPath })`, but **no way to listen to an asset before placing it in a mix**.

### `booth_get_asset_audio` / `GET /assets/audio?assetPath=...`
- **Routing:** Pass `assetPath` as a query parameter on REST (`GET /assets/audio?assetPath=@sonniss/...&startSec=3.1&maxDurationSec=15`) so `@alias`, nested slashes, and spaces never collide with URL path routing.
- **Inputs:**
  - `assetPath` (`string`, required): Local or `@alias/...` path.
  - `startSec` (`number`, default `0`): Preview offset into long files. Reject `startSec >= totalDurationSec` cleanly with `StoreError(..., 400)`.
  - `maxDurationSec` (`number`, default `15`, max `30`): Caps inline audition length so a 90 MB 96 kHz WAV never hits the 10 MB MCP audio limit.
  - `inlineAudio` (`boolean`, default `true`): Include inline MCP `audio` content block.
- **Behavior:**
  - If the file is already `<= maxDurationSec`, `startSec === 0`, and `<= 4 MB`, stream/return it directly; otherwise slice/transcode to compact `audio/ogg` Opus `96k` using input-side `-ss <startSec>` **before** `-i` plus `-t <durSec>` for instant seeking in long 96 kHz field recordings.
  - Returns JSON metadata (`assetPath`, `totalDurationSec`, `previewStartSec`, `previewDurationSec`, `channels`, `sampleRate`, `inlineAudioIncluded`) + inline MCP `audio` block.
- **Workflow synergy with `booth_inspect_visual`:** For `multiVariation: true` files (e.g., 5 thunderclaps or 4 glass breaks in one WAV), an agent can call `booth_inspect_visual(target={ type: "asset", assetPath })` to see the exact timestamps of each hit, audition a single hit with `booth_get_asset_audio(startSec=3.0, maxDurationSec=2.0)`, and slice it non-destructively in Stage 2!

---

## 6. Non-Destructive Source Slicing (`clipStartMs` / `clipDurationMs`)

Commercial and CC0 SFX packs frequently store multiple hits in a single file—or put the cleanest 20-second loop in the middle of a 2-minute field recording.

### Schema Additions (`src/types/project.ts`)
Add two optional fields to both **`SfxEventSchema`** and **`BedTrackSchema`** (distinct from `BedTrack.startMs` / `endMs`, which control *timeline* placement):

```ts
clipStartMs: z.number().int().min(0).optional(),
clipDurationMs: z.number().int().positive().optional(),
```

### Script Markup (`src/script/parser.ts`)
- Support optional `clipStart` and `clipDur` attributes on both `[[sfx:...]]` and `[[bed:...]]` (accepting `s` or `ms`, reusing `parseDurationMs`).
- Support **quoted asset paths** (`"..."` or `'...'`) as well as unquoted `\S+` targets so commercial/CC0 filenames containing spaces parse cleanly:

```text
[[sfx:@sonniss/Glass/GLASSBrk_Mirror_x4.wav clipStart=3.1s clipDur=1.4s anchor=next offset=-250ms gain=-8dB pan=0.35]]
[[sfx:"@sonniss/Doors & Latches/Wood Creak 01.wav" clipStart=1.2s clipDur=1.8s gain=-6dB]]
[[bed:"@nps/Storm Wind Long.wav" clipStart=18s clipDur=45s gain=-26dB duck=-6dB]]
```

### Stage-2 FFmpeg Mixdown (`src/audio/mixdown.ts`)

1. **SFX events (`SfxEvent`):**
   - Probe source duration upfront and compute the clamped effective slice span `(sliceStartMs, effectiveDurationMs)` (emitting a mix warning if `clipStartMs >= sourceDurationMs` or if `clipStartMs + clipDurationMs` is clamped to source end).
   - Use `effectiveDurationMs` for **both** `sfxDurationsMs[evt.id]` (so project `tailMs` isn't inflated by an unused 60-second tail) **and** `afade=t=out` (`fadeOutStartSec = effectiveDurSec - fadeOutSec`) so sliced hits fade out cleanly without clicking.
   - Insert `atrim=start=${startSec}:duration=${durSec},asetpts=PTS-STARTPTS` (or `atrim=start=${startSec},asetpts=PTS-STARTPTS` if only `clipStartMs` is set) immediately after `aresample=${sampleRate}`—before gain, edge fades, pan, and `adelay`.
2. **Ambient beds (`asset_file` `BedTrack`):**
   - When neither `clipStartMs` nor `clipDurationMs` is set, preserve the existing `-stream_loop -1` input path (zero extra RAM buffering).
   - When `clipStartMs` or `clipDurationMs` **is** set:
     - Probe source duration upfront and compute the clamped slice `(sliceStartMs, sliceDurationMs)` (emitting a mix warning if `clipStartMs >= sourceDurationMs`).
     - Omit `-stream_loop -1` on the input (since `-stream_loop` before a filtergraph `atrim` would stop looping after the first trim).
     - After `aresample=${sampleRate},aformat=sample_rates=${sampleRate}:channel_layouts=stereo`, insert `atrim=start=${startSec}:duration=${sliceDurSec},asetpts=PTS-STARTPTS`.
     - If `bed.loop` is `true`, follow with `aloop=loop=-1:size=${clipSamples}` (where `clipSamples = Math.max(1, Math.round(sliceDurationMs * sampleRate / 1000))`) before the timeline `atrim=0:${bedDurationSec}`, `asetpts=PTS-STARTPTS`, volume, and edge fades.

---

## 7. New Endpoints & MCP Tools (34 → 37 Tools)

| MCP Tool | REST Endpoint | Purpose |
| :--- | :--- | :--- |
| `booth_index_assets` | `POST /assets/index` | Incremental scan of `DATA_DIR/assets/` + `ASSET_LIBRARY_DIRS`; optional `enrichCaptions` / `enrichEmbeddings` with `maxCaptionCount` cap and `JobTracker` `wait?: boolean` support |
| `booth_search_assets` | `GET /assets/search` | Zero-DB BM25 / hybrid semantic search with `kind`, `mount`, `minDurationSec`, `maxDurationSec`, `stereoOnly` filters |
| `booth_get_asset_audio` | `GET /assets/audio?assetPath=...` | Audition an asset (or `[startSec, startSec+maxDurationSec]` slice) via inline MCP `audio` block / HTTP binary stream |

Also update:
- `booth_upsert_sfx` and `booth_upsert_bed` schemas (MCP + REST) to accept optional `clipStartMs` and `clipDurationMs`.
- `GET /` root route catalog in `src/api/routes.ts`, `.env.example`, and `skills/the-booth/SKILL.md`.

---

## 8. Companion `SKILL.md` Addition (Foley Verification Guardrail)

Once shipped, add one short subsection to `skills/the-booth/SKILL.md`:

> **Foley & Acoustic-Twin Verification:** Never drop a searched SFX or ambient bed directly into a master without verification. Embeddings and filenames can confuse acoustic twins (rain vs. frying bacon, distant thunder vs. subway rumble). Always: (1) narrow candidates with `booth_search_assets` using `kind` and duration filters, (2) verify the top 1–2 hits by ear with `booth_get_asset_audio` (or corroborate `description`, `durationSec`, and `booth_inspect_visual` if your host is audio-blind), and (3) use `booth_inspect_visual` + `clipStart`/`clipDur` to cleanly isolate single hits from multi-variation WAVs.

---

## 9. Phased Rollout for Agy

1. **MVP (Unblocks *Dracula* Tonight):** `ASSET_LIBRARY_DIRS` read-only mounts + unified `resolveAssetPath`/`resolveExistingAssetFile` + scoped `booth_list_assets` with `mounts` summary + Pass 1 local scanner (`probeAudioWithTags` + BWF/INFO/ID3/Vorbis + UCS + `catalog.json`, `JobTracker`-backed) + offline BM25 `booth_search_assets` + `booth_get_asset_audio` (fast `-ss` seeking) + `clipStartMs`/`clipDurationMs` in schema/parser (with quoted paths)/mixdown (SFX effective fades + sliced `aloop` beds).
2. **Semantic Layer (Fast Follow):** Pass 2 optional `enrichCaptions` (`gemini-3.5-flash`) + `enrichEmbeddings` (`gemini-embedding-2`, `RETRIEVAL_DOCUMENT`/`RETRIEVAL_QUERY`, atomic compacted `assets_embeddings.f32` with header validation) + hybrid RRF ranking.
3. **Tests:** Unit tests for `@alias` sandboxing, reserved `"local"` alias & read-only rejection, quoted paths with spaces in `parser.ts`, UCS/BM25 ranking, flat `.f32` cosine math & header/length mismatch detection, `clipStartMs`/`clipDurationMs` filtergraph slicing (including SFX fade-out timing and sliced looped `aloop` beds), and `booth_get_asset_audio` slicing under the 10 MB inline cap.
