import { describe, expect, it } from 'vitest';
import { resolveTimeline, TimelineError } from '../src/audio/timeline.js';
import {
  createDefaultProjectAudio,
  Cue,
  SfxEvent,
} from '../src/types/project.js';

function makeCue(
  id: string,
  durationMs: number,
  timing: { afterCueId?: string | null; offsetMs: number } = { offsetMs: 0 },
): Cue {
  const takeId = `take_${id}`;
  return {
    id,
    speaker: 'mara',
    text: `Line ${id}`,
    direction: null,
    timing,
    mix: {
      gainDb: 0,
      pan: 0,
      eqPreset: 'neutral',
      fadeInMs: 20,
      fadeOutMs: 30,
    },
    activeTakeId: durationMs > 0 ? takeId : null,
    takes:
      durationMs > 0
        ? [
            {
              id: takeId,
              provider: 'mock',
              model: 'mock-v1',
              providerVoiceId: 'mock_mara',
              direction: null,
              textHash: 'abc',
              audioPath: `takes/${takeId}.wav`,
              durationMs,
              measuredLufs: -20,
              measuredRmsDbfs: -20,
              peakDbfs: -6,
              createdAt: new Date().toISOString(),
            },
          ]
        : [],
  };
}

describe('Timeline Resolver', () => {
  it('resolves sequential pauses, dialogue overlaps, and tail duration', () => {
    const cues = [
      makeCue('c1', 2000, { offsetMs: 500 }), // leading 500ms pause -> 500..2500
      makeCue('c2', 1500, { offsetMs: 3000 }), // +3000ms pause -> 5500..7000
      makeCue('c3', 1000, { offsetMs: -400 }), // -400ms overlap -> 6600..7600
    ];

    const timeline = resolveTimeline({
      audio: createDefaultProjectAudio(),
      cues,
      sfx: [],
    });

    expect(timeline.cues.map((c) => [c.cueId, c.startMs, c.endMs])).toEqual([
      ['c1', 500, 2500],
      ['c2', 5500, 7000],
      ['c3', 6600, 7600],
    ]);
    expect(timeline.contentEndMs).toBe(7600);
    expect(timeline.tailMs).toBe(2000);
    expect(timeline.totalDurationMs).toBe(9600);
    expect(timeline.warnings).toEqual([]);
  });

  it('supports explicit afterCueId anchors (including null for t=0 and out-of-order references)', () => {
    const cues = [
      makeCue('c1', 1000, { afterCueId: 'c2', offsetMs: 200 }), // follows c2 (1000) -> 1200..2200
      makeCue('c2', 1000, { afterCueId: null, offsetMs: 0 }), // anchored to t=0 -> 0..1000
    ];

    const timeline = resolveTimeline({
      audio: createDefaultProjectAudio(),
      cues,
      sfx: [],
    });

    expect(timeline.cues[0]).toMatchObject({ cueId: 'c1', startMs: 1200, endMs: 2200 });
    expect(timeline.cues[1]).toMatchObject({ cueId: 'c2', startMs: 0, endMs: 1000 });
  });

  it('clamps negative resolved timestamps to 0 ms with a warning', () => {
    const cues = [
      makeCue('c1', 300, { offsetMs: 0 }),
      makeCue('c2', 1000, { offsetMs: -800 }), // 300 - 800 = -500 -> clamped to 0
    ];

    const timeline = resolveTimeline({
      audio: createDefaultProjectAudio(),
      cues,
      sfx: [],
    });

    expect(timeline.cues[1]!.startMs).toBe(0);
    expect(timeline.warnings.length).toBe(1);
    expect(timeline.warnings[0]).toContain('clamped to 0 ms');
  });

  it('rejects self-referencing and multi-node cycles with HTTP 400 TimelineError', () => {
    const selfCycle = [makeCue('c1', 1000, { afterCueId: 'c1', offsetMs: 0 })];
    expect(() =>
      resolveTimeline({
        audio: createDefaultProjectAudio(),
        cues: selfCycle,
        sfx: [],
      }),
    ).toThrow(TimelineError);

    const multiCycle = [
      makeCue('c1', 1000, { afterCueId: 'c3', offsetMs: 0 }),
      makeCue('c2', 1000, { afterCueId: 'c1', offsetMs: 0 }),
      makeCue('c3', 1000, { afterCueId: 'c2', offsetMs: 0 }),
    ];
    try {
      resolveTimeline({
        audio: createDefaultProjectAudio(),
        cues: multiCycle,
        sfx: [],
      });
      expect.fail('Expected cycle detection error');
    } catch (err) {
      expect(err).toBeInstanceOf(TimelineError);
      expect((err as TimelineError).statusCode).toBe(400);
      expect((err as TimelineError).message).toMatch(/Cyclic cue timing dependency/);
    }
  });

  it('resolves SFX anchored to cue start/end and extends contentEndMs when SFX trails cues', () => {
    const cues = [makeCue('c1', 1000, { offsetMs: 0 }), makeCue('c2', 1000, { offsetMs: 2000 })];
    const sfx: SfxEvent[] = [
      {
        id: 'sfx_prelap',
        label: 'rustle',
        assetPath: 'rustle.wav',
        anchor: { cueId: 'c2', edge: 'start', offsetMs: -500 }, // 3000 - 500 = 2500
        gainDb: -8,
        pan: 0.2,
        fadeInMs: 15,
        fadeOutMs: 40,
      },
      {
        id: 'sfx_chime',
        label: 'chime',
        assetPath: 'chime.wav',
        anchor: { cueId: 'c2', edge: 'end', offsetMs: 500 }, // 4000 + 500 = 4500..6500
        gainDb: -6,
        pan: 0,
        fadeInMs: 15,
        fadeOutMs: 40,
      },
    ];

    const timeline = resolveTimeline(
      { audio: createDefaultProjectAudio(), cues, sfx },
      { sfx_prelap: 600, sfx_chime: 2000 },
    );

    expect(timeline.sfx[0]).toMatchObject({ startMs: 2500, endMs: 3100 });
    expect(timeline.sfx[1]).toMatchObject({ startMs: 4500, endMs: 6500 });
    expect(timeline.contentEndMs).toBe(6500);
    expect(timeline.totalDurationMs).toBe(8500);
  });
});
