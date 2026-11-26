# Gemini 3.8 TTS Reference & Prompting Guide (Interactions API)

> Verified directly against Google's official Gemini API documentation via the Gemini Docs MCP server (`aistudio.google.com/docs`, November 2026), tailored for **The Booth** (`@google/genai` TypeScript/Node + Interactions API).

Canonical official docs:
- Speech generation (TTS): https://aistudio.google.com/docs/speech-generation.md
- Gemini 3.8 Flash TTS model page: https://aistudio.google.com/docs/models/gemini-3.8-flash-tts.md
- Gemini 3.8 Flash-Lite TTS model page: https://aistudio.google.com/docs/models/gemini-3.8-flash-lite-tts.md
- Voice design: https://aistudio.google.com/docs/voice-design.md
- Voice remixing: https://aistudio.google.com/docs/voice-remixing.md
- Voice replication: https://aistudio.google.com/docs/voice-replication.md
- Interactive playground: https://aistudio.google.com/generate-speech

---

## 1. Latest Models & Specifications

Both Gemini 3.8 TTS models share the exact same API schema and prompting structure, so you can switch between them with a single parameter change.

| Feature | `gemini-3.8-flash-tts` (Flagship Creative Tier) | `gemini-3.8-flash-lite-tts` (High-Throughput Workhorse) |
| :--- | :--- | :--- |
| **Primary Strength** | Maximum voice fidelity, acting nuance, and dialect coverage | High throughput, low latency, and cost efficiency |
| **Best Use Cases** | Audiobooks, studio narration, complex multi-speaker dialogue, heavy vocal-burst acting, difficult pronunciations, regional/minority dialects, rock-solid long-form room-tone & voice stability | High-volume bulk production, real-time voice agent cascades, read-aloud features, reliable voice replication, everyday single-speaker generation |
| **Replaces** | New flagship creative tier | `gemini-3.1-flash-tts-preview` |
| **Modalities** | Text input → Audio output only | Text input → Audio output only |
| **Input / Output Token Limits** | 8,192 input / 16,384 output (Gemini API serving limit) | 8,192 input / 16,384 output (Gemini API serving limit) |
| **Supported Languages** | 130+ languages (auto-detected) | 101 languages (auto-detected) |
| **Voice Features** | Single-speaker, Multi-speaker, Voice Design, Voice Replication, Voice Remixing | Single-speaker, Multi-speaker, Voice Design, Voice Replication, Voice Remixing |
| **Consumption Options** | Batch API, Flex inference, Priority inference | Batch API, Flex inference, Priority inference |
| **Pricing — Input Text** | \$0.50 / 1M tokens (through Dec 31, 2026) · \$1.00 / 1M (from Jan 1, 2027) | \$0.50 / 1M tokens (through Dec 31, 2026) · \$1.00 / 1M (from Jan 1, 2027) |
| **Pricing — Output Audio** | \$9.00 / 1M tokens (~\$0.81/hr; through Dec 31, 2026) · \$18.00 / 1M (from Jan 1, 2027) | \$6.00 / 1M tokens (through Dec 31, 2026) · \$12.00 / 1M (from Jan 1, 2027) |
| **Required API Version** | `v1beta` | `v1beta` |
| **SDK Versions** | Latest `@google/genai >= 3.5.0` / `google-genai >= 3.5.0` (minimum `2.24.0` JS / `2.25.0` Python) | Latest `@google/genai >= 3.5.0` / `google-genai >= 3.5.0` (minimum `2.24.0` JS / `2.25.0` Python) |

> **Unsupported features on TTS models:** Code execution, context caching, file search, function calling, Search/Maps grounding, image generation, Live API, structured outputs, thinking, and URL context are not supported.

### Audio Output Formats (`response_format`)

Unlike `gemini-3.1-flash-tts-preview` (which returned headerless PCM by default), Gemini 3.8 TTS chooses its default format based on unary vs. streaming:

| `response_format.mime_type` | Format | Description |
| :--- | :--- | :--- |
| `"audio/wav"` *(unary default)* | WAV | Complete WAV file with a 44-byte RIFF header (24 kHz, mono, 16-bit signed LE PCM). Write decoded bytes directly to `.wav`. |
| `"audio/l16"` *(streaming default)* | Linear PCM | Headerless raw 16-bit signed LE linear PCM (24 kHz, mono). Default when `stream: true` so chunks concatenate cleanly without container headers. |
| `"audio/mulaw"` | µ-law | G.711 µ-law companded audio (typically 8 kHz North American/Japanese telephony). |
| `"audio/alaw"` | A-law | G.711 A-law companded audio (typically 8 kHz European/international telephony). |

