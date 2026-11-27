# Connecting to The Booth via MCP

**The Booth** ships a native **Model Context Protocol (MCP)** stdio server wrapping the exact same `StudioService` core as the REST API (`src/studio/service.ts`). Any MCP-compatible host—including Claude Desktop, Cursor, or custom agent runtimes—can drive the full audio studio directly over stdio.

---

## 1. Prerequisites

1. **Node.js 22+** and **FFmpeg / FFprobe** on your `PATH` (or configured via `FFMPEG_PATH` / `FFPROBE_PATH`).
2. **Build once** (recommended for fastest startup and lowest overhead):
   ```bash
   npm install
   npm run build
   ```
3. **Environment variables** — either place a `.env` file in the `TheBooth` repo root (loaded automatically when `cwd` is set to the repo directory) or pass them in your MCP host's `env` block:

| Variable | Required | Default | Purpose |
| :--- | :--- | :--- | :--- |
| `GEMINI_API_KEY` | For live Gemini TTS / Director | *(falls back to `mock`)* | Google AI Studio key (`generativelanguage.googleapis.com`) |
| `DATA_DIR` | No | `./data` | Root directory for `projects/` and shared `assets/` |
| `FFMPEG_PATH` | No | `ffmpeg` | Custom path to `ffmpeg` binary |
| `FFPROBE_PATH` | No | `ffprobe` | Custom path to `ffprobe` binary |
| `GEMINI_TTS_MODEL` | No | `gemini-3.8-flash-tts` | Default Gemini TTS model |
| `GEMINI_DIRECTOR_MODEL` | No | `gemini-3.5-flash` | Default multimodal Director reviewer model |
| `GEMINI_SAFETY_THRESHOLD` | No | `off` | Gemini Developer API safety threshold (`off`, `block_only_high`, etc.) |
| `ALLOW_CUSTOM_FFMPEG_FILTER` | No | `false` | Opt-in flag for per-cue `customFfmpegFilter` |
| `ALLOWED_EXPORT_DIRS` | No | *(unrestricted)* | Optional path-delimiter-separated root directories restricting `booth_mix` `outputPath` delivery |
| `ASSET_LIBRARY_DIRS` | No | *(unset)* | Optional path-delimiter-separated external read-only SFX/bed library roots (`alias=path` or bare path; `;` on Windows, `:` on macOS/Linux) |
| `GEMINI_EMBEDDING_MODEL` | No | `gemini-embedding-2` | Optional Gemini embedding model for hybrid semantic asset search |
| `ASSET_EMBEDDING_DIMS` | No | `256` | Matryoshka embedding dimensions (`128–3072`; `256` compact default, `768` recommended recall tier) |

> **Shared Storage Note:** The REST server (`npm run dev` / `npm start`) and MCP server (`npm run mcp:start`) share the same `DATA_DIR` filesystem layout (`project.json` atomic writes + flat immutable `takes/<takeId>.wav`), so projects created over MCP are immediately inspectable via REST (and vice versa). Avoid running concurrent writes against the exact same project ID from two separate OS processes at the same millisecond.

---

## 2. Client Configuration (Stdio Transport)

### Recommended (Compiled `dist/mcp/index.js`)

Use this in your MCP client config (`mcpServers` JSON):

```json
{
  "mcpServers": {
    "the-booth": {
      "command": "node",
      "args": ["/path/to/TheBooth/dist/mcp/index.js"],
      "cwd": "/path/to/TheBooth",
      "env": {
        "DATA_DIR": "/path/to/TheBooth/data"
      }
    }
  }
}
```

*(If `GEMINI_API_KEY` is already in `/path/to/TheBooth/.env`, `dotenv` loads it automatically because `cwd` is set. Otherwise, add `"GEMINI_API_KEY": "..."` inside `env`.)*

### Development Mode (No Build Step Required)

```json
{
  "mcpServers": {
    "the-booth": {
      "command": "npx",
      "args": ["tsx", "src/mcp/index.ts"],
      "cwd": "/path/to/TheBooth"
    }
  }
}
```

### Stdio Hygiene
- `stdout` carries **strictly JSON-RPC frames**.
- All diagnostic startup logs go to `stderr` (`[the-booth-mcp] connected on stdio ...`), so hosts parsing `stdout` will never see log corruption.

---

## 3. Quick Connection Smoke Test (Node / TypeScript)

If you're building MCP client support in your own agent host, here's the minimal `@modelcontextprotocol/sdk` client snippet to connect over stdio and list all 40 tools:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/mcp/index.js'],
  cwd: '/path/to/TheBooth',
});

