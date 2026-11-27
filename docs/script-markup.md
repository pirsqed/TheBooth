# Script Markup & Authoring Guide

The Booth's script importer (`POST /projects/:id/import-script` or `booth_import_script`) compiles human- and LLM-friendly plain text into structured timeline cues, background beds, and anchored sound effects.

Because directives are **sticky** by default and unchanged takes are matched by **`textHash`**, you can edit a scene like a screenplay—adjusting pauses, overlaps, panning, EQ, or beds—and re-import without paying to re-synthesize untouched lines.

---

## 1. How Parsing Works

1. **Blank lines** separate cues (paragraphs). Consecutive plain-text lines without a blank line are joined with spaces into a single cue.
2. **Directive lines** contain one or more `[[key:value]]` tags on their own line (e.g., `[[pause:2]] [[pan:-0.5]]`). They flush any preceding text buffer and update either **sticky state** (for all subsequent cues) or **next-cue state** (for the immediately following cue only).
3. **Screenplay prefixes** like `MARA: Sit down.` switch the active speaker automatically when `MARA` matches a registered voice's `id` or `label` (case-insensitive).
4. **Inline vocal tags** such as `<sigh>`, `<short pause>`, `<chuckle>`, or `<breath>` inside spoken text are preserved verbatim for the TTS provider and are **never split** across chunks.
5. **Safe auto-chunking:** Very long monologues exceeding `maxChunkBytes` (default `6000` UTF-8 bytes) are automatically split at sentence boundaries (falling back to word boundaries) without ever bisecting an inline `<...>` tag.

---

## 2. Directive Reference

### Speaker & Performance (Sticky)

| Directive | Behavior | Examples |
| :--- | :--- | :--- |
| `[[voice:<id>]]` | Sets the active speaker for subsequent cues. Matches registered voice IDs or labels (case-insensitive). | `[[voice:mara]]`, `[[voice:narrator]]` |
| `NAME: Spoken line` | Screenplay-style speaker switch (only triggers if `NAME` matches a registered voice ID or label). | `JULIAN: Wait—don't close it.` |
| `[[dir:<direction>]]` | Sets delivery style metadata (passed to Gemini via `speech_metadata.style`, never spoken aloud). Use `[[dir:reset]]` to inherit `voice.defaultDirection`. | `[[dir:softer, closer, barely above a whisper]]`, `[[dir:reset]]` |

> **Directing Tip:** Keep `[[dir:...]]` concise (`3–12` words of physical intent, like *"speaking low so the next room doesn't hear"*). Avoid stuffing long character bios into `[[dir:...]]`—put permanent voice identity in the voice profile or custom voice design instead.

### Pacing & Overlaps (Next Cue Only)

| Directive | Behavior | Examples |
| :--- | :--- | :--- |
| `[[pause:<duration>]]` | Adds positive silence (`offsetMs > 0`) before the **next** cue. Default unit is **seconds** (`s`), or pass `ms`. Multiple `[[pause:...]]` tags accumulate. | `[[pause:3]]` (`3000 ms`), `[[pause:1.5]]`, `[[pause:600ms]]` |
| `[[overlap:<duration>]]` | Sets a negative offset (`offsetMs < 0`) so the **next** cue interrupts or overlaps the tail of the previous cue. Default unit is **milliseconds** (`ms`), or pass `s`. | `[[overlap:350]]` (`-350 ms`), `[[overlap:0.5s]]` |

### Stage-2 Mix Controls (Sticky — Zero Re-Synthesis Cost)

| Directive | Behavior | Valid Values |
| :--- | :--- | :--- |
| `[[gain:<dB>]]` | Artistic gain trim summed on top of `autoLevel`. | `-24dB` to `+12dB` (e.g. `[[gain:-4dB]]`, `[[gain:0]]`, `[[gain:reset]]`) |
| `[[pan:<pos>]]` | Stereo stage placement. Uses constant-power pan + optional headphone crossfeed. | `-1.0` to `+1.0`, `center` (`0`), `left` (`-0.65`), `right` (`0.65`), `hard-left` (`-0.9`), `hard-right` (`0.9`), `reset` |
| `[[eq:<preset>]]` | Curated spoken-word EQ chain. | `neutral`, `intimate`, `whisper`, `phone`, `radio`, `distant`, `reset` |
| `[[autolevel:<mode>]]` | Per-cue override of project `audio.autoLevel`. | `gentle`, `match`, `off`, `reset` |