You can also optionally set **`sample_rate`** in `response_format` (e.g., `24000`, `16000`, or `8000` Hz; defaults to `24000` Hz).

> **Important limitation for multi-character audio drama:**
> Single-request multi-speaker generation (`speech_config.speakers`) supports **up to 2 speakers using prebuilt voices only**. To combine **custom designed (`voice_...`) or replicated (`voice_...` / `voicekey_...`)** voices in multi-character dialogue, **synthesize each speaker's turn individually** (matching The Booth's cue-by-cue architecture).

---

## 2. Synthesizing Speech via the Interactions API

> **API version note:** `@google/genai >= 3.0.0` defaults to stable `v1`, whereas Gemini 3.8 TTS and the Voices API require **`v1beta`**. Opt in with `new GoogleGenAI({ httpOptions: { apiVersion: 'v1beta' } })` (or `new GoogleGenAI({ apiVersion: 'v1beta' })` / `GOOGLE_GENAI_API_VERSION=beta`).

### Single-Speaker TTS (TypeScript — `@google/genai`)

```ts
import { GoogleGenAI } from '@google/genai';
import * as fs from 'node:fs';

const client = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { apiVersion: 'v1beta' },
});

const interaction = await client.interactions.create({
  model: 'gemini-3.8-flash-tts',
  store: false, // Optional: stateless cue render (no server-side storage)
  input: [
    {
      type: 'user_input',
      content: [
        {
          type: 'text',
          text: 'Take a slow breath. <short pause> Tonight, let everything settle.',
          annotations: [
            {
              type: 'speech_metadata',
              style: 'warm, unhurried, gentle, intimate',
            },
          ],
        },
      ],
    },
  ],
  response_format: {
    type: 'audio',
    // mime_type: 'audio/wav', // Default for unary; 'audio/l16' for raw PCM
    // sample_rate: 24000,     // Optional: 24000 (default), 16000, or 8000
  },
  generation_config: {
    speech_config: [
      { voice: 'Kore' }, // Prebuilt name, Extended Library ID, voice_..., or voicekey_...
    ],
  },
});

if (interaction.output_audio?.data) {
  const wavBuffer = Buffer.from(interaction.output_audio.data, 'base64');
  fs.writeFileSync('take.wav', wavBuffer);
}
```

### Streaming TTS (TypeScript — `@google/genai`)

When `stream: true`, audio arrives as base64-encoded **`audio/l16`** chunks (24 kHz, mono, 16-bit LE PCM) inside `step.delta` events:

```ts
const stream = await client.interactions.create({
  model: 'gemini-3.8-flash-tts',
  input: [
    {
      type: 'user_input',
      content: [
        {
          type: 'text',
          text: 'Have a wonderful day!',
          annotations: [
            {
              type: 'speech_metadata',
              style: 'cheerful and friendly',
            },
          ],
        },
      ],
    },
  ],
  response_format: { type: 'audio' },
  generation_config: {
    speech_config: [{ voice: 'Kore' }],
  },
  stream: true,
});

for await (const event of stream) {
  if (event.event_type === 'step.delta' && event.delta.type === 'audio' && event.delta.data) {
    const pcmChunk = Buffer.from(event.delta.data, 'base64');
    // Feed raw 24 kHz 16-bit LE mono PCM into your audio pipeline
  }
}
```

### Multi-Speaker Dialogue (Up to 2 Prebuilt Voices, Single Request)

Notice that `speech_config` is an **array** (`[{ voice }]`) for single-speaker generation and an **object** (`{ speakers: [...] }`) for multi-speaker generation. Every turn in `content` must specify a `speaker` matching one of the entries in `speech_config.speakers`:

```ts
const interaction = await client.interactions.create({
  model: 'gemini-3.8-flash-tts',
  input: [
    {
      type: 'user_input',
      content: [
        {
          type: 'text',
          text: 'Wait... <short pause> look under that fallen log! Is that a blue-spotted salamander?',
          annotations: [
            {
              type: 'speech_metadata',
              speaker: 'Dr. Anya',
              style: 'whispered urgently',
            },
          ],
        },
        {
          type: 'text',
          text: "<gasp> No way! <laugh> We've been searching for this species all season!",
          annotations: [
            {
              type: 'speech_metadata',
              speaker: 'Liam',
              style: 'warm and enthusiastic',
            },
          ],
        },
      ],
    },
  ],
  response_format: { type: 'audio' },
  generation_config: {
    speech_config: {
      speakers: [
        { speaker: 'Dr. Anya', voice: 'Kore' },
        { speaker: 'Liam', voice: 'Puck' },
      ],
    },
  },
});
```

