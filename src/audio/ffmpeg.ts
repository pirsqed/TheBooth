import { spawn } from 'node:child_process';

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

export function runCommand(
  binary: string,
  args: string[],
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      reject(new Error(`Failed to execute "${binary}": ${err.message}`));
    });

    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const exitCode = code ?? -1;
      if (exitCode !== 0) {
        reject(
          new FfmpegError(
            `${binary} exited with code ${exitCode}: ${stderr.slice(-800)}`,
            stderr,
            exitCode,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });
  });
}

export interface AudioProbeInfo {
  durationMs: number;
  sampleRate: number;
  channels: number;
  codecName: string;
}

export async function probeAudio(
  filePath: string,
  ffprobePath = 'ffprobe',
): Promise<AudioProbeInfo> {
  const { stdout } = await runCommand(ffprobePath, [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=codec_name,sample_rate,channels,duration:format=duration',
    '-of',
    'json',
    filePath,
  ]);

  const parsed = JSON.parse(stdout) as {
    streams?: Array<{
      codec_name?: string;
      sample_rate?: string;
      channels?: number;
      duration?: string;
    }>;
    format?: {
      duration?: string;
    };
  };

  const stream = parsed.streams?.[0];
  if (!stream) {
    throw new Error(`No audio stream found in ${filePath}`);
  }

  const rawDuration = stream.duration ?? parsed.format?.duration;
  const durationSec = rawDuration ? Number(rawDuration) : 0;
  const sampleRate = stream.sample_rate ? Number(stream.sample_rate) : 0;
  const channels = stream.channels ?? 0;

  return {
    durationMs: Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : 0,
    sampleRate,
    channels,
    codecName: stream.codec_name ?? 'unknown',
  };
}

export interface LoudnessMeasurement {
  /** Integrated LUFS from ebur128 (null if sub-second / -inf / gated out) */
  measuredLufs: number | null;
  /** Overall RMS level in dBFS from astats */
  measuredRmsDbfs: number;
  /** Sample peak in dBFS from astats */
  peakDbfs: number;
  /** True peak in dBTP from ebur128 */
  truePeakDbtp: number;
  /** Per-channel RMS dBFS (index 0 = L, index 1 = R when stereo) */
  channelRmsDbfs: number[];
}

function parseDbNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '-inf' || trimmed === 'inf' || trimmed === 'nan') {
    return null;
  }
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

/**
 * Single-pass read-only audio measurement combining EBU R128 (integrated LUFS + true peak)
 * and astats (overall RMS, sample peak, and per-channel RMS).
 */
export async function measureAudioLoudness(
  filePath: string,
  ffmpegPath = 'ffmpeg',
): Promise<LoudnessMeasurement> {
  const { stderr } = await runCommand(ffmpegPath, [
    '-hide_banner',
    '-nostats',
    '-i',
    filePath,
    '-filter_complex',
    '[0:a]asplit=2[m1][m2];[m1]ebur128=peak=true[o1];[m2]astats=metadata=0:reset=0[o2]',
    '-map',
    '[o1]',
    '-f',
    'null',
    '-',
    '-map',
    '[o2]',
    '-f',
    'null',
    '-',
  ]);

  // Parse ebur128 Summary section
  const summaryMatch = stderr.match(/Summary:[\s\S]*$/);
  const summaryText = summaryMatch ? summaryMatch[0] : stderr;

  const lufsMatch = summaryText.match(/Integrated loudness:[\s\S]*?I:\s*([+-]?\d+(?:\.\d+)?|-inf)\s*LUFS/i);
  let measuredLufs = parseDbNumber(lufsMatch?.[1]);
  if (measuredLufs !== null && measuredLufs <= -69.5) {
    // EBU R128 returns -70.0 LUFS for digital silence or fully gated sub-second clips
    measuredLufs = null;
  }

  const truePeakMatch = summaryText.match(/True peak:[\s\S]*?Peak:\s*([+-]?\d+(?:\.\d+)?|-inf)\s*dBFS/i);
  const truePeakParsed = parseDbNumber(truePeakMatch?.[1]);

  // Parse astats per-channel and Overall blocks
  const channelRmsDbfs: number[] = [];
  const channelBlockRegex = /Channel:\s*(\d+)[\s\S]*?(?=Channel:\s*\d+|Overall|$)/g;
  let chMatch: RegExpExecArray | null;
  while ((chMatch = channelBlockRegex.exec(stderr)) !== null) {
    const block = chMatch[0];
    const rmsMatch = block.match(/RMS level dB:\s*([+-]?\d+(?:\.\d+)?|-inf)/i);
    const val = parseDbNumber(rmsMatch?.[1]);
    channelRmsDbfs.push(val ?? -96);
  }

  const overallMatch = stderr.match(/Overall[\s\S]*$/);
  const overallText = overallMatch ? overallMatch[0] : stderr;

  const overallRmsMatch = overallText.match(/RMS level dB:\s*([+-]?\d+(?:\.\d+)?|-inf)/i);
  const overallPeakMatch = overallText.match(/Peak level dB:\s*([+-]?\d+(?:\.\d+)?|-inf)/i);

  const measuredRmsDbfs = parseDbNumber(overallRmsMatch?.[1]) ?? -96;
  const peakDbfs = parseDbNumber(overallPeakMatch?.[1]) ?? truePeakParsed ?? -96;
  const truePeakDbtp = truePeakParsed ?? peakDbfs;

  return {
    measuredLufs,
    measuredRmsDbfs,
    peakDbfs,
    truePeakDbtp,
    channelRmsDbfs,
  };
}
