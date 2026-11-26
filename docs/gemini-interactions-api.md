# Gemini Interactions API — General Reference

> Verified directly against Google's official Gemini API documentation via the Gemini Docs MCP server (`aistudio.google.com/docs`, November 2026). Covers the GA `v1` & `v1beta` Interactions API, the `steps` schema, streaming, safety settings, current models/agents, and how it maps to **The Booth**'s [SPEC.md](../SPEC.md).

Canonical official docs:
- Interactions API overview: https://aistudio.google.com/docs/interactions-overview.md
- API reference: https://aistudio.google.com/api-reference/interactions-api.md
- OpenAPI spec: https://aistudio.google.com/api-reference/interactions.openapi.json
- Streaming guide: https://aistudio.google.com/docs/streaming.md
- Safety settings: https://aistudio.google.com/docs/safety-settings.md
- May 2026 breaking changes migration guide: https://aistudio.google.com/docs/interactions-breaking-changes-may-2026.md

---

## 1. Overview, GA Status & SDK Setup

The **Interactions API** has been **Generally Available (GA) on `v1`** since June 2026 and is Google's default, recommended interface for all new projects (`generateContent` remains supported but is considered legacy).

### Current SDKs
- **JavaScript / TypeScript:** `@google/genai >= 3.5.0` (`npm install @google/genai`)
- **Python:** `google-genai >= 3.5.0` (`pip install -U google-genai`)
- SDKs `>= 3.0.0` default to stable **`v1`** and automatically use the modern `steps` + `response_format` schema.
- Never use legacy `@google/generative-ai` / `google-generativeai`.

### When to Use `v1` vs. `v1beta`

| Surface | API Version |
| :--- | :--- |
| Mainline text/multimodal models (`gemini-4-*`, `gemini-3.5-flash-lite`) | `v1` (SDK default) |
| **Gemini 3.8 TTS & Voices API (`/v1beta/voices`)** | **`v1beta`** |
| Managed Agents (`antigravity-preview-09-2026`, `deep-research-*`, `client.agents`) | `v1beta` |
| Decisions API (`gemini-decision-1`, `client.decisions.create`) | `v1beta` |
| Live Interactions (`models/genie-4`, `interactions.connect()`) | `v1beta` |

Opt into `v1beta` in TypeScript via:
```ts
import { GoogleGenAI } from '@google/genai';

// Standard v1 client (for mainline models)
const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// v1beta client (required for Gemini 3.8 TTS, Voices API, Managed Agents, Decisions)
const betaClient = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { apiVersion: 'v1beta' }, // or top-level { apiVersion: 'v1beta' } in >= 3.x
});
// Alternatively: per-call api_version: 'v1beta' or env GOOGLE_GENAI_API_VERSION=beta
```

### Current Models & Managed Agents (Quick Reference)
- **Frontier & mainline:** `gemini-4-carbon`, `gemini-4-neon`, `gemini-4-argon`, `gemini-4-hydrogen`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`
- **Audio & speech:** `gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts`, `gemini-3.5-transcribe`, `lyria-3.5` (music)
- **Image & video:** `gemini-nano-banana-2.1`, `gemini-3-pro-image`, `gemini-omni-1.2-flash`
- **Decisions & embeddings:** `gemini-decision-1`, `gemini-embedding-2`, `gemini-embedding-001`
- **Managed agents (`v1beta`):** `antigravity-preview-09-2026`, `deep-research-preview-04-2026`, `deep-research-max-preview-04-2026`, plus custom agents via `client.agents.create()`

---

## 2. Core REST Endpoints & Headers

Base URL: `https://generativelanguage.googleapis.com`

| Action | REST Endpoint (`v1` or `v1beta`) | SDK (`@google/genai`) |
| :--- | :--- | :--- |
| **Create interaction** | `POST /v1/interactions` (or `/v1beta/interactions`) | `client.interactions.create(params)` |
| **Get interaction** | `GET /v1/interactions/{id}` | `client.interactions.get(id)` |
| **Cancel interaction** | `POST /v1/interactions/{id}/cancel` | `client.interactions.cancel(id)` |

Raw REST headers:
```http
x-goog-api-key: $GEMINI_API_KEY
Content-Type: application/json
Api-Revision: 2026-05-20
```
*(SDK `>= 2.0.0` automatically uses the post-May-2026 `steps` + `response_format` schema; include `Api-Revision: 2026-05-20` on raw REST calls when targeting pinned beta schema behavior.)*

---