### Single-Speaker TTS (REST — `POST /v1beta/interactions`)

```bash
curl -X POST "https://generativelanguage.googleapis.com/v1beta/interactions" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.8-flash-tts",
    "store": false,
    "input": [{
      "type": "user_input",
      "content": [{
        "type": "text",
        "text": "Wait... <short pause> did you hear that? <gasp> Someone is at the door.",
        "annotations": [{
          "type": "speech_metadata",
          "style": "whispered, nervous"
        }]
      }]
    }],
    "response_format": { "type": "audio" },
    "generation_config": {
      "speech_config": [
        { "voice": "Kore" }
      ]
    }
  }' | jq -r '[.steps[] | select(.type=="model_output") | .content[] | select(.type=="audio")] | last | .data' | base64 --decode > out.wav
```

---

## 3. Google's Official Prompting & Directing Guide

Gemini 3.8 TTS treats `text` strictly as a **verbatim transcript**. Unlike legacy preview models (`gemini-3.1-flash-tts-preview`), sustained directions are placed in `speech_metadata.style` and momentary events use inline angle-bracket tags (`<...>`).

### 3.1 Style Field vs. Inline Tags

| Scope | Where to Place | Examples |
| :--- | :--- | :--- |
| **Permanent identity** (age, gender, accent, core timbre) | Voice selection or `voices.create` (Voice Design / Remixing) | `"A warm, thoughtful astronomer in his late 60s with a gentle British accent"` |
| **Turn-level delivery** (sustained across the whole cue) | `speech_metadata.style` | `"angry tone"`, `"speaking rapidly"`, `"out of breath"`, `"whispers"`, `"muttering"`, `"sarcastic"` |
| **Point-in-time events** (occurs at a specific word) | Inline in `text` (`<...>`) | `"<cough> Thank you all for coming tonight! <throat-clearing> As I was saying..."` |

- **Never put prose stage directions inside `text`** (e.g., `"Say cheerfully: Hello!"` or `"Speaker 1: Hello!"`) — Gemini 3.8 may speak them literally.
- **Never use legacy square-bracket tags** (`[whispers]`, `[sigh]`). Always use angle brackets (`<...>`) for highest audio quality, and stick strictly to human vocalizations (not environmental SFX like applause or thuds).

### 3.2 Pacing, Pauses, Prosody & Emphasis

- **Pacing & pauses (3 levels of granularity):**
  1. *Punctuation & ellipses:* Use commas, dashes (`--`), and ellipses (`...`) for natural conversational hesitation.
  2. *Inline pause tags:* Insert `<short pause>` or `<long pause>` at exact points (e.g., `"Hold on, let me think... <short pause> Alright, I've got it."`).
  3. *Turn-level pace:* Set `"style": "speaking rapidly"` or `"style": "speaking slowly"` in `speech_metadata`.
- **Prosody & pitch:** Set `"style"` for turn-wide pitch/inflection (e.g., `"high pitch, cheerful and excited inflection"`, `"monotone and flat"`). If emotion or prosody shifts mid-dialogue, **split into separate turns** with distinct `style` values.
- **Emphasis:** Capitalize specific words in the transcript combined with punctuation and inline vocal tags:
  ```text
  This is a VERY important point!
  It was a VERY long day <sigh> ... nobody listens anymore.
  ```
- **Pronunciation, numbers & abbreviations:**
  - Use phonetic respellings or `/IPA/` for jargon or foreign words.
  - Write out numbers, versions, currencies, and letter-by-letter acronyms phonetically when exact cadence matters (`"Model three point eight"`, `"A. I."`).

### 3.3 Official Inline Vocal Tags Reference

Always write inline tags in **English**, even when the spoken transcript is in another language. Do not use closing tags.

| Vocalization / Tag | Vocalization / Tag | Vocalization / Tag | Vocalization / Tag |
| :--- | :--- | :--- | :--- |
| `<argh>` | `<breath>` | `<heavy breath>` | `<exhales>` |
| `<cackle>` | `<cheer>` | `<chuckle>` / `<chuckles>` | `<cough>` |
| `<cry>` | `<gasp>` | `<giggle>` | `<groan>` |
| `<growl>` | `<grunt>` | `<grr>` | `<hiss>` |
| `<laugh>` / `<laughter>` | `<moan>` | `<pant>` | `<pff>` / `<phew>` |
| `<scream>` | `<shout>` | `<shriek>` | `<sigh>` / `<sighs>` |
| `<sneeze>` | `<snicker>` | `<snort>` | `<sob>` |
| `<throat-clearing>` | `<tsk>` | `<whimper>` | `<whispers>` / `<whispering>` |
| `<yawn>` | `<short pause>` | `<long pause>` | |

