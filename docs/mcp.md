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

If you're building MCP client support in your own agent host, here's the minimal `@modelcontextprotocol/sdk` client snippet to connect over stdio and list all 34 tools:

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

## 4. Available MCP Tools (34 Total)

All tools return JSON inside a `text` content block (and set `isError: true` with `{ "error": "..." }` on validation or domain errors without crashing the transport).

### Projects & Voices
| Tool | Purpose |
| :--- | :--- |
| `booth_create_project` | Create a new project (auto-initializes subtle `warm_dark` room tone & acoustic defaults) |
| `booth_list_projects` | List all projects with cue/render/export counts |
| `booth_get_project` | Get full `project.json` manifest + resolved timeline `(startMs, endMs)` timestamps |
| `booth_update_project` | Update project name or Stage-2 audio settings (`autoLevel`, `headphoneCrossfeed`, `masterNormalize`, `tailMs`, etc.) |
| `booth_delete_project` | Permanently delete a project |
| `booth_upsert_voice` | Register or update a voice profile (`provider`, `providerVoiceId`, `defaultDirection`, `defaultEqPreset`, `defaultPan`) |

### Script Authoring & Timeline Cues
| Tool | Purpose |
| :--- | :--- |
| `booth_import_script` | Parse tagged script (`[[pause]]`, `[[overlap]]`, `[[dir]]`, `[[gain]]`, `[[pan]]`, `[[eq]]`, `[[bed]]`, `[[sfx]]`); `mode: "replace"` preserves matching takes by `textHash` |
| `booth_add_cue` | Insert a single cue onto the timeline |
| `booth_update_cue` | Edit text, direction, timing, Stage-2 mix controls, or swap `activeTakeId` |
| `booth_delete_cue` | Delete a cue (safely re-anchoring dependent cues & SFX) |

### Stage 1 — Synthesis & Multimodal Ear Review
| Tool | Purpose |
| :--- | :--- |
| `booth_render_take` | Synthesize one immutable raw WAV take + Stage-1 loudness telemetry (`measuredLufs`, `measuredRmsDbfs`, `peakDbfs`) |
| `booth_render_all` | Render all missing/stale cues with bounded concurrency (returns `jobId` immediately unless `wait: true`) |
| `booth_job_status` | Poll progress/errors/results for async `booth_render_all` or `booth_direct_project` jobs |
| `booth_get_take_audio` | Fetch raw take metadata + inline MCP `audio` block (`audio/wav`) for multimodal listening |

### Beds, SFX & Shared Asset Library
| Tool | Purpose |
| :--- | :--- |
| `booth_upsert_bed` / `booth_delete_bed` | Manage synthetic room-tone or looped ambient bed tracks with speech sidechain ducking |
| `booth_upsert_sfx` / `booth_delete_sfx` | Manage cue-anchored or timestamp-anchored spot SFX |
| `booth_list_assets` | List reusable audio files stored under `DATA_DIR/assets/` |
| `booth_upload_asset` | Upload base64 audio (`.wav`, `.ogg`, `.mp3`, `.flac`, `.m4a`); validated via `ffprobe` before saving |
| `booth_delete_asset` | Remove an asset from `DATA_DIR/assets/` |

### Stage 2 — Deterministic Local Mixdown & Visual-Audio QC
| Tool | Purpose |
| :--- | :--- |
| `booth_mix` | Run local FFmpeg stereo mixdown (`ogg`, `wav`, or `mp3`) at zero API cost; returns export record + LUFS/true-peak/L-R RMS telemetry |
| `booth_get_export_audio` | Fetch finished master metadata + inline MCP `audio` block (`audio/ogg`, `audio/wav`, `audio/mpeg`) |
| `booth_inspect_visual` | Render calibrated `1600×900` visual-audio QC chart + inline MCP `image/png` block. Default `preset: "master"` renders the 4-panel stack (DAW Cue Overlay + Split L/R Waveforms + Split L/R & Combined 300ms RMS on 3 dB grid + Log-Mel Spectrogram); `preset: "fast"` runs pure FFmpeg (`showwavespic` + `showspectrumpic`). Default `mode: "zoom"` caps spans at `<= 45s` (`>= 30 px/s`) for seam/dropout/overlap QC; `mode: "overview"` supports `180s+` macro arcs & click spotting. *Usage guardrail: inspect 1–2 charts per turn and always pair ears + eyes on final mixes.* |

### Casting, Auditioning & Director's Chair
| Tool | Purpose |
| :--- | :--- |
| `booth_list_provider_voices` | List & filter custom stored voices and prebuilt/Extended Voice Library voices (`type`, `languageCode`, `accent`, `gender`, `pitch`, `persona`, `contexts`, `search`, pagination) |
| `booth_design_voice` | Design a custom persistent voice (or remix `baseVoice`) via Gemini's `v1beta` Voices API; caches preview WAV and returns clean JSON metadata + inline MCP `audio` block |
| `booth_get_provider_voice` | Inspect metadata and listen to `sample_audio` preview of a stored custom voice (`voice_...`) via inline MCP `audio` block |
| `booth_delete_provider_voice` | Permanently delete a stored custom voice from the provider (reclaiming Gemini's 200-voice quota) and remove its local cached preview |
| `booth_audition_voice` | Synthesize audition clips for candidate `providerVoiceId`s |
| `booth_get_audition_audio` | Listen to an audition WAV via inline MCP `audio` block |
| `booth_select_audition` | Cast an audition's `providerVoiceId` onto a project voice profile |
| `booth_list_director_personas` | List built-in Director personas (`default`, `intimate_sleep`, `audio_drama`, `audiobook`) |
| `booth_direct_cue` | Run the multimodal Director review + bounded retake loop on one cue (supports built-in or custom `persona`) |
| `booth_direct_project` | Run the bounded Director review loop across project cues (with per-cue & `maxTotalRetakes` caps) |

---

## 5. Audio Content Blocks & Size Limits

`booth_get_take_audio`, `booth_get_export_audio`, `booth_get_audition_audio`, `booth_design_voice`, and `booth_get_provider_voice` return **two content blocks**:
1. A `text` block containing JSON metadata (`filePath`, `sizeBytes`, telemetry, and `inlineAudioIncluded`).
2. An MCP `audio` block (`{ type: "audio", data: "<base64>", mimeType: "audio/..." }`) automatically included whenever the file is **<= 10 MB** and `inlineAudio` is not set to `false`.

For long masters (> 10 MB), prefer mixing to `format: "ogg"` (Opus 128 kbps fits ~10 minutes in 10 MB) or pass `inlineAudio: false` and read from `filePath` directly.

---

## 6. Runtime Idle Resource (`booth://runtime/idle`)

The MCP server also registers a `studio-idle` resource at `booth://runtime/idle` returning `application/json`:

```json
{ "idle": true }
```

Orchestrators and process supervisors can read this resource before shutting down or restarting the stdio process to verify that no tool calls or background jobs (`booth_render_all`, `booth_direct_project`) are currently in flight.

---

## Related Guides

- [Script Markup & Authoring Guide](./script-markup.md)
- [REST API Reference](./rest-api.md)
- [Casting, Director's Chair & Visual-Audio QC](./directing-and-qc.md)
- [Margaux Laurent Director Persona](../directors/margaux_auteur.md)