## 3. Request Schema & State / Scoping Rules

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `model` | `string` | Model ID (e.g. `"gemini-4-hydrogen"`, `"gemini-3.8-flash-tts"`). Mutually exclusive with `agent`. |
| `agent` | `string` | Managed or custom agent ID (requires `v1beta`). Mutually exclusive with `model`. |
| `input` | `string \| array` | Plain text string, multimodal content items, or structured step array (`[{ type: "user_input", content: [...] }]`). Use structured `user_input` with `annotations` for TTS `speech_metadata`. |
| `previous_interaction_id` | `string` | Chains this turn onto a stored interaction for server-side history & higher context-cache hit rates. |
| `store` | `boolean` | Defaults to `true`. **Paid tier retains 55 days; Free tier retains 1 day.** Set `false` for stateless execution (disables `previous_interaction_id` and `background: true`). |
| `background` | `boolean` | Defaults to `false`. Runs asynchronously (requires `store: true`); poll with `interactions.get(id)` or abort with `interactions.cancel(id)`. |
| `stream` | `boolean` | Defaults to `false`. Returns `text/event-stream` SSE events. |
| `system_instruction` | `string` | System prompt for this interaction. **Interaction-scoped** (must be re-sent each turn). |
| `tools` | `array` | Tools for this interaction (functions, Google Search, Code Execution, URL Context, File Search, MCP). **Interaction-scoped.** |
| `response_format` | `object \| array` | Polymorphic output format control (replaces legacy `response_mime_type` / `response_modalities`). For audio: `{ type: "audio", mime_type?, sample_rate?, bit_rate?, delivery? }`. |
| `generation_config` | `object` | **Interaction-scoped.** Model settings: `speech_config`, `temperature`, `top_p`, `top_k`, `max_output_tokens`, `thinking_level`, `thinking_summaries`, `stop_sequences`, `tool_choice`. |
| `safety_settings` | `array` | Per-category safety thresholds (see Section 5). |

> **Critical scoping rule:** `previous_interaction_id` carries forward conversation history (inputs and outputs) **only**. `tools`, `system_instruction`, and `generation_config` are **interaction-scoped** and must be re-specified on every turn where they should apply.

### `AudioResponseFormat` Type (`@google/genai` Upstream Source)

```ts
export type AudioResponseFormatDelivery = 'inline' | 'uri' | (string & {});

export type AudioResponseFormatMimeType =
  | 'audio/mp3'
  | 'audio/ogg_opus'
  | 'audio/l16'
  | 'audio/wav'
  | 'audio/alaw'
  | 'audio/mulaw'
  | (string & {});

export type AudioResponseFormat = {
  type: 'audio';
  mime_type?: AudioResponseFormatMimeType;
  sample_rate?: number; // Hz (e.g. 24000, 16000, 8000 for Gemini 3.8 TTS)
  bit_rate?: number;    // bps (compressed formats only: MP3, Opus)
  delivery?: AudioResponseFormatDelivery;
};
```

---

## 4. Response Data Model (`Interaction` & `steps`)

An `Interaction` contains:
- `id`: Unique interaction ID
- `status`: `'completed' | 'in_progress' | 'queued' | 'requires_action' | 'incomplete' | 'failed' | 'cancelled'`
- `steps`: Ordered timeline of typed execution steps. (`interactions.create` returns model-generated steps; `interactions.get` also includes `user_input` steps.)
- `usage`: Token usage statistics (`total_tokens`, etc.)

### SDK Convenience Helpers
| Property | Type | Description |
| :--- | :--- | :--- |
| `interaction.output_text` | `string \| null` | Combined text from trailing `model_output` steps |
| `interaction.output_audio` | `{ data, mime_type } \| null` | Last generated audio block (`data` is base64) |
| `interaction.output_image` | `{ data, mime_type } \| null` | Last generated image block (`data` is base64) |

### Step Types & Content Types
- **User steps:** `user_input` (contains `content[]`)
- **Model / server steps:**
  - `model_output` (contains `content[]`: `text`, `audio`, `image`, `video`, `document`)
  - `thought` (`signature` required, optional `summary`)
  - `function_call` (`id`, `name`, `arguments`) / `function_result` (`call_id`, `name`, `result`)
  - Built-in tool steps: `google_search_*`, `code_execution_*`, `url_context_*`, `file_search_*`, `mcp_server_tool_*`
- **Text content annotations:** `text` items accept optional `annotations`, e.g. `{ type: 'speech_metadata', speaker?: '...', style?: '...' }`.

### General Examples (TypeScript)

#### Stateful Multi-Turn Chat
```ts
const turn1 = await client.interactions.create({
  model: 'gemini-4-hydrogen',
  input: 'Remember this project codename: Velvet Rain.',
});

const turn2 = await client.interactions.create({
  model: 'gemini-4-hydrogen',
  previous_interaction_id: turn1.id,
  input: 'What is our project codename?',
});

console.log(turn2.output_text);
```