### 3.4 Backchannels & Overlapping Speech (Multi-Speaker)

In multi-speaker dialogue, wrap listener reactions in pipe characters (`|reaction|`) inside the active speaker's turn (works best with `gemini-3.8-flash-tts`):

- **Backchannels:**
  - Turn 1 (Speaker A): `"So the launch is Thursday |oh hmm| Are we actually ready?"`
  - Turn 2 (Speaker B): `"Ready enough |oh really?| The last blocker cleared this morning."`
  - Turn 3 (Speaker A): `"Then let's ship it |absolutely| and watch the dashboards."`
- **Simultaneous chorus / countdown:**
  - `"one. two. three. |happy| happy |birthday| birthday!"`
- **Full speaker overlap:**
  - `"Hello |oh| there |my| it |goodness| must |gracious| be |would| almost |you| time |look| for |at that| dinner"`

### 3.5 Consistency Across Generations & What to Avoid

- **Design personas upfront in Voice Design instead of long `style` blocks:** Legacy multi-paragraph `"Audio Profile"` or bulleted `"Director's Notes"` blocks are the **#1 cause of voice drift**. Move that description into `voices.create` once, then reuse the `voice_...` ID with minimal or empty `style`.
- **Omit stability meta-instructions:** Gemini 3.8 anchors on the audio voice reference first. **Do not** write instructions like `"do not switch speaker identity"` or `"maintain identical timbre"`—extra prompt text *increases* drift.
- **Never override immutable traits in `style`:** Avoid age, gender, character names, or permanent accent changes in `speech_metadata.style`.

### 3.6 Google's Recommended Workflow (and Multi-Turn Rules)

1. **Build the character once** in Voice Design (1–2 clear, concise sentences) or pick a matching regional voice from the Extended Voice Library.
2. **Write natural spoken transcripts with disfluencies** (e.g., `"Oh uh yeah I think... hm, so that's interesting"`).
3. **Test plain TTS first** with an empty `style` field—most lines need no `style` instruction at all.
4. **Add short `style` prompts only for tweaks** (e.g., `"casual, friendly"` or `"muttering, then reassuring"`), reusing the exact same short string across turns for a consistent baseline.
5. **For multi-turn / voice-agent pipelines:** Make one TTS call per turn, let the configured voice carry identity, leave `style` empty (or a single short constant), and split long responses into shorter turns rather than escalating style prompts.

---

## 4. Voices Ecosystem & Voices API (`/v1beta/voices`)

Gemini 3.8 TTS supports **five** voice sources:

1. **Prebuilt Studio Voices:** 30 curated voices (pass name directly, e.g. `"Kore"`).
2. **Extended Voice Library (`GET /v1beta/voices`):** Hundreds of additional voices across languages, accents, character personas, and domains.
3. **Voice Design (`POST /v1beta/voices`, `type: "prompted"`):** Create a custom vocal persona from a 1–2 sentence text description. Returns persistent `voice_...` ID + `sample_audio` (24 kHz WAV preview).
4. **Voice Remixing (`POST /v1beta/voices`, `type: "prompted"` with `prompted.base_voice`):** Modify any prebuilt, library, or custom designed/remixed voice via relative natural-language instructions. Creates a new independent `voice_...` resource with lineage (`voice.prompted.base_voice` & `input`). Requires **Paid Tier (Tier 1+)**.
5. **Voice Replication (`POST /v1beta/voices`, `type: "replicated"`):** Clone a speaker from `source_audio` + spoken `consent_audio` (Paid Tier 1+; safeguarded with invisible **SynthID** watermark & **C2PA** credentials).

### Storage Modes, Quotas & TTL

| Voice Type | Storage Mode | Quota / Limit | Retention (TTL) | Manageable via API? |
| :--- | :--- | :--- | :--- | :--- |
| **Stateful voices** (`voice_...`, prompted, remixed, or replicated) | `store: true` (default) | **200 voices per project** (shared across prompted, remixed, and replicated) | **1 year from last use** (sliding TTL resets on every synthesis or `base_voice` remix) | Yes (`list`, `get`, `delete`) |
| **Stateless voice keys** (`voicekey_...`, replicated only) | `store: false` | Client-managed | **7 days** (fixed from creation) | No (client stores key) |

> **`sample_audio` note:** `voices.create()` and `voices.get()` return `sample_audio` (`{ mime_type: "audio/wav", data: "<base64>" }`) for `"prompted"` (designed/remixed) voices. `voices.list()` omits `sample_audio` to stay lightweight, and `sample_audio` is unset for `"replicated"` and `"prebuilt"` voices.

