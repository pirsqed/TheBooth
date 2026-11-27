import * as path from 'node:path';
import { z } from 'zod';

export interface AssetLibraryMount {
  alias: string;
  rootDir: string;
  readOnly: true;
}

const EnvSchema = z.object({
  GEMINI_API_KEY: z.string().optional(),
  DATA_DIR: z.string().min(1).default('./data'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3480),
  FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
  FFPROBE_PATH: z.string().min(1).default('ffprobe'),
  GEMINI_TTS_MODEL: z.string().min(1).default('gemini-3.8-flash-tts'),
  GEMINI_DIRECTOR_MODEL: z.string().min(1).default('gemini-3.5-flash'),
  GEMINI_EMBEDDING_MODEL: z.string().min(1).default('gemini-embedding-2'),
  ASSET_EMBEDDING_DIMS: z.coerce.number().int().min(128).max(3072).default(256),
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
  ALLOWED_EXPORT_DIRS: z.string().optional(),
  ASSET_LIBRARY_DIRS: z.string().optional(),
});

export interface AppConfig {
  geminiApiKey?: string;
  dataDir: string;
  port: number;
  ffmpegPath: string;
  ffprobePath: string;
  geminiTtsModel: string;
  geminiDirectorModel: string;
  geminiEmbeddingModel: string;
  assetEmbeddingDims: number;
  geminiSafetyThreshold:
    | 'block_low_and_above'
    | 'block_medium_and_above'
    | 'block_only_high'
    | 'block_none'
    | 'off';
  allowCustomFfmpegFilter: boolean;
  allowedExportDirs?: string[];
  assetLibraryMounts: AssetLibraryMount[];
}

export function slugifyMountAlias(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
  return slug || 'library';
}

/**
 * Parses `ASSET_LIBRARY_DIRS` entries separated by `path.delimiter` (`;` on Windows, `:` on POSIX).
 * Supports optional `alias=path` prefixes (split on first `=` only); reserves `"local"`
 * and auto-suffixes colliding aliases (`-2`, `-3`, ...).
 */
export function parseAssetLibraryDirs(
  raw: string | undefined,
  baseDir?: string,
  delimiter: string = path.delimiter,
): AssetLibraryMount[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [];

  const used = new Set<string>(['local']);
  const mounts: AssetLibraryMount[] = [];

  for (const entry of trimmed.split(delimiter)) {
    const item = entry.trim();
    if (!item) continue;

    const eqIdx = item.indexOf('=');
    let rawAlias: string | undefined;
    let rawPath: string;
    if (eqIdx > 0) {
      rawAlias = item.slice(0, eqIdx).trim();
      rawPath = item.slice(eqIdx + 1).trim();
    } else {
      rawPath = item;
    }
    if (!rawPath) continue;

    const rootDir = baseDir ? path.resolve(baseDir, rawPath) : path.resolve(rawPath);
    const baseSlug = slugifyMountAlias(rawAlias || path.basename(rootDir));

    let alias = baseSlug;
    let suffix = 2;
    while (used.has(alias)) {
      alias = `${baseSlug}-${suffix}`;
      suffix += 1;
    }
    used.add(alias);

    mounts.push({
      alias,
      rootDir,
      readOnly: true,
    });
  }

  return mounts;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, baseDir?: string): AppConfig {
  const parsed = EnvSchema.parse(env);
  const rawExportDirs = parsed.ALLOWED_EXPORT_DIRS?.trim();
  const allowedExportDirs = rawExportDirs
    ? rawExportDirs
        .split(path.delimiter)
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => (baseDir ? path.resolve(baseDir, d) : path.resolve(d)))
    : undefined;

  const assetLibraryMounts = parseAssetLibraryDirs(parsed.ASSET_LIBRARY_DIRS, baseDir);

  return {
    geminiApiKey: parsed.GEMINI_API_KEY || undefined,
    dataDir: baseDir ? path.resolve(baseDir, parsed.DATA_DIR) : path.resolve(parsed.DATA_DIR),
    port: parsed.PORT,
    ffmpegPath: parsed.FFMPEG_PATH,
    ffprobePath: parsed.FFPROBE_PATH,
    geminiTtsModel: parsed.GEMINI_TTS_MODEL,
    geminiDirectorModel: parsed.GEMINI_DIRECTOR_MODEL,
    geminiEmbeddingModel: parsed.GEMINI_EMBEDDING_MODEL,
    assetEmbeddingDims: parsed.ASSET_EMBEDDING_DIMS,
    geminiSafetyThreshold: parsed.GEMINI_SAFETY_THRESHOLD,
    allowCustomFfmpegFilter: parsed.ALLOW_CUSTOM_FFMPEG_FILTER ?? false,
    allowedExportDirs: allowedExportDirs && allowedExportDirs.length > 0 ? allowedExportDirs : undefined,
    assetLibraryMounts,
  };
}
