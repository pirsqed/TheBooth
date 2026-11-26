# REST API Reference

The Booth exposes a local **Fastify** HTTP API (default `http://127.0.0.1:3480`) backed by the exact same `StudioService` layer as the MCP server. All JSON bodies are strictly validated with Zod; audio and visual inspection routes stream binary media directly.

Start the server with:

```bash
npm run dev    # watch mode
# or
npm run build && npm start
```

---

## Health & Discovery

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/` | Service status, version, and endpoint index |
| `GET` | `/health` | Lightweight health check (`{ status: "ok", service: "the-booth", version }`) |

---

## Projects

| Method | Path | Description |
| :--- | :--- | :--- |
| `POST` | `/projects` | Create a project (initializes default `warm_dark` room tone unless `includeDefaultRoomTone: false`) |
| `GET` | `/projects` | List all projects with summary counts (`cueCount`, `renderedCueCount`, `exportCount`) |
| `GET` | `/projects/:id` | Fetch full `project.json` manifest + resolved timeline (`startMs`, `endMs` for every cue and SFX) |
| `PATCH` | `/projects/:id` | Update `name` or Stage-2 `audio` settings |
| `DELETE` | `/projects/:id` | Permanently delete a project and its takes/exports (`204 No Content`) |

### Master `audio` Settings (`POST /projects` & `PATCH /projects/:id`)

| Field | Default | Range / Values | Notes |
| :--- | :--- | :--- | :--- |
| `autoLevel` | `"gentle"` | `"gentle" \| "match" \| "off"` | Stage-2 non-destructive clip leveling |
| `workingTakeLufs` | `-20` | `-36` to `-6` | Target LUFS reference for `autoLevel` |
| `masterNormalize` | `false` | `boolean` | Keep `false` to preserve quiet fade-outs; set `true` for loudness-normalized masters |
| `masterTargetLufs` | `-18` | `-36` to `-6` | Target LUFS when `masterNormalize: true` |
| `truePeakCeilingDb` | `-1.5` | `-6` to `0` | True-peak limiter ceiling (`dBTP`) |
| `headphoneCrossfeed` | `true` | `boolean` | Phase-pure near-to-far head-shadow crossfeed on panned stems |
| `tailMs` | `2000` | `0` to `30000` | Quiet room-tone/bed tail appended after the final cue or SFX |

---

## Voices, Script Import & Cues

| Method | Path | Description |
| :--- | :--- | :--- |
| `PUT` | `/projects/:id/voices/:voiceId` | Register or update a speaker voice profile (`label`, `provider`, `providerVoiceId`, `defaultDirection`, `defaultEqPreset`, `defaultPan`, `notes`) |
| `POST` | `/projects/:id/import-script` | Compile tagged script into cues, beds, and SFX (`{ script, mode: "replace" \| "append", defaultSpeaker?, maxChunkBytes? }`) |
| `POST` | `/projects/:id/cues` | Insert a single cue (`speaker`, `text`, `direction?`, `timing?`, `mix?`, `insertAtIndex?`) |
| `PATCH` | `/projects/:id/cues/:cueId` | Edit text, direction, timing (`afterCueId`, `offsetMs`), Stage-2 `mix` (`gainDb`, `pan`, `eqPreset`, `autoLevel`, `fadeInMs`, `fadeOutMs`), or swap `activeTakeId` |
| `DELETE` | `/projects/:id/cues/:cueId` | Delete a cue (safely re-anchoring dependent cues and SFX) |

---

## Stage 1 — Synthesis & Jobs

| Method | Path | Description |
| :--- | :--- | :--- |
| `POST` | `/projects/:id/cues/:cueId/render` | Synthesize a new immutable raw WAV take for one cue (`{ activate?: true, model? }`) |
| `POST` | `/projects/:id/render-all` | Synthesize all cues missing an active take or with a stale `textHash` (`{ concurrency?: 2, force?: false, wait?: false }`). Returns `202` with `{ jobId, job }` (or `200` when `wait: true`) |
| `GET` | `/jobs/:jobId` | Poll progress, completed count, errors, and results for an async `render-all` or `direct` job |
| `GET` | `/projects/:id/cues/:cueId/takes/:takeId/audio` | Stream immutable raw take WAV (`Content-Type: audio/wav`) |

---

## Beds, SFX & Shared Asset Library

All asset paths are sandboxed under `DATA_DIR/assets/` (path traversal is rejected) and validated via `ffprobe` on upload.

| Method | Path | Description |
| :--- | :--- | :--- |
| `PUT` | `/projects/:id/beds/:bedId` | Add or update a `synthetic_room_tone` or `asset_file` background bed with ducking settings |
| `DELETE` | `/projects/:id/beds/:bedId` | Remove a bed track |
| `PUT` | `/projects/:id/sfx/:sfxId` | Add or update a spot SFX anchored to a cue edge (`start` / `end`) or absolute `t=0` |
| `DELETE` | `/projects/:id/sfx/:sfxId` | Remove a spot SFX event |
| `GET` | `/assets` | List all audio files in `DATA_DIR/assets/` |
| `POST` | `/assets` | Upload an asset as JSON (`{ assetPath, dataBase64 }`) |
| `PUT` | `/assets/*` | Upload an asset as raw binary body (`Content-Type: audio/wav` or `application/octet-stream`) |
| `DELETE` | `/assets/*` | Delete an asset from `DATA_DIR/assets/` (`204 No Content`) |

---

## Stage 2 — Mixdown & Visual-Audio QC

| Method | Path | Description |
| :--- | :--- | :--- |
| `POST` | `/projects/:id/mix` | Run deterministic local FFmpeg stereo mixdown (`{ format?: "ogg" \| "wav" \| "mp3" }`, default `"ogg"`). Returns `{ export, telemetry }` including LUFS, true peak, per-channel L/R RMS, and warnings |
| `GET` | `/projects/:id/exports/:exportId/audio` | Stream or download the finished master (`audio/ogg`, `audio/wav`, or `audio/mpeg`) |
| `GET` | `/projects/:id/exports/:exportId/visual` | Render visual-audio QC chart for a master export |
| `GET` | `/projects/:id/cues/:cueId/takes/:takeId/visual` | Render visual-audio QC chart for a single take |
| `GET` | `/projects/:id/voices/:voiceId/auditions/:auditionId/visual` | Render visual-audio QC chart for a voice audition |

### Visual QC Query Parameters (`/visual`)

| Query Param | Values / Default | Description |
| :--- | :--- | :--- |
| `preset` | `"master"` *(default)* \| `"fast"` | `"master"` renders the 4-panel `1600×900` DAW + L/R Waveform + 300 ms RMS + Log-Mel Spectrogram; `"fast"` uses pure FFmpeg (`showwavespic` + `showspectrumpic`) |
| `mode` | `"zoom"` *(default)* \| `"overview"` | `"zoom"` caps spans at `<= 45s` (`>= 30 px/s`) for seam/dropout/overlap QC; `"overview"` covers `180s+` macro arcs & click spotting |
| `startSec` / `endSec` | `number >= 0` | Optional time window in seconds |
| `panels` | comma-separated (`cues,waveform,rms,spectrogram`) | Optional panel subset for `preset=master` |
| `format` | `"png"` *(default)* \| `"json"` | `"png"` streams `image/png` with `X-Booth-Window`, `X-Booth-Px-Per-Sec`, and `X-Booth-Warnings` headers; `"json"` returns metadata + `imageBase64` |

---

## Voice Catalog, Voice Design & Auditions

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/providers/:provider/voices` | Browse & filter provider voices. Supports query params `type`, `languageCode`, `regionCode`, `accent`, `gender`, `pitch`, `persona`, `contexts`, `search`, `pageSize`, `pageToken` |
| `GET` | `/providers/:provider/voices/:voiceId` | Get metadata and preview availability for a stored custom voice |
| `GET` | `/providers/:provider/voices/:voiceId/preview` | Stream cached `sample_audio` WAV preview for a custom voice |
| `DELETE` | `/providers/:provider/voices/:voiceId` | Permanently delete a stored custom voice from the provider and remove its local preview |
| `POST` | `/voices/design` | Design a new persistent custom voice (or remix `baseVoice`) via Gemini's `v1beta` Voices API |
| `POST` | `/projects/:id/voices/:voiceId/audition` | Generate audition WAV clips for `1–10` candidate `providerVoiceId`s (`{ candidateVoiceIds, sampleText, direction?, notes? }`) |
| `GET` | `/projects/:id/voices/:voiceId/auditions/:auditionId/audio` | Stream an audition WAV clip |
| `POST` | `/projects/:id/voices/:voiceId/auditions/:auditionId/select` | Cast an audition's `providerVoiceId` onto the project voice profile |

---

## Director's Chair

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/director/personas` | List built-in Director personas (`default`, `intimate_sleep`, `audio_drama`, `audiobook`) |
| `POST` | `/projects/:id/cues/:cueId/direct` | Run the multimodal Director ear-review + bounded retake loop on one cue (`{ persona?, extraInstructions?, maxRetakes?, allowMixAdjustments?, allowTextTagTweaks?, ttsModel? }`) |
| `POST` | `/projects/:id/direct` | Run the bounded Director review loop across cues in a project (`{ cueIds?, persona?, extraInstructions?, maxRetakes?, maxTotalRetakes?, allowMixAdjustments?, allowTextTagTweaks?, ttsModel?, wait? }`). Returns `202` with `{ jobId, job }` unless `wait: true` |

---

## Error Format

Validation errors (Zod) return HTTP `400`; missing resources return `404`; invalid FFmpeg/timeline graphs (such as cyclic `afterCueId` references) return `400`. All error responses follow JSON `{ "error": "..." }` (plus validation details when applicable).
