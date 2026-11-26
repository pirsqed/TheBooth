import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { measureAudioLoudness, probeAudio, runCommand } from '../src/audio/ffmpeg.js';
import { computeAutoLevelGain } from '../src/audio/leveling.js';
import { buildPanFilterSegment } from '../src/audio/pan.js';
import { wrapPcm16AsWav } from '../src/providers/interface.js';
import { MockTtsProvider } from '../src/providers/mock.js';
import { StudioService } from '../src/studio/service.js';
import { ProjectStore, StoreError } from '../src/studio/store.js';

/** Generates a simple steady broadband noise WAV file for bed/SFX asset tests. */
function makeNoiseWav(durationMs: number, amplitudeLinear = 0.25, sampleRate = 48000): Buffer {
  const totalSamples = Math.round((durationMs / 1000) * sampleRate);
  const pcm = Buffer.alloc(totalSamples * 2);
  let seed = 1337;
  for (let i = 0; i < totalSamples; i++) {
    // Deterministic LCG pseudo-random noise
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const white = (seed / 0xffffffff) * 2 - 1;
    const sample = Math.max(-1, Math.min(1, white * amplitudeLinear));
    pcm.writeInt16LE(Math.round(sample * 32767), i * 2);
  }
  return wrapPcm16AsWav(pcm, sampleRate, 1);
}

describe('AutoLevel Gain Calculation (Stage-2 Non-Destructive)', () => {
  it('pulls 50% toward -20 LUFS in gentle mode and clamps to [-6, +4] dB', () => {
    // Hot take (-10 LUFS): rawDelta = -10, 50% = -5 dB
    expect(
      computeAutoLevelGain({
        mode: 'gentle',
        workingTakeLufs: -20,
        take: { durationMs: 2000, measuredLufs: -10, measuredRmsDbfs: -11, peakDbfs: -2 },
      }).autoGainDb,
    ).toBe(-5);

    // Whisper take (-32 LUFS): rawDelta = +12, 50% = +6 -> clamped to +4 dB
    const whisper = computeAutoLevelGain({
      mode: 'gentle',
      workingTakeLufs: -20,
      take: { durationMs: 2000, measuredLufs: -32, measuredRmsDbfs: -33, peakDbfs: -20 },
    });
    expect(whisper.autoGainDb).toBe(4);
    expect(whisper.clamped).toBe(true);
  });

  it('falls back safely to RMS on sub-second clips and never blows up a soft sigh', () => {
    const sigh = computeAutoLevelGain({
      mode: 'gentle',
      workingTakeLufs: -20,
      take: { durationMs: 350, measuredLufs: null, measuredRmsDbfs: -34, peakDbfs: -22 },
    });
    expect(sigh.source).toBe('rms_fallback');
    expect(sigh.autoGainDb).toBe(2); // conservative sub-second cap

    const silent = computeAutoLevelGain({
      mode: 'match',
      workingTakeLufs: -20,
      take: { durationMs: 300, measuredLufs: null, measuredRmsDbfs: -96, peakDbfs: -96 },
    });
    expect(silent.source).toBe('silent_guard');
    expect(silent.autoGainDb).toBe(0);
  });

  it('keeps near ear phase-pure (zero primary-ear bleed) and ramps crossfeed smoothly with pan depth', () => {
    const leftGentle = buildPanFilterSegment({
      inputLabel: 'in',
      outputLabel: 'out',
      pan: -0.25,
      headphoneCrossfeed: true,
      sampleRate: 48000,
      uid: 't1',
    });
    // Pan < 0 => near ear (c0 / Left) gets 0.000000 crossfeed, far ear (c1 / Right) gets gentle ramp
    const xfLineLeft = leftGentle.find((l) => l.includes('lowpass=f=4000'))!;
    expect(xfLineLeft).toContain('c0=0.000000*c0|');
    expect(xfLineLeft).not.toContain('c1=0.000000*c0');

    const rightHard = buildPanFilterSegment({
      inputLabel: 'in',
      outputLabel: 'out',
      pan: 0.9,
      headphoneCrossfeed: true,
      sampleRate: 48000,
      uid: 't2',
    });
    // Pan > 0 => near ear (c1 / Right) gets 0.000000 crossfeed, far ear (c0 / Left) gets bleed
    const xfLineRight = rightHard.find((l) => l.includes('lowpass=f=4000'))!;
    expect(xfLineRight).toContain('|c1=0.000000*c0');
    expect(xfLineRight).not.toContain('c0=0.000000*c0');
  });
});

