import { describe, expect, it } from 'vitest';
import {
  parseScript,
  ScriptParseError,
  splitTextSafely,
} from '../src/script/parser.js';
import { VoiceProfile } from '../src/types/project.js';

const testVoices: Record<string, VoiceProfile> = {
  mara: {
    id: 'mara',
    label: 'Mara',
    provider: 'mock',
    providerVoiceId: 'mock_mara',
    defaultDirection: 'warm, natural',
    defaultEqPreset: 'intimate',
    defaultPan: 0,
  },
  lina: {
    id: 'lina',
    label: 'Lina',
    provider: 'mock',
    providerVoiceId: 'mock_lina',
    defaultDirection: 'calm, steady',
    defaultEqPreset: 'neutral',
    defaultPan: 0.35,
  },
};

describe('Script Markup Parser', () => {
  it('parses the SPEC.md bedtime example script with sticky directives and vocal tags intact', () => {
    const script = `
[[voice:mara]]
[[bed:rain_window gain=-26dB duck=-6dB]]
[[dir:warm, unhurried, gentle, intimate]]
[[eq:intimate]]

Take a slow breath. <short pause> Tonight, let everything settle.

[[pause:8]]
[[pan:-0.55]]
[[dir:closer, softer, barely above a whisper]]
[[gain:-3dB]]

Let your shoulders drop all the way into the mattress.

[[pause:25]]
[[pan:0.55]]
[[gain:-5dB]]

Rest easy. <sigh> Goodnight.
`;

    const parsed = parseScript(script, {
      voices: testVoices,
      idFactory: (p, i) => `${p}_${i}`,
    });

    expect(parsed.warnings).toEqual([]);
    expect(parsed.beds).toHaveLength(1);
    expect(parsed.beds[0]).toMatchObject({
      id: 'bed_1',
      kind: 'asset_file',
      assetPath: 'rain_window',
      gainDb: -26,
      ducking: {
        enabled: true,
        amountDb: -6,
      },
    });

    expect(parsed.cues).toHaveLength(3);
    expect(parsed.cues[0]).toMatchObject({
      id: 'cue_1',
      speaker: 'mara',
      text: 'Take a slow breath. <short pause> Tonight, let everything settle.',
      direction: 'warm, unhurried, gentle, intimate',
      timing: { offsetMs: 0 },
      mix: { gainDb: 0, pan: 0, eqPreset: 'intimate' },
    });

    expect(parsed.cues[1]).toMatchObject({
      id: 'cue_2',
      speaker: 'mara',
      text: 'Let your shoulders drop all the way into the mattress.',
      direction: 'closer, softer, barely above a whisper',
      timing: { offsetMs: 8000 },
      mix: { gainDb: -3, pan: -0.55, eqPreset: 'intimate' },
    });

    expect(parsed.cues[2]).toMatchObject({
      id: 'cue_3',
      speaker: 'mara',
      text: 'Rest easy. <sigh> Goodnight.',
      direction: 'closer, softer, barely above a whisper',
      timing: { offsetMs: 25000 },
      mix: { gainDb: -5, pan: 0.55, eqPreset: 'intimate' },
    });
  });

  it('handles screenplay speaker prefixes, overlaps, named pans, and resets', () => {
    const script = `
[[pan:left]]
[[dir:nervous]]
MARA: Wait... did you hear that?

[[overlap:350]]
[[pan:reset]]
[[dir:reset]]
LINA: <sigh> Probably just the wind.

[[pan:hard-right]]
[[eq:phone]]
[[autolevel:match]]
MARA: Check the lock anyway.
`;

    const parsed = parseScript(script, {
      voices: testVoices,
      idFactory: (p, i) => `${p}_${i}`,
    });

    expect(parsed.cues).toHaveLength(3);
    expect(parsed.cues[0]).toMatchObject({
      speaker: 'mara',
      direction: 'nervous',
      mix: { pan: -0.65, eqPreset: 'intimate' },
    });

    // After reset, Lina inherits her own voice defaults (defaultPan: 0.35, defaultDirection: 'calm, steady')
    expect(parsed.cues[1]).toMatchObject({
      speaker: 'lina',
      direction: 'calm, steady',
      timing: { offsetMs: -350 },
      mix: { pan: 0.35, eqPreset: 'neutral' },
    });

    expect(parsed.cues[2]).toMatchObject({
      speaker: 'mara',
      mix: { pan: 0.9, eqPreset: 'phone', autoLevel: 'match' },
    });
  });

  it('anchors SFX with anchor=prev (default) and anchor=next pre-laps', () => {
    const script = `
[[voice:mara]]
First line.

[[sfx:cup_setdown gain=-10dB offset=150ms]]
[[pause:10]]
[[sfx:sheets_rustle anchor=next gain=-12dB pan=0.3 offset=-500ms]]

Second line after pause.
`;

    const parsed = parseScript(script, {
      voices: testVoices,
      idFactory: (p, i) => `${p}_${i}`,
    });

    expect(parsed.cues).toHaveLength(2);
    expect(parsed.sfx).toHaveLength(2);

    expect(parsed.sfx[0]).toMatchObject({
      label: 'cup_setdown',
      gainDb: -10,
      anchor: {
        cueId: 'cue_1',
        edge: 'end',
        offsetMs: 150,
      },
    });

    expect(parsed.sfx[1]).toMatchObject({
      label: 'sheets_rustle',
      gainDb: -12,
      pan: 0.3,
      anchor: {
        cueId: 'cue_2',
        edge: 'start',
        offsetMs: -500,
      },
    });
  });

  it('splits long monologues safely at sentence boundaries without bisecting <...> tags', () => {
    const longText =
      'First sentence with <short pause> inside it. ' +
      'Second sentence with <sigh> and <warm> tone shift. ' +
      'Third sentence wrapping up cleanly.';

    const chunks = splitTextSafely(longText, 65);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(65);
      // Every '<' must have a matching '>' inside the same chunk
      const opens = (chunk.match(/</g) ?? []).length;
      const closes = (chunk.match(/>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
    expect(chunks.join(' ')).toBe(longText);
  });

  it('rejects unknown directives and out-of-range mix values', () => {
    expect(() => parseScript('[[bogus:123]]\nHello.')).toThrow(ScriptParseError);
    expect(() => parseScript('[[pan:2.5]]\nHello.')).toThrow(ScriptParseError);
    expect(() => parseScript('[[eq:underwater]]\nHello.')).toThrow(ScriptParseError);
  });
});