#### Background Agent Task (`v1beta`)
```ts
const job = await betaClient.interactions.create({
  agent: 'deep-research-preview-04-2026',
  input: 'Survey psychoacoustic headphone crossfeed filters for spoken-word audio.',
  background: true,
});

while (true) {
  const status = await betaClient.interactions.get(job.id);
  if (status.status === 'completed') {
    console.log(status.output_text);
    break;
  }
  if (['failed', 'cancelled'].includes(status.status)) {
    throw new Error(`Interaction ${status.status}`);
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
```

---

## 5. Safety Settings (`safety_settings`)

Pass an array of `SafetySetting` objects (one per category). **For Gemini 2.5 and later models, omitted categories default to `off`.**

```ts
export type SafetySetting = {
  type: 'harassment' | 'hate_speech' | 'sexually_explicit' | 'dangerous_content' | 'jailbreak';
  threshold:
    | 'block_low_and_above'
    | 'block_medium_and_above'
    | 'block_only_high'
    | 'block_none'
    | 'off';
  method?: 'probability' | 'severity'; // Optional; defaults to probability
};
```

Example for creative audio drama:
```ts
safety_settings: [
  { type: 'harassment', threshold: 'block_none' },
  { type: 'hate_speech', threshold: 'block_none' },
  { type: 'sexually_explicit', threshold: 'block_none' },
  { type: 'dangerous_content', threshold: 'block_none' },
]
```

### When Content Is Blocked
- **Non-streaming:** Fails with HTTP **`400`** and JSON `{ error: { code, message } }`. Error `code` values: `safety`, `jailbreak`, `prohibited_content`, or `blocklist` (the latter three have messages starting with `Input blocked:`).
- **Background:** `status` becomes `'failed'` with the same `code` and `message` in `errors`.
- **Streaming:** Emits an `error` SSE event.
- **Core protections:** Built-in protections against core harms (e.g., child safety) are always enforced and cannot be disabled.

---

## 6. Streaming (Server-Sent Events)

When `stream: true`, every stream follows:
`interaction.created` → (`step.start` → `step.delta`+ → `step.stop`)+ → `interaction.completed`

| Event | Description |
| :--- | :--- |
| `interaction.created` | Stream opened; includes interaction `id`, `model`, `status: 'in_progress'` |
| `interaction.status_update` | Interaction-level status transition |
| `step.start` | Begins a step (`index`, `step.type`) |
| `step.delta` | Incremental payload with typed `delta` (`text`, `audio`, `image`, `video`, `thought_summary`, `thought_signature`) |
| `step.stop` | Closes the current step (`index`) |
| `interaction.completed` | Final interaction object including `usage` |

```ts
const stream = await client.interactions.create({
  model: 'gemini-4-hydrogen',
  input: 'Explain constant-power stereo panning in two sentences.',
  stream: true,
});

for await (const event of stream) {
  if (event.event_type === 'step.delta' && event.delta.type === 'text') {
    process.stdout.write(event.delta.text);
  } else if (event.event_type === 'interaction.completed') {
    console.log('\nTotal tokens:', event.interaction?.usage?.total_tokens);
  }
}
```

---

## 7. Quick Reference: Legacy `generateContent` → Interactions API Mapping (The Booth)

For reference when porting older TTS snippets to The Booth's Interactions API adapter (`src/providers/gemini.ts`, as specified in [SPEC.md](../SPEC.md)):

| Legacy `generateContent` style | Interactions API (`@google/genai >= 3.5.0`, `v1beta`) |
| :--- | :--- |
| `client.models.generateContent(...)` | `client.interactions.create(...)` on a `new GoogleGenAI({ httpOptions: { apiVersion: 'v1beta' } })` client |
| `parts[0].text` + `parts[0].speechMetadata = { style }` | `input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: direction ? [{ type: 'speech_metadata', style: direction }] : undefined }] }]` |
| `config.speechConfig.voiceConfig.voice` | `generation_config: { speech_config: [{ voice: voiceId }] }` |
| `responseModalities: ['AUDIO']` | `response_format: { type: 'audio' }` (unary default is complete 24 kHz 16-bit LE mono `audio/wav` with RIFF header; optionally set `sample_rate` or `mime_type: 'audio/l16'`) |
| `safetySettings` (`HARM_CATEGORY_*` / `BLOCK_NONE`) | `safety_settings: [{ type: 'sexually_explicit', threshold: 'block_none' }, ...]` (note: omitted categories already default to `'off'` on Gemini 2.5+) |
| `automaticContinuation: false` | Not applicable to TTS cues (governed by 8,192 input-token / 16,384 output-token limits; keep cues chunked at paragraph/sentence boundaries) |
| Audio bytes in `candidates[0].content.parts` | `Buffer.from(interaction.output_audio.data, 'base64')` (returns `{ data, mime_type }`) |
| Stateless cue synthesis | Pass `store: false` so individual takes aren't retained server-side for 55 days |
| Multi-character scenes with custom `voice_...` IDs | Synthesize each cue individually (required anyway since single-request `speech_config.speakers` only supports up to 2 prebuilt voices) |