describe('End-to-End Stage-1 + Stage-2 Studio Pipeline (FFmpeg + MockTtsProvider)', () => {
  let tempDataDir: string;
  let store: ProjectStore;
  let service: StudioService;

  beforeEach(async () => {
    tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'thebooth-test-'));
    store = new ProjectStore(tempDataDir);
    service = new StudioService({
      store,
      providers: { mock: new MockTtsProvider() },
      defaultProvider: 'mock',
    });
  });

  afterEach(async () => {
    await fs.rm(tempDataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('stores immutable flat raw takes, preserves them across script replace, and mixes with continuous room tone (no digital vacuum)', async () => {
    const project = await service.createProject({
      id: 'bedtime_test',
      name: 'Bedtime Test',
      audio: { tailMs: 1000 },
    });
    await service.upsertVoice(project.id, 'mara', {
      label: 'Mara',
      provider: 'mock',
      providerVoiceId: 'mock_mara',
      defaultDirection: 'warm, gentle',
      defaultEqPreset: 'intimate',
    });

    const scriptV1 = `
[[voice:mara]]
First gentle line for testing.

[[pause:2]]

Second gentle line after a pause.
`;

    await service.importScript(project.id, { script: scriptV1, mode: 'replace' });
    const { job, project: rendered } = await service.renderAll(project.id);
    expect(job.status).toBe('completed');
    expect(job.completed).toBe(2);

    // Raw takes must live flat at takes/<takeId>.wav and carry Stage-1 telemetry
    const take1 = rendered.cues[0]!.takes[0]!;
    expect(take1.audioPath).toMatch(/^takes\/take_[a-f0-9]+\.wav$/);
    expect(take1.durationMs).toBeGreaterThan(500);
    expect(take1.measuredLufs).not.toBeNull();
    expect(take1.measuredRmsDbfs).toBeGreaterThan(-50);

    // Re-import with a tweak to line 2 only -> line 1's take must be preserved by textHash!
    const scriptV2 = `
[[voice:mara]]
First gentle line for testing.

[[pause:2.5]]

Second line with a brand new ending.
`;
    const reimport = await service.importScript(project.id, {
      script: scriptV2,
      mode: 'replace',
    });
    expect(reimport.preservedTakeCount).toBe(1);
    expect(reimport.project.cues[0]!.activeTakeId).toBe(take1.id);
    expect(reimport.project.cues[1]!.activeTakeId).toBeNull();

    // renderAll should only synthesize the 1 changed cue
    const secondRender = await service.renderAll(project.id);
    expect(secondRender.job.total).toBe(1);
    expect(secondRender.job.completed).toBe(1);

    // Mix to WAV and verify duration + non-silent room tone during the 2.5s pause
    const { exportRecord, telemetry } = await service.mixProject(project.id, {
      format: 'wav',
    });
    const outPath = store.resolveProjectFile(project.id, exportRecord.audioPath);
    const probed = await probeAudio(outPath);

    expect(probed.sampleRate).toBe(48000);
    expect(probed.channels).toBe(2);
    expect(telemetry.truePeakDbtp).toBeLessThanOrEqual(-1.4);

    const { timeline } = await service.getProject(project.id);
    expect(Math.abs(probed.durationMs - timeline.totalDurationMs)).toBeLessThanOrEqual(80);

    // Slice out the middle of the 2.5s pause and assert it is NOT -inf digital vacuum
    const pauseStartSec = ((timeline.cues[0]!.endMs + 400) / 1000).toFixed(3);
    const pauseSlicePath = path.join(tempDataDir, 'pause_slice.wav');
    await runCommand('ffmpeg', [
      '-hide_banner',
      '-y',
      '-ss',
      pauseStartSec,
      '-t',
      '1.2',
      '-i',
      outPath,
      '-c:a',
      'pcm_s16le',
      pauseSlicePath,
    ]);
    const pauseMeasure = await measureAudioLoudness(pauseSlicePath);
    // Warm dark room tone at -54 dBFS should be audible above digital vacuum (-75) and quiet (< -42)
    expect(pauseMeasure.measuredRmsDbfs).toBeGreaterThan(-72);
    expect(pauseMeasure.measuredRmsDbfs).toBeLessThan(-42);
  });

  it('produces accurate constant-power stereo panning and headphone crossfeed bleed', async () => {
    // Hard-left cue with crossfeed ON vs crossfeed OFF
    const pCrossfeed = await service.createProject({
      id: 'pan_xf_on',
      name: 'Pan Crossfeed On',
      includeDefaultRoomTone: false,
      audio: { headphoneCrossfeed: true, tailMs: 200 },
    });
    const { cue: leftCue } = await service.addCue(pCrossfeed.id, {
      speaker: 'mara',
      text: 'Whispering intimately on your left side tonight.',
      mix: { pan: -1.0, eqPreset: 'neutral' },
    });
    await service.renderTake(pCrossfeed.id, leftCue.id);
    const mixOn = await service.mixProject(pCrossfeed.id, { format: 'wav' });

    const [onL, onR] = mixOn.telemetry.channelRmsDbfs;
    expect(onL!).toBeGreaterThan(-30);
    // Crossfeed puts subtle ~15% head-shadowed bleed in Right ear (quiet, but well above digital silence)
    expect(onL! - onR!).toBeGreaterThan(10);
    expect(onL! - onR!).toBeLessThan(28);
    expect(onR!).toBeGreaterThan(-55);

    // Now flip headphoneCrossfeed = false (Stage-2 only, zero re-synthesis!)
    await service.updateProject(pCrossfeed.id, {
      audio: { headphoneCrossfeed: false },
    });
    const mixOff = await service.mixProject(pCrossfeed.id, { format: 'wav' });
    const [offL, offR] = mixOff.telemetry.channelRmsDbfs;
    expect(offL!).toBeGreaterThan(-30);
    // Without crossfeed, pan=-1.0 leaves Right channel essentially silent
    expect(offR!).toBeLessThan(-75);

    // Flip pan to right (+0.75) -> Right ear clearly louder than Left ear
    await service.updateCue(pCrossfeed.id, leftCue.id, { mix: { pan: 0.75 } });
    const mixRight = await service.mixProject(pCrossfeed.id, { format: 'wav' });
    const [rL, rR] = mixRight.telemetry.channelRmsDbfs;
    expect(rR! - rL!).toBeGreaterThan(8);
  });

  it('preserves quiet artistic mixes when masterNormalize=false and limits overlapping peaks cleanly', async () => {
    // Custom mock provider returning hot takes so overlapping dialogue tests true-peak limiting
    const hotService = new StudioService({
      store,
      providers: {
        mock: new MockTtsProvider({
          override: () => ({ durationMs: 1200, peakDbfs: -2 }),
        }),
      },
      defaultProvider: 'mock',
    });

    const project = await hotService.createProject({
      id: 'dynamics_test',
      name: 'Dynamics Test',
      includeDefaultRoomTone: false,
      audio: {
        autoLevel: 'off',
        masterNormalize: false,
        truePeakCeilingDb: -1.5,
        tailMs: 200,
      },
    });

    const c1 = await hotService.addCue(project.id, {
      speaker: 'mara',
      text: 'Overlapping line one.',
      mix: { gainDb: 0 },
    });
    const c2 = await hotService.addCue(project.id, {
      speaker: 'mara',
      text: 'Overlapping line two.',
      timing: { offsetMs: -600 },
      mix: { gainDb: 0 },
    });
    await hotService.renderTake(project.id, c1.cue.id);
    await hotService.renderTake(project.id, c2.cue.id);

    // Overlapping hot takes must be caught by true-peak ceiling (-1.5 dBTP)
    const loudMix = await hotService.mixProject(project.id, { format: 'wav' });
    expect(loudMix.telemetry.truePeakDbtp).toBeLessThanOrEqual(-1.3);

    // Dial both cues down to -16 dB: with masterNormalize=false, mix stays genuinely quiet
    await hotService.updateCue(project.id, c1.cue.id, { mix: { gainDb: -16 } });
    await hotService.updateCue(project.id, c2.cue.id, { mix: { gainDb: -16 } });
    const quietMix = await hotService.mixProject(project.id, { format: 'wav' });
    expect(quietMix.telemetry.integratedLufs!).toBeLessThan(-25);
    expect(loudMix.telemetry.integratedLufs! - quietMix.telemetry.integratedLufs!).toBeGreaterThan(10);

    // Turn masterNormalize=true -> two-pass linear pass lifts toward masterTargetLufs (-18)
    await hotService.updateProject(project.id, {
      audio: { masterNormalize: true, masterTargetLufs: -18 },
    });
    const normMix = await hotService.mixProject(project.id, { format: 'wav' });
    expect(normMix.telemetry.masterNormalizeApplied).toBe(true);
    expect(Math.abs(normMix.telemetry.integratedLufs! - -18)).toBeLessThan(1.5);
  });

  it('applies Stage-2 autoLevel modes (off, gentle, match) non-destructively without altering immutable raw takes', async () => {
    const whisperService = new StudioService({
      store,
      providers: {
        mock: new MockTtsProvider({
          override: () => ({ durationMs: 1500, peakDbfs: -24 }),
        }),
      },
      defaultProvider: 'mock',
    });

    const project = await whisperService.createProject({
      id: 'autolevel_e2e',
      name: 'AutoLevel E2E',
      includeDefaultRoomTone: false,
      audio: { autoLevel: 'off', workingTakeLufs: -20, tailMs: 200 },
    });
    const { cue } = await whisperService.addCue(project.id, {
      speaker: 'mara',
      text: 'A delicate late night whisper for you.',
    });
    const { take } = await whisperService.renderTake(project.id, cue.id);
    const rawWavPath = store.resolveProjectFile(project.id, take.audioPath);
    const rawBytesBefore = await fs.readFile(rawWavPath);

    const mixOff = await whisperService.mixProject(project.id, { format: 'wav' });

    await whisperService.updateProject(project.id, { audio: { autoLevel: 'gentle' } });
    const mixGentle = await whisperService.mixProject(project.id, { format: 'wav' });

    await whisperService.updateProject(project.id, { audio: { autoLevel: 'match' } });
    const mixMatch = await whisperService.mixProject(project.id, { format: 'wav' });

    // off < gentle < match (gentle boosts conservatively; match pulls further toward -20 LUFS)
    expect(mixGentle.telemetry.integratedLufs!).toBeGreaterThan(
      mixOff.telemetry.integratedLufs! + 2,
    );
    expect(mixMatch.telemetry.integratedLufs!).toBeGreaterThan(
      mixGentle.telemetry.integratedLufs! + 3,
    );

    // Immutable raw WAV on disk must be byte-for-byte identical after all Stage-2 mixes
    const rawBytesAfter = await fs.readFile(rawWavPath);
    expect(Buffer.compare(rawBytesBefore, rawBytesAfter)).toBe(0);
  });

  it('supports looped ambient beds with speech sidechain ducking, anchored SFX, and OGG export', async () => {
    await store.ensureDataDirs();
    await fs.writeFile(
      path.join(store.assetsDir, 'rain_window.wav'),
      makeNoiseWav(1500, 0.35),
    );
    await fs.writeFile(
      path.join(store.assetsDir, 'sheets_rustle.wav'),
      makeNoiseWav(400, 0.2),
    );

    const project = await service.createProject({
      id: 'bed_sfx_test',
      name: 'Bed & SFX Test',
      audio: { tailMs: 1000 },
    });

    await service.importScript(project.id, {
      script: `
[[voice:mara]]
[[bed:rain_window gain=-18dB duck=-8dB attack=50ms release=300ms]]

Listening to the rain outside our window tonight while everything slows down.

[[pause:3]]
[[sfx:sheets_rustle anchor=next gain=-10dB pan=0.4 offset=-250ms]]

Rest easy now.
`,
    });

    await service.renderAll(project.id);

    // Export as OGG/Opus and verify probe + telemetry
    const oggMix = await service.mixProject(project.id, { format: 'ogg' });
    const oggPath = store.resolveProjectFile(project.id, oggMix.exportRecord.audioPath);
    const oggProbe = await probeAudio(oggPath);
    expect(oggProbe.codecName).toBe('opus');
    expect(oggProbe.channels).toBe(2);
    expect(oggProbe.durationMs).toBeGreaterThan(4500);
  });

  it('batches speech stems cleanly via intermediate float32 buses when cues exceed batch size', async () => {
    const project = await service.createProject({
      id: 'batch_test',
      name: 'Batch Test',
      includeDefaultRoomTone: false,
      audio: { tailMs: 300 },
    });

    for (let i = 1; i <= 7; i++) {
      await service.addCue(project.id, {
        speaker: 'mara',
        text: `Batch cue number ${i}.`,
        timing: { offsetMs: 100 },
      });
    }
    await service.renderAll(project.id, { concurrency: 3 });

    // Force batching with maxCuesPerBatch = 3 (produces 3 intermediate float32 batches)
    const { exportRecord, telemetry } = await service.mixProject(project.id, {
      format: 'wav',
      maxCuesPerBatch: 3,
    });
    const outPath = store.resolveProjectFile(project.id, exportRecord.audioPath);
    const probed = await probeAudio(outPath);
    const { timeline } = await service.getProject(project.id);

    expect(telemetry.renderedCueCount).toBe(7);
    expect(Math.abs(probed.durationMs - timeline.totalDurationMs)).toBeLessThanOrEqual(80);
    expect(telemetry.integratedLufs).not.toBeNull();
    expect(telemetry.integratedLufs!).toBeGreaterThan(-30);
  });

  it('enforces asset sandbox path traversal protection and project mutation mutex', async () => {
    expect(() => store.resolveAssetPath('../secret.wav')).toThrow(StoreError);
    expect(() => store.resolveAssetPath('C:\\Windows\\system.ini')).toThrow(StoreError);

    const project = await service.createProject({ id: 'mutex_test', name: 'Mutex Test' });
    // Fire 10 concurrent cue additions against the same project; mutex must keep all 10 intact
    await Promise.all(
      Array.from({ length: 10 }, (_, idx) =>
        service.addCue(project.id, {
          id: `cue_${idx}`,
          speaker: 'mara',
          text: `Concurrent cue ${idx}`,
        }),
      ),
    );
    const loaded = await store.requireProject(project.id);
    expect(loaded.cues).toHaveLength(10);
  });
});