### Curated EQ Presets

| Preset | Acoustic Character |
| :--- | :--- |
| `neutral` | Clean `70 Hz` high-pass filter only (removes sub-rumble without coloring the voice) |
| `intimate` | Warm close-mic proximity lift (`+2.5 dB @ 180 Hz`), gentle de-harsh (`-2.0 dB @ 3.2 kHz`), soft air (`+1.5 dB` high shelf @ `9.5 kHz`) |
| `whisper` | Velvety high-frequency rolloff (`8.5 kHz` LPF), gentle de-ess (`-3.5 dB @ 6.5 kHz`), and soft compression |
| `phone` | Narrowband `300–3400 Hz` telephone bandpass with midrange presence (`+3 dB @ 1.4 kHz`) |
| `radio` | Band-limited `280–3800 Hz` comms filter with subtle bit-crushed grit |
| `distant` | Soft `4.5 kHz` low-pass rolloff and `-3 dB` attenuation for off-mic / across-the-room lines |

---

## 3. Background Beds & Spot SFX

Both `[[bed:...]]` and `[[sfx:...]]` resolve assets from two places:
- **Writable local library (`DATA_DIR/assets/`):** unprefixed relative path, e.g. `rain_window.wav` or `foley/door_latch.wav` (extension optional).
- **External read-only libraries (`ASSET_LIBRARY_DIRS`):** prefixed with `@<alias>/`, e.g. `@sonniss/Glass/GLASSBrk_Mirror_01.wav`.
- **Filenames with spaces:** wrap the asset path in double or single quotes (e.g. `[[sfx:"@sonniss/Doors & Latches/Wood Creak 01.wav" ...]]`).

### Continuous Ambient Beds (`[[bed:...]]`)

Attach a looped audio file from `DATA_DIR/assets/` or an external `@<alias>/` library, or add a synthetic room-tone layer:

```text
[[bed:rain_window.wav gain=-26dB duck=-6dB attack=100ms release=800ms fadein=1500ms fadeout=3000ms]]
[[bed:"@nps/Storm Wind Long.wav" clipStart=18s clipDur=45s gain=-26dB duck=-6dB]]
[[bed:room_tone style=warm_dark gain=-54dB]]
```

| Option | Default | Description |
| :--- | :--- | :--- |
| `gain` | `-24dB` (asset) / `-54dB` (room tone) | Bed level (`-80dB` to `+12dB`) |
| `duck` | `-6dB` (asset) / `off` (room tone) | Speech-triggered ducking depth (`-24dB` to `0dB`, or `off`/`false`) |
| `attack` | `100ms` | Ducking attack time when speech enters |
| `release` | `800ms` | Ducking release time when speech pauses |
| `fadein` | `1500ms` | Bed fade-in at track start |
| `fadeout` | `3000ms` | Bed fade-out at track tail |
| `loop` | `true` | Loop asset (or the sliced `clipStart`/`clipDur` window) to cover full project duration (`true` / `false`) |
| `clipStart` | *(none)* | Optional non-destructive source-file start offset (`s` or `ms`, e.g. `18s`, `1500ms`) |
| `clipDur` | *(none)* | Optional non-destructive source-file clip duration (`s` or `ms`, e.g. `45s`, `8000ms`) |
| `style` | `warm_dark` | For `room_tone` only: `warm_dark` (brown noise `< 2.4 kHz`) or `soft_pink` (pink noise `< 3.2 kHz`) |

### Anchored Sound Effects (`[[sfx:...]]`)

Drop spot foley from `DATA_DIR/assets/` or `@<alias>/` anchored to either the **previous cue's end** (`anchor=prev`, default) or the **next cue's start** (`anchor=next`, ideal for pre-laps after a long silence):