### Voices API Endpoints & Filtering

| Operation | HTTP Endpoint | SDK Method (`@google/genai`) |
| :--- | :--- | :--- |
| Create (Design / Remix / Replicate) | `POST /v1beta/voices` | `client.voices.create({ store, voice })` |
| List & Filter (Custom + Prebuilt Catalog) | `GET /v1beta/voices` | `client.voices.list(filters)` |
| Get Metadata + `sample_audio` Preview | `GET /v1beta/voices/{id}` | `client.voices.get(id)` |
| Delete Stored Voice | `DELETE /v1beta/voices/{id}` | `client.voices.delete(id)` |

`voices.list()` returns your custom stored voices (newest first) followed by matching prebuilt catalog voices. Values within one list filter combine with **`OR`**; distinct filter parameters combine with **`AND`**:

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `language_code` | `string[]` | BCP-47 tags (e.g. `["en-US", "en-GB"]`), case-insensitive exact match |
| `region_code` | `string[]` | ISO 3166-1 alpha-2 or UN M.49 (e.g. `["US", "GB"]`) |
| `accent` | `string[]` | Regional accents (e.g. `["American", "British"]`) |
| `gender` | `string[]` | `"female"`, `"male"`, or `"neutral"` |
| `pitch` | `string[]` | `"low"`, `"medium"`, or `"high"` |
| `persona` | `string[]` | Character archetypes (e.g. `["Warm, Friendly"]`, `["Narrator"]`) |
| `contexts` (`context` in REST) | `string[]` | Usage domains (e.g. `["Audiobook", "Conversational", "News"]`) |
| `type` (`type_` in Python) | `string[]` | `"prebuilt"`, `"prompted"`, or `"replicated"` |
| `search` | `string` | Case-insensitive substring match across `display_name` and `description` |
| `page_size` / `page_token` | `number` / `string` | Pagination (`page_size` default `50`, max `1000`) |

### Voice Design & Iterative Remixing Examples (TypeScript)

```ts
// 1. Design a brand-new voice from a 1–2 sentence description
const designed = await client.voices.create({
  store: true,
  voice: {
    model: 'gemini-3.8-flash-tts',
    type: 'prompted',
    display_name: 'Warm Late-Night Narrator',
    gender: 'female',
    language_code: 'en-US',
    prompted: {
      input:
        'A warm, intimate female narrator in her late 20s with a soft velvety timbre and unhurried close-mic pacing.',
    },
  },
});

if (designed.sample_audio?.data) {
  fs.writeFileSync('designed_preview.wav', Buffer.from(designed.sample_audio.data, 'base64'));
}

// 2. Iteratively remix any prebuilt ("Puck") or custom ("voice_...") voice
const remixed = await client.voices.create({
  store: true,
  voice: {
    model: 'gemini-3.8-flash-tts',
    type: 'prompted',
    prompted: {
      base_voice: designed.id, // Can also be "Puck", "Kore", etc.
      input:
        'Keep the same speaker identity and accent, but make the delivery calmer, softer, and slightly lower in pitch.',
    },
  },
});

// 3. Filter the Extended Voice Library
const library = await client.voices.list({
  language_code: ['en-US', 'en-GB'],
  gender: ['female'],
  pitch: ['medium', 'low'],
  contexts: ['Audiobook', 'Conversational'],
  type: ['prebuilt'],
  search: 'warm',
  page_size: 50,
});
```

### All 30 Prebuilt Studio Voices

| Voice | Character | Voice | Character | Voice | Character |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Zephyr` | Bright | `Enceladus` | Breathy | `Alnilam` | Firm |
| `Puck` | Upbeat | `Iapetus` | Clear | `Schedar` | Even |
| `Charon` | Informative | `Umbriel` | Easy-going | `Gacrux` | Mature |
| `Kore` | Firm | `Algieba` | Smooth | `Pulcherrima` | Forward |
| `Fenrir` | Excitable | `Despina` | Smooth | `Achird` | Friendly |
| `Leda` | Youthful | `Erinome` | Clear | `Zubenelgenubi` | Casual |
| `Orus` | Firm | `Algenib` | Gravelly | `Vindemiatrix` | Gentle |
| `Aoede` | Breezy | `Rasalgethi` | Informative | `Sadachbia` | Lively |
| `Callirrhoe` | Easy-going | `Laomedeia` | Upbeat | `Sadaltager` | Knowledgeable |
| `Autonoe` | Bright | `Achernar` | Soft | `Sulafat` | Warm |