const client = new Client({ name: 'my-agent-host', version: '0.1.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`Connected! ${tools.length} tools available:`, tools.map((t) => t.name));

const res = await client.callTool({
  name: 'booth_list_projects',
  arguments: {},
});
console.log(res.content);

await client.close();
```

---

## 4. Available MCP Tools (40 Total)

All tools return JSON inside a `text` content block (and set `isError: true` with `{ "error": "..." }` on validation or domain errors without crashing the transport).

### Projects & Voices
| Tool | Purpose |
| :--- | :--- |
| `booth_create_project` | Create a new project (auto-initializes subtle `warm_dark` room tone & acoustic defaults) |
| `booth_list_projects` | List all projects with cue/render/export counts |
| `booth_get_project` | Get full `project.json` manifest + resolved timeline `(startMs, endMs)` timestamps |
| `booth_update_project` | Update project name or Stage-2 audio settings (`autoLevel`, `headphoneCrossfeed`, `masterNormalize`, `leadInMs`, `tailMs`, etc.) |
| `booth_delete_project` | Permanently delete a project |
| `booth_upsert_voice` | Register or update a voice profile (`provider`, `providerVoiceId`, `defaultDirection`, `defaultEqPreset`, `defaultPan`) |

### Script Authoring & Timeline Cues
| Tool | Purpose |
| :--- | :--- |
| `booth_import_script` | Parse tagged script (`[[pause]]`, `[[overlap]]`, `[[dir]]`, `[[gain]]`, `[[pan]]`, `[[eq]]`, `[[bed]]`, `[[sfx]]`); `mode: "replace"` preserves matching takes by `textHash` |
| `booth_add_cue` | Insert a single cue onto the timeline |
| `booth_update_cue` | Edit text, direction, timing, Stage-2 mix controls (including non-destructive `trim: { startMs, endMs }`), or swap `activeTakeId` |
| `booth_delete_cue` | Delete a cue (safely re-anchoring dependent cues & SFX) |
| `booth_split_cue` | Non-destructively split a rendered cue at playhead `atMs` into two sequential cues sharing the same raw take, inserting `gapMs` of warm room tone with zero TTS re-synthesis |

### Stage 1 — Synthesis & Multimodal Ear Review
| Tool | Purpose |
| :--- | :--- |
| `booth_render_take` | Synthesize one immutable raw WAV take + Stage-1 loudness telemetry (`measuredLufs`, `measuredRmsDbfs`, `peakDbfs`) |
| `booth_render_all` | Render all missing/stale cues with bounded concurrency (returns `jobId` immediately unless `wait: true`) |
| `booth_job_status` | Poll progress/errors/results for async `booth_render_all`, `booth_direct_project`, or `booth_index_assets` jobs |
| `booth_get_take_audio` | Fetch raw take metadata + inline MCP `audio` block (`audio/wav`) for multimodal listening |

### Beds, SFX & Shared Asset Library
| Tool | Purpose |
| :--- | :--- |
| `booth_upsert_bed` / `booth_delete_bed` | Manage synthetic room-tone or looped ambient bed tracks with speech sidechain ducking, cue-anchored (`startCueId`/`endCueId`) or raw-ms spans, and optional non-destructive source slicing (`clipStartMs`, `clipDurationMs`) |
| `booth_upsert_sfx` / `booth_delete_sfx` | Manage cue-anchored or timestamp-anchored spot SFX with optional non-destructive source slicing (`clipStartMs`, `clipDurationMs`) |
| `booth_list_assets` | List writable local audio files under `DATA_DIR/assets/` plus a compact summary of configured read-only external library `mounts` |
| `booth_index_assets` | Incrementally scan `DATA_DIR/assets/` + `ASSET_LIBRARY_DIRS` (`ffprobe` + `astats` `rmsDbfs`/`peakDbfs` + BWF/INFO/ID3/Vorbis tags + UCS + `catalog.json`); optional opt-in Gemini captioning & `gemini-embedding-2` vectors (`wait: false` returns a `jobId` for `booth_job_status`) |
| `booth_search_assets` | Zero-DB offline BM25 / hybrid semantic search across local and `@<alias>/...` libraries with `kind`, `mount`, `minDurationSec`, `maxDurationSec`, and `stereoOnly` filters (returns native `rmsDbfs`/`peakDbfs` loudness telemetry) |
| `booth_get_asset_audio` | Audition a local or `@<alias>/...` asset (or `[startSec, startSec+maxDurationSec]` slice) via inline MCP `audio` block plus local `filePath` and cached `previewAudioPath` to verify foley and rule out acoustic twins |
| `booth_upload_asset` | Upload base64 audio (`.wav`, `.ogg`, `.mp3`, `.flac`, `.m4a`) into writable `DATA_DIR/assets/`; validated via `ffprobe` before saving (`403` on read-only `@alias/` paths) |
| `booth_delete_asset` | Remove an asset from writable `DATA_DIR/assets/` (`403` on read-only `@alias/` paths) |

### Stage 2 — Deterministic Local Mixdown & Visual-Audio QC
| Tool | Purpose |
| :--- | :--- |
| `booth_mix` | Run local FFmpeg stereo mixdown (`ogg`, `wav`, or `mp3`) at zero API cost; returns export record + LUFS/true-peak/L-R RMS telemetry. Pass optional `outputPath` to deliver a copy into your workspace, or `fromCueId`/`toCueId` (`startSec`/`endSec`) for a scene-scoped partial mixdown |
| `booth_get_export_audio` | Fetch finished master metadata + inline MCP `audio` block (`audio/ogg`, `audio/wav`, `audio/mpeg`) |
| `booth_inspect_visual` | Render calibrated `1600×900` visual-audio QC chart + inline MCP `image/png` block. Default `preset: "master"` renders the 4-panel stack (DAW Cue + SFX Overlay + Split L/R Waveforms + Split L/R & Combined 300ms RMS on 3 dB grid + Log-Mel Spectrogram); `preset: "fast"` runs pure FFmpeg (`showwavespic` + `showspectrumpic`). Default `mode: "zoom"` caps spans at `<= 45s` (`>= 30 px/s`) for seam/dropout/overlap QC; `mode: "overview"` supports `180s+` macro arcs & click spotting. *Usage guardrail: inspect 1–2 charts per turn and always pair ears + eyes on final mixes.* |

### Casting, Auditioning & Director's Chair
| Tool | Purpose |
| :--- | :--- |
| `booth_list_provider_voices` | List & filter custom stored voices and prebuilt/Extended Voice Library voices (`type`, `languageCode`, `accent`, `gender`, `pitch`, `persona`, `contexts`, `search`, pagination) |
| `booth_design_voice` | Design a custom persistent voice (or remix `baseVoice`) via Gemini's `v1beta` Voices API; caches preview WAV and returns clean JSON metadata + inline MCP `audio` block |
| `booth_get_provider_voice` | Inspect metadata and listen to `sample_audio` preview of a stored custom voice (`voice_...`) via inline MCP `audio` block |
| `booth_delete_provider_voice` | Permanently delete a stored custom voice from the provider (reclaiming Gemini's 200-voice quota) and remove its local cached preview |
| `booth_audition_voice` | Synthesize labeled audition clips (`"A"`, `"B"`, ...) for candidate `providerVoiceId`s and auto-render a loudness-matched playable A/B casting reel (with optional `reelOutputPath`) |
| `booth_render_audition_reel` | Stitch a role's auditions into a single loudness-matched labeled A/B reel (`"A"`, `"B"`, ...) with optional `outputPath` delivery + inline audio |
| `booth_get_audition_audio` | Listen to an individual audition WAV via inline MCP `audio` block |
| `booth_select_audition` | Cast an auditioned candidate voice onto a project voice profile by friendly reel label (`"A"`, `"B"`) OR exact audition ID |
| `booth_render_ab_reel` | Play multiple takes of a cue **in context** (with preceding lead-in / following cues) as a single loudness-matched labeled A/B stereo comparison reel (`outputPath` + inline audio) |
| `booth_list_director_personas` | List built-in Director personas (`default`, `intimate_sleep`, `audio_drama`, `audiobook`) |
| `booth_direct_cue` | Run the multimodal Director review + bounded retake loop on one cue (supports built-in or custom `persona`) |
| `booth_direct_project` | Run the bounded Director review loop across project cues (with per-cue & `maxTotalRetakes` caps) |

---

## 5. Audio Content Blocks & Size Limits

`booth_get_take_audio`, `booth_get_export_audio`, `booth_get_audition_audio`, `booth_get_asset_audio`, `booth_design_voice`, `booth_get_provider_voice`, `booth_render_audition_reel`, and `booth_render_ab_reel` return **two content blocks**:
1. A `text` block containing JSON metadata (`filePath` / `previewAudioPath` / `reelPath`, `sizeBytes`, telemetry, and `inlineAudioIncluded`).
2. An MCP `audio` block (`{ type: "audio", data: "<base64>", mimeType: "audio/..." }`) automatically included whenever the file is **<= 10 MB** and `inlineAudio` is not set to `false`.

For long masters (> 10 MB), prefer mixing to `format: "ogg"` (Opus 128 kbps fits ~10 minutes in 10 MB) or pass `inlineAudio: false` and read from `filePath` directly. For long external SFX/bed recordings, `booth_get_asset_audio` automatically slices and transcodes previews (`maxDurationSec` default `15`, max `30`) to compact OGG Opus `96k` cached under `DATA_DIR/asset_previews/`, returning both the original `filePath` and `previewAudioPath` so auditioning never hits the 10 MB cap. If your MCP host strips or offloads inline audio/image blocks, pass `inlineAudio: false` / `inlineImage: false` to save base64 overhead and open the returned local path with your native multimodal file reader.

---

## 6. Runtime Idle Resource (`booth://runtime/idle`)

The MCP server also registers a `studio-idle` resource at `booth://runtime/idle` returning `application/json`:

```json
{ "idle": true }
```

Orchestrators and process supervisors can read this resource before shutting down or restarting the stdio process to verify that no tool calls or background jobs (`booth_render_all`, `booth_direct_project`, `booth_index_assets`) are currently in flight.

---

## Related Guides

- [Script Markup & Authoring Guide](./script-markup.md)
- [REST API Reference](./rest-api.md)
- [Casting, Director's Chair & Visual-Audio QC](./directing-and-qc.md)
- [Margaux Laurent Director Persona](../directors/margaux_auteur.md)
