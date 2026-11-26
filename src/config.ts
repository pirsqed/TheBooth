import * as path from 'node:path';
import { z } from 'zod';

const EnvSchema = z.object({
  GEMINI_API_KEY: z.string().optional(),
  DATA_DIR: z.string().min(1).default('./data'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3480),
  FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
  FFPROBE_PATH: z.string().min(1).default('ffprobe'),
  GEMINI_TTS_MODEL: z.string().min(1).default('gemini-3.8-flash-tts'),
  GEMINI_DIRECTOR_MODEL: z.string().min(1).default('gemini-3.5-flash'),
  GEMINI_SAFETY_THRESHOLD: z
    .enum([
      'block_low_and_above',
      'block_medium_and_above',
      'block_only_high',
      'block_none',
      'off',
    ])
    .default('off'),
  ALLOW_CUSTOM_FFMPEG_FILTER: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
});

export interface AppConfig {
  geminiApiKey?: string;
  dataDir: string;
  port: number;
  ffmpegPath: string;
  ffprobePath: string;
  geminiTtsModel: string;
  geminiDirectorModel: string;
  geminiSafetyThreshold:
    | 'block_low_and_above'
    | 'block_medium_and_above'
    | 'block_only_high'
    | 'block_none'
    | 'off';
  allowCustomFfmpegFilter: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  return {
    geminiApiKey: parsed.GEMINI_API_KEY || undefined,
    dataDir: path.resolve(parsed.DATA_DIR),
    port: parsed.PORT,
    ffmpegPath: parsed.FFMPEG_PATH,
    ffprobePath: parsed.FFPROBE_PATH,
    geminiTtsModel: parsed.GEMINI_TTS_MODEL,
    geminiDirectorModel: parsed.GEMINI_DIRECTOR_MODEL,
    geminiSafetyThreshold: parsed.GEMINI_SAFETY_THRESHOLD,
    allowCustomFfmpegFilter: parsed.ALLOW_CUSTOM_FFMPEG_FILTER ?? false,
  };
}