```text
[[sfx:door_latch.wav gain=-10dB pan=0.4 offset=150ms]]
[[sfx:sheets_rustle.wav anchor=next offset=-500ms gain=-14dB pan=-0.3]]
[[sfx:"@sonniss/Glass/GLASSBrk Mirror x4.wav" clipStart=3.1s clipDur=1.4s anchor=next offset=-250ms gain=-8dB pan=0.35]]
```

| Option | Default | Description |
| :--- | :--- | :--- |
| `anchor` | `prev` | `prev` anchors to the end of the preceding cue (`t=0` if first); `next` anchors to the start of the upcoming cue |
| `offset` | `0ms` | Millisecond (or `s`) shift from anchor edge—negative values pre-lap |
| `gain` | `-6dB` | SFX gain (`-48dB` to `+12dB`); typical everyday foley sits around `-10dB` to `-18dB` |
| `pan` | `0` | Stereo placement (`-1.0..+1.0` or preset name) |
| `clipStart` | *(none)* | Optional source-file start offset (`s` or `ms`) to isolate a single hit inside a multi-variation WAV |
| `clipDur` | *(none)* | Optional source-file clip duration (`s` or `ms`); also used for timeline tail estimation so unused source tails don't inflate project length |
| `fadein` | `15ms` | Edge de-click fade-in |
| `fadeout` | `40ms` | Edge de-click fade-out |

---

## 4. Take Preservation Across Re-Imports

When you re-import a script with `mode: "replace"`:

- Every existing take stores `textHash = SHA-256(text + direction + providerVoiceId)`.
- If a newly parsed cue matches an existing cue's `textHash`, The Booth **re-attaches its existing takes and `activeTakeId`** automatically.
- Changing `[[pause]]`, `[[overlap]]`, `[[gain]]`, `[[pan]]`, `[[eq]]`, `[[autolevel]]`, `[[bed]]`, or `[[sfx]]` **never invalidates takes**.
- Only cues whose spoken text, `[[dir:...]]`, or speaker's `providerVoiceId` actually changed will need Stage-1 synthesis when you run `render-all`.

---

## 5. Worked Examples

### Example A: Two-Character Noir Scene (Overlaps, Phone EQ & Stereo Blocking)

```text
[[bed:night_rain.wav gain=-26dB duck=-6dB]]

[[voice:elena]]
[[pan:-0.45]]
[[eq:intimate]]
[[dir:dry, tired, holding her composure]]
Tell me you didn't leave the ledger in the car.

[[overlap:320]]
[[voice:marcus]]
[[pan:0.5]]
[[eq:phone]]
[[dir:clipped, breathless, walking fast]]
I'm looking right at the glovebox, Elena, it's empty—

[[overlap:250]]
[[voice:elena]]
[[pan:-0.45]]
[[eq:intimate]]
[[dir:sharp, quiet dread]]
Marcus. Stop walking. <short pause> Look behind the pillar by Gate Four.

[[pause:1.8]]
[[sfx:distant_footsteps.wav anchor=next offset=-600ms gain=-14dB pan=0.6]]
[[voice:marcus]]
[[pan:0.5]]
[[eq:phone]]
[[gain:-2dB]]
[[dir:barely audible, stunned]]
<sigh> Oh, hell.
```

### Example B: Late-Night Guided Relaxation / Spoken Word (Long Pauses & Gentle Taper)

*(Pair with project settings `autoLevel: "gentle"` and `masterNormalize: false` so the final fade-out stays genuinely quiet.)*

```text
[[voice:guide]]
[[bed:room_tone style=warm_dark gain=-54dB]]
[[eq:intimate]]
[[dir:warm, unhurried, grounded, conversational]]

Take one slow breath in through your nose. <short pause> And let it fall out without forcing it.

[[pause:6]]
[[pan:-0.5]]
[[gain:-2dB]]
[[dir:closer, slower, soft breathy warmth]]

Notice the weight of your shoulders against the pillow. There is nowhere else you need to be for the next twenty minutes.

[[pause:15]]
[[pan:0.5]]
[[eq:whisper]]
[[gain:-5dB]]
[[dir:barely above a whisper, unhurried, soothing]]

<sigh> Let the jaw unclench. Let the room hold you.
```
