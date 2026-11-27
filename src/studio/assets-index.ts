import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { measureAssetLevels, probeAudioWithTags, runCommand } from '../audio/ffmpeg.js';
import {
  ALLOWED_ASSET_EXTENSIONS,
  ProjectStore,
  StoreError,
  atomicWriteFile,
} from './store.js';

export type AssetKind = 'sfx' | 'bed';

export interface CatalogSidecarEntry {
  description?: string;
  tags?: string[];
  kind?: AssetKind;
  license?: string;
  loopable?: boolean;
  multiVariation?: boolean;
}

const CatalogSidecarEntrySchema = z.object({
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  kind: z.enum(['sfx', 'bed']).optional(),
  license: z.string().optional(),
  loopable: z.boolean().optional(),
  multiVariation: z.boolean().optional(),
});

const CatalogSidecarFileSchema = z.record(z.string(), CatalogSidecarEntrySchema);

export interface AssetCaptionResult {
  caption: string;
  tags: string[];
  kind: AssetKind;
  loopable: boolean;
  multiVariation: boolean;
}

const AssetCaptionResultSchema = z.object({
  caption: z.string().min(1),
  tags: z.array(z.string()).default([]),
  kind: z.enum(['sfx', 'bed']).default('sfx'),
  loopable: z.boolean().default(false),
  multiVariation: z.boolean().default(false),
});

export interface AssetEnricher {
  captionAudio?(input: {
    oggBuffer: Buffer;
    assetPath: string;
    durationSec: number;
    existingDescription?: string;
  }): Promise<AssetCaptionResult>;
  embedTexts?(input: {
    texts: string[];
    taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';
    model: string;
    outputDimensionality: number;
  }): Promise<number[][]>;
}

export interface IndexedAssetEntry {
  assetPath: string;
  mount: string;
  readOnly: boolean;
  sizeBytes: number;
  mtimeMs: number;
  extension: string;
  durationMs: number;
  sampleRate: number;
  channels: number;
  codecName: string;
  rmsDbfs?: number;
  peakDbfs?: number;
  suggestedKind: AssetKind;
  bwfDescription?: string;
  embeddedTags?: Record<string, string>;
  sidecarDescription?: string;
  sidecarTags?: string[];
  sidecarKind?: AssetKind;
  license?: string;
  loopable?: boolean;
  aiCaption?: string;
  aiTags?: string[];
  aiKind?: AssetKind;
  aiLoopable?: boolean;
  multiVariation?: boolean;
  ucsExpanded?: string[];
  embeddingRow?: number;
  embeddingCardHash?: string;
}

export interface AssetIndexMountSummary {
  alias: string;
  readOnly: boolean;
  assetCount: number;
}

export interface AssetIndexManifest {
  schemaVersion: 1;
  indexedAt: string;
  embeddingModel: string | null;
  embeddingDims: number | null;
  embeddingRowCount: number;
  mounts: AssetIndexMountSummary[];
  assets: IndexedAssetEntry[];
}

export interface IndexAssetsOptions {
  mounts?: string[];
  forceReprobe?: boolean;
  concurrency?: number;
  enrichCaptions?: boolean;
  maxCaptionCount?: number;
  onlyMissingDescriptions?: boolean;
  enrichEmbeddings?: boolean;
  onProgress?: (progress: { completed: number; total: number }) => void;
}

export interface IndexAssetsSummary {
  indexedAt: string;
  totalAssets: number;
  scannedFiles: number;
  reusedCached: number;
  probedFiles: number;
  removedStale: number;
  captionedCount: number;
  embeddedCount: number;
  embeddingModel: string | null;
  embeddingDims: number | null;
  mounts: AssetIndexMountSummary[];
  warnings: string[];
}

export interface AssetSearchOptions {
  query: string;
  kind?: 'sfx' | 'bed' | 'any';
  mount?: string;
  minDurationSec?: number;
  maxDurationSec?: number;
  stereoOnly?: boolean;
  limit?: number;
}

export interface AssetSearchHit {
  assetPath: string;
  mount: string;
  readOnly: boolean;
  durationSec: number;
  channels: number;
  sampleRate: number;
  rmsDbfs?: number;
  peakDbfs?: number;
  suggestedKind: AssetKind;
  description: string;
  tags: string[];
  loopable?: boolean;
  multiVariation?: boolean;
  license?: string;
  score: number;
}

export interface AssetSearchResult {
  indexed: boolean;
  mode: 'bm25' | 'hybrid';
  totalIndexed: number;
  totalMatchingFilter: number;
  mounts: Array<{ alias: string; readOnly: boolean; indexedCount: number }>;
  results: AssetSearchHit[];
  warnings?: string[];
  hint?: string;
}

/**
 * Lightweight Universal Category System (UCS) CatID prefix & common foley shorthand expansion map.
 */
const UCS_PREFIX_EXPANSIONS: Array<[string, string[]]> = [
  ['weatrain', ['weather', 'rain', 'storm', 'precipitation']],
  ['weatwind', ['weather', 'wind', 'breeze', 'gust']],
  ['weatthun', ['weather', 'thunder', 'storm', 'lightning']],
  ['weatsnow', ['weather', 'snow', 'blizzard', 'winter']],
  ['weathail', ['weather', 'hail', 'storm']],
  ['doorwood', ['door', 'wood', 'wooden', 'entry']],
  ['doormetl', ['door', 'metal', 'iron', 'gate']],
  ['doorcrek', ['door', 'creak', 'squeak', 'hinge']],
  ['doorslam', ['door', 'slam', 'shut', 'bang']],
  ['doorltch', ['door', 'latch', 'knob', 'handle', 'lock']],
  ['dooropen', ['door', 'open']],
  ['doorclos', ['door', 'close', 'shut']],
  ['glassbrk', ['glass', 'break', 'shatter', 'smash', 'crash']],
  ['glasbrk', ['glass', 'break', 'shatter', 'smash', 'crash']],
  ['glascrsh', ['glass', 'crash', 'shatter', 'break']],
  ['glasshtr', ['glass', 'shatter', 'break', 'mirror']],
  ['anmlwolf', ['animal', 'wolf', 'howl', 'canine']],
  ['anmlbird', ['animal', 'bird', 'chirp', 'wings']],
  ['anmlhors', ['animal', 'horse', 'hooves', 'gallop', 'carriage']],
  ['anmldog', ['animal', 'dog', 'bark', 'growl']],
  ['anmlcat', ['animal', 'cat', 'meow', 'hiss']],
  ['anmlbat', ['animal', 'bat', 'wings', 'flutter']],
  ['anmlinsc', ['animal', 'insect', 'cricket', 'night']],
  ['firecrkl', ['fire', 'crackle', 'fireplace', 'hearth', 'flame']],
  ['fireburn', ['fire', 'burn', 'flame', 'blaze']],
  ['firetrch', ['fire', 'torch', 'whoosh', 'flame']],
  ['footstep', ['footsteps', 'walk', 'steps', 'foley']],
  ['footwood', ['footsteps', 'wood', 'floor', 'creak']],
  ['footgrvl', ['footsteps', 'gravel', 'crunch', 'walk']],
  ['footstne', ['footsteps', 'stone', 'cobblestone', 'walk']],
  ['watrrain', ['water', 'rain', 'drops']],
  ['watrocn', ['water', 'ocean', 'waves', 'sea', 'surf']],
  ['watrstrm', ['water', 'stream', 'creek', 'brook', 'river']],
  ['watrdrip', ['water', 'drip', 'droplet', 'cave']],
  ['ambint', ['ambience', 'ambient', 'interior', 'room', 'tone']],
  ['ambext', ['ambience', 'ambient', 'exterior', 'outdoor']],
  ['ambforst', ['ambience', 'ambient', 'forest', 'woods', 'nature']],
  ['ambcity', ['ambience', 'ambient', 'city', 'urban', 'traffic']],
  ['ambnght', ['ambience', 'ambient', 'night', 'crickets']],
  ['ambwind', ['ambience', 'ambient', 'wind', 'howling']],
  ['ambcav', ['ambience', 'ambient', 'cave', 'cavern', 'dungeon']],
  ['vehcarr', ['vehicle', 'carriage', 'wagon', 'wheels', 'horse']],
  ['vehtran', ['vehicle', 'train', 'rail', 'locomotive']],
  ['vehboat', ['vehicle', 'boat', 'ship', 'sailing', 'sea']],
  ['folyclth', ['foley', 'cloth', 'fabric', 'rustle', 'movement']],
  ['folymetl', ['foley', 'metal', 'clank', 'chain', 'key']],
  ['folywood', ['foley', 'wood', 'creak', 'knock']],
  ['folypapr', ['foley', 'paper', 'page', 'book', 'rustle']],
  ['bellchur', ['bell', 'church', 'toll', 'chime', 'clock']],
  ['bellchme', ['bell', 'chime', 'ring']],
  ['clcktick', ['clock', 'tick', 'tock', 'pendulum']],
];

const TOKEN_SHORTHAND_MAP: Record<string, string[]> = {
  amb: ['ambience', 'ambient', 'bed'],
  anml: ['animal'],
  brk: ['break', 'shatter'],
  carr: ['carriage', 'wagon'],
  clth: ['cloth', 'fabric'],
  creak: ['creak', 'creaking', 'squeak'],
  crek: ['creak', 'creaking', 'squeak'],
  crkl: ['crackle', 'crackling'],
  crsh: ['crash', 'smash'],
  ext: ['exterior', 'outdoor'],
  foly: ['foley'],
  foley: ['foley'],
  foot: ['footsteps', 'steps'],
  glas: ['glass'],
  grvl: ['gravel'],
  int: ['interior', 'indoor'],
  ltch: ['latch', 'lock'],
  metl: ['metal', 'metallic'],
  nght: ['night', 'nocturnal'],
  ocn: ['ocean', 'sea', 'waves'],
  papr: ['paper'],
  rain: ['rain', 'rainfall'],
  sfx: ['sfx', 'effect'],
  shtr: ['shatter', 'break'],
  stne: ['stone'],
  strm: ['stream', 'storm'],
  thun: ['thunder', 'thunderclap'],
  veh: ['vehicle'],
  watr: ['water'],
  weat: ['weather'],
  wind: ['wind', 'gust', 'howling'],
};

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'and',
  'or',
  'with',
  'from',
  'by',
  'wav',
  'ogg',
  'mp3',
  'flac',
  'm4a',
]);

/**
 * Splits camelCase, ALLCAPS+Word boundaries (`GLASSBrk`), underscores, hyphens, slashes,
 * and spaces into lowercase searchable tokens.
 */
export function tokenizeAssetText(input: string): string[] {
  if (!input) return [];
  const expanded = input
    // Split transitions like `GLASSBrk` -> `GLASS Brk` and `doorWood` -> `door Wood`
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();

  const rawTokens = expanded.split(/[^a-z0-9]+/g).filter(Boolean);
  const out: string[] = [];
  for (const tok of rawTokens) {
    if (tok.length <= 1) continue;
    if (/^\d+$/.test(tok)) continue;
    if (STOP_WORDS.has(tok)) continue;
    out.push(tok);
  }
  return out;
}

/**
 * Expands UCS CatID prefixes (e.g. `GLASSBrk_Mirror_01.wav`, `WEATRain`) and common
 * audio library abbreviations into natural-language searchable keywords.
 */
export function expandUcsTokens(assetPath: string): string[] {
  const baseName = path.posix.basename(
    assetPath.replace(/\\/g, '/'),
    path.posix.extname(assetPath),
  );
  const firstSegment = baseName.split(/[_\-\s]+/)[0]?.toLowerCase() ?? '';
  const expanded = new Set<string>();

  if (firstSegment) {
    for (const [prefix, words] of UCS_PREFIX_EXPANSIONS) {
      if (firstSegment === prefix || firstSegment.startsWith(prefix)) {
        for (const w of words) expanded.add(w);
      }
    }
  }

  for (const tok of tokenizeAssetText(baseName)) {
    const mapped = TOKEN_SHORTHAND_MAP[tok];
    if (mapped) {
      for (const w of mapped) expanded.add(w);
    }
  }

  return Array.from(expanded);
}

/**
 * L2-normalizes a vector into a unit-length `Float32Array`.
 */
export function l2Normalize(vec: ArrayLike<number>): Float32Array {
  const out = new Float32Array(vec.length);
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = Number(vec[i] ?? 0);
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (norm > 1e-12) {
    const inv = 1 / norm;
    for (let i = 0; i < vec.length; i++) {
      out[i] = Number(vec[i] ?? 0) * inv;
    }
  }
  return out;
}

/**
 * Computes dot product (cosine similarity for unit-normalized vectors) between
 * row `rowIdx` of a flat `Float32Array` matrix and a unit query vector.
 */
export function cosineSimilarityRow(
  matrix: Float32Array,
  rowIdx: number,
  dims: number,
  queryVec: Float32Array,
): number {
  const offset = rowIdx * dims;
  if (offset < 0 || offset + dims > matrix.length || queryVec.length !== dims) {
    return 0;
  }
  let dot = 0;
  for (let i = 0; i < dims; i++) {
    dot += matrix[offset + i]! * queryVec[i]!;
  }
  return dot;
}

function extractBwfDescription(tags: Record<string, string>): string | undefined {
  const priorityKeys = [
    'description',
    'comment',
    'icmt',
    'title',
    'inam',
    'subject',
    'isbj',
    'genre',
    'iart',
    'originator',
  ];
  const lowerMap = new Map<string, string>();
  for (const [k, v] of Object.entries(tags)) {
    lowerMap.set(k.toLowerCase(), v);
  }
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const key of priorityKeys) {
    const val = lowerMap.get(key);
    if (!val) continue;
    const cleaned = val.replace(/\s+/g, ' ').trim();
    if (!cleaned || seen.has(cleaned.toLowerCase())) continue;
    seen.add(cleaned.toLowerCase());
    parts.push(cleaned);
  }
  return parts.length > 0 ? parts.join(' | ') : undefined;
}

export function getEffectiveKind(entry: IndexedAssetEntry): AssetKind {
  return entry.sidecarKind ?? entry.aiKind ?? entry.suggestedKind;
}

export function getEffectiveDescription(entry: IndexedAssetEntry): string {
  const parts: string[] = [];
  if (entry.sidecarDescription) parts.push(entry.sidecarDescription);
  if (entry.aiCaption && entry.aiCaption !== entry.sidecarDescription) {
    parts.push(entry.aiCaption);
  }
  if (entry.bwfDescription && !parts.includes(entry.bwfDescription)) {
    parts.push(entry.bwfDescription);
  }
  if (parts.length > 0) return parts.join(' — ');
  const tokens = [
    ...tokenizeAssetText(path.posix.basename(entry.assetPath, entry.extension)),
    ...(entry.ucsExpanded ?? []),
  ];
  return Array.from(new Set(tokens)).join(' ');
}

export function getEffectiveTags(entry: IndexedAssetEntry): string[] {
  const set = new Set<string>();
  for (const t of entry.sidecarTags ?? []) set.add(t.toLowerCase().trim());
  for (const t of entry.aiTags ?? []) set.add(t.toLowerCase().trim());
  for (const t of entry.ucsExpanded ?? []) set.add(t.toLowerCase().trim());
  if (entry.multiVariation) set.add('multi_variation');
  set.delete('');
  return Array.from(set);
}

export function buildSearchableCard(entry: IndexedAssetEntry): string {
  const durationSec = entry.durationMs / 1000;
  const durationBucket =
    durationSec < 2
      ? 'very short spot hit'
      : durationSec < 12
        ? 'short sound effect'
        : durationSec < 45
          ? 'medium ambience bed'
          : 'long continuous ambient bed';
  const kind = getEffectiveKind(entry);
  const pathTokens = tokenizeAssetText(entry.assetPath).join(' ');
  const ucs = (entry.ucsExpanded ?? []).join(' ');
  const tags = getEffectiveTags(entry).join(', ');
  const desc = getEffectiveDescription(entry);
  return [
    `Kind: ${kind} (${durationBucket}, ${durationSec.toFixed(1)}s, ${entry.channels >= 2 ? 'stereo' : 'mono'})`,
    `Path: ${pathTokens}`,
    ucs ? `Category: ${ucs}` : '',
    desc ? `Description: ${desc}` : '',
    tags ? `Tags: ${tags}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

async function loadCatalogSidecar(rootDir: string): Promise<Map<string, CatalogSidecarEntry>> {
  const map = new Map<string, CatalogSidecarEntry>();
  const sidecarPath = path.join(rootDir, 'catalog.json');
  try {
    const raw = await fs.readFile(sidecarPath, 'utf8');
    const parsed = CatalogSidecarFileSchema.parse(JSON.parse(raw));
    for (const [relKey, value] of Object.entries(parsed)) {
      const normalizedKey = relKey.replace(/\\/g, '/').replace(/^\/+/, '');
      map.set(normalizedKey, value);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      // Malformed catalog.json shouldn't crash indexing; silently ignore or handle upstream
    }
  }
  return map;
}

interface ScannedDiskFile {
  assetPath: string;
  relPath: string;
  absPath: string;
  mount: string;
  readOnly: boolean;
  sizeBytes: number;
  mtimeMs: number;
  extension: string;
  sidecar?: CatalogSidecarEntry;
}

async function walkAssetMount(
  rootDir: string,
  mountAlias: string,
  readOnly: boolean,
  warnings: string[],
): Promise<ScannedDiskFile[]> {
  try {
    const st = await fs.stat(rootDir);
    if (!st.isDirectory()) {
      warnings.push(`Asset mount "${mountAlias}" path is not a directory: ${rootDir}`);
      return [];
    }
  } catch {
    if (readOnly) {
      warnings.push(`External asset mount "@${mountAlias}" directory not found: ${rootDir}`);
    }
    return [];
  }

  const sidecarMap = await loadCatalogSidecar(rootDir);
  const files: ScannedDiskFile[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Could not read directory "${dir}": ${msg}`);
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.endsWith('.tmp')) continue;
      // Explicitly skip symlinks to prevent directory loops and sandbox escapes
      if (entry.isSymbolicLink()) continue;

      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!ALLOWED_ASSET_EXTENSIONS.has(ext)) continue;
        try {
          const st = await fs.stat(abs);
          const relPath = path.relative(rootDir, abs).replace(/\\/g, '/');
          const assetPath = readOnly ? `@${mountAlias}/${relPath}` : relPath;
          files.push({
            assetPath,
            relPath,
            absPath: abs,
            mount: mountAlias,
            readOnly,
            sizeBytes: st.size,
            mtimeMs: Math.round(st.mtimeMs),
            extension: ext,
            sidecar: sidecarMap.get(relPath),
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          warnings.push(`Could not stat "${abs}": ${msg}`);
        }
      }
    }
  };

  await walk(rootDir);
  files.sort((a, b) => a.assetPath.localeCompare(b.assetPath));
  return files;
}

/**
 * Gemini-backed optional asset enricher (Pass 2 audio captioning via `gemini-3.5-flash`
 * and semantic embeddings via `gemini-embedding-2`).
 */
export class GeminiAssetEnricher implements AssetEnricher {
  private client: GoogleGenAI | null = null;
  private readonly apiKey: string;
  private readonly captionModel: string;

  constructor(options: { apiKey: string; captionModel?: string }) {
    this.apiKey = options.apiKey;
    this.captionModel = options.captionModel ?? 'gemini-3.5-flash';
  }

  private getClient(): GoogleGenAI {
    if (!this.client) {
      this.client = new GoogleGenAI({
        apiKey: this.apiKey,
        httpOptions: { apiVersion: 'v1beta' },
      });
    }
    return this.client;
  }

  async captionAudio(input: {
    oggBuffer: Buffer;
    assetPath: string;
    durationSec: number;
    existingDescription?: string;
  }): Promise<AssetCaptionResult> {
    const client = this.getClient() as unknown as {
      interactions: {
        create(params: Record<string, unknown>): Promise<{
          status?: string;
          output_text?: string;
          steps?: Array<{
            type?: string;
            content?: Array<{ type?: string; text?: string }>;
          }>;
        }>;
      };
    };

    const promptLines = [
      'You are an expert foley artist and sound effects librarian cataloging an audio clip for radio drama production.',
      `Filename/path hint: ${input.assetPath}`,
      `Full file duration: ${input.durationSec.toFixed(2)} seconds`,
      input.existingDescription ? `Existing metadata hint: ${input.existingDescription}` : '',
      '',
      'Listen carefully to the audio clip and return strict JSON describing what you actually hear:',
      '- caption: concise, concrete sonic description (material, action, space/reverb, texture, intensity)',
      '- tags: 4 to 10 lowercase single-word or snake_case searchable sound tags',
      '- kind: "sfx" for discrete spot effects or "bed" for continuous ambiences/textures',
      '- loopable: true if this sounds like a continuous texture suitable for looping',
      '- multiVariation: true if the file contains multiple separate distinct hits/variations separated by pauses',
    ].filter(Boolean);

    const interaction = await client.interactions.create({
      model: this.captionModel,
      store: false,
      input: [
        {
          type: 'user_input',
          content: [
            { type: 'text', text: promptLines.join('\n') },
            {
              type: 'audio',
              data: input.oggBuffer.toString('base64'),
              mime_type: 'audio/ogg',
            },
          ],
        },
      ],
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: {
          type: 'object',
          properties: {
            caption: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            kind: { type: 'string', enum: ['sfx', 'bed'] },
            loopable: { type: 'boolean' },
            multiVariation: { type: 'boolean' },
          },
          required: ['caption', 'tags', 'kind', 'loopable', 'multiVariation'],
        },
      },
      safety_settings: [
        { type: 'hate_speech', threshold: 'off' },
        { type: 'harassment', threshold: 'off' },
        { type: 'sexually_explicit', threshold: 'off' },
        { type: 'dangerous_content', threshold: 'off' },
      ],
    });

    let rawText = interaction.output_text;
    if (!rawText && Array.isArray(interaction.steps)) {
      for (const step of interaction.steps) {
        if (step.type === 'model_output' && Array.isArray(step.content)) {
          const textPart = step.content.find(
            (c) => c.type === 'text' && typeof c.text === 'string',
          );
          if (textPart?.text) {
            rawText = textPart.text;
            break;
          }
        }
      }
    }
    if (!rawText) {
      throw new Error(`Gemini captioner returned no text (status: ${interaction.status ?? 'unknown'})`);
    }

    const cleaned = rawText
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    return AssetCaptionResultSchema.parse(JSON.parse(cleaned));
  }

  async embedTexts(input: {
    texts: string[];
    taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';
    model: string;
    outputDimensionality: number;
  }): Promise<number[][]> {
    if (input.texts.length === 0) return [];
    const client = this.getClient();
    const batchSize = 32;
    const allVectors: number[][] = [];

    for (let i = 0; i < input.texts.length; i += batchSize) {
      const slice = input.texts.slice(i, i + batchSize);
      const response = await client.models.embedContent({
        model: input.model,
        contents: slice,
        config: {
          outputDimensionality: input.outputDimensionality,
          taskType: input.taskType,
        },
      });
      const embeddings = response.embeddings ?? [];
      if (embeddings.length !== slice.length) {
        throw new Error(
          `Expected ${slice.length} embeddings from ${input.model}, received ${embeddings.length}`,
        );
      }
      for (const emb of embeddings) {
        if (!emb.values || emb.values.length === 0) {
          throw new Error(`Empty embedding vector returned by ${input.model}`);
        }
        allVectors.push(emb.values);
      }
    }

    return allVectors;
  }
}

export interface AssetIndexServiceOptions {
  store: ProjectStore;
  ffmpegPath?: string;
  ffprobePath?: string;
  enricher?: AssetEnricher;
  embeddingModel?: string;
  embeddingDims?: number;
}

interface LoadedIndexState {
  manifest: AssetIndexManifest;
  embeddings: Float32Array | null;
  warnings: string[];
}

interface Bm25Doc {
  entry: IndexedAssetEntry;
  termWeights: Map<string, number>;
  docLen: number;
}

function buildBm25Doc(entry: IndexedAssetEntry): Bm25Doc {
  const termWeights = new Map<string, number>();
  const addTokens = (tokens: string[], weight: number) => {
    for (const tok of tokens) {
      termWeights.set(tok, (termWeights.get(tok) ?? 0) + weight);
    }
  };

  // High weight: explicit human/AI descriptions & curated tags
  if (entry.sidecarDescription) {
    addTokens(tokenizeAssetText(entry.sidecarDescription), 3.5);
  }
  if (entry.sidecarTags) {
    addTokens(tokenizeAssetText(entry.sidecarTags.join(' ')), 3.2);
  }
  if (entry.aiCaption) {
    addTokens(tokenizeAssetText(entry.aiCaption), 3.0);
  }
  if (entry.aiTags) {
    addTokens(tokenizeAssetText(entry.aiTags.join(' ')), 2.8);
  }
  if (entry.bwfDescription) {
    addTokens(tokenizeAssetText(entry.bwfDescription), 3.0);
  }

  // Medium weight: filename + UCS expansion
  const fileBase = path.posix.basename(entry.assetPath, entry.extension);
  addTokens(tokenizeAssetText(fileBase), 2.2);
  if (entry.ucsExpanded) {
    addTokens(entry.ucsExpanded, 2.0);
  }

  // Base weight: folder hierarchy & kind
  const folder = path.posix.dirname(entry.assetPath.replace(/^@[^/]+\//, ''));
  if (folder && folder !== '.') {
    addTokens(tokenizeAssetText(folder), 1.2);
  }
  addTokens([getEffectiveKind(entry)], 0.5);

  let docLen = 0;
  for (const w of termWeights.values()) docLen += w;
  return { entry, termWeights, docLen };
}

/**
 * Pure TypeScript BM25 scorer with weighted fields and soft prefix matching
 * (so "shatter" matches "shattering" and "creak" matches "creaking").
 */
export function scoreAssetsBm25(
  entries: IndexedAssetEntry[],
  query: string,
): Map<string, number> {
  const scores = new Map<string, number>();
  const queryTerms = Array.from(new Set(tokenizeAssetText(query)));
  if (queryTerms.length === 0 || entries.length === 0) {
    return scores;
  }

  const docs = entries.map(buildBm25Doc);
  const N = docs.length;
  const avgDocLen =
    docs.reduce((sum, d) => sum + d.docLen, 0) / Math.max(1, N);

  const k1 = 1.5;
  const b = 0.75;

  const docFreq = new Map<string, number>();
  for (const qt of queryTerms) {
    let df = 0;
    for (const doc of docs) {
      if (doc.termWeights.has(qt)) {
        df += 1;
      } else if (qt.length >= 4) {
        for (const dt of doc.termWeights.keys()) {
          if (dt.startsWith(qt) || (dt.length >= 4 && qt.startsWith(dt))) {
            df += 1;
            break;
          }
        }
      }
    }
    docFreq.set(qt, df);
  }

  for (const doc of docs) {
    let total = 0;
    for (const qt of queryTerms) {
      let tf = doc.termWeights.get(qt) ?? 0;
      if (tf === 0 && qt.length >= 4) {
        // Soft prefix match at 0.7x weight
        for (const [dt, weight] of doc.termWeights.entries()) {
          if (dt.startsWith(qt) || (dt.length >= 4 && qt.startsWith(dt))) {
            tf = Math.max(tf, weight * 0.7);
          }
        }
      }
      if (tf <= 0) continue;
      const df = docFreq.get(qt) ?? 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const denom = tf + k1 * (1 - b + b * (doc.docLen / Math.max(1, avgDocLen)));
      total += idf * ((tf * (k1 + 1)) / denom);
    }
    if (total > 0) {
      scores.set(doc.entry.assetPath, total);
    }
  }

  return scores;
}

export class AssetIndexService {
  private readonly store: ProjectStore;
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly enricher?: AssetEnricher;
  private readonly embeddingModel: string;
  private readonly embeddingDims: number;
  private cachedState: LoadedIndexState | null = null;
  private cachedMtimeMs = -1;

  constructor(options: AssetIndexServiceOptions) {
    this.store = options.store;
    this.ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
    this.ffprobePath = options.ffprobePath ?? 'ffprobe';
    this.enricher = options.enricher;
    this.embeddingModel = options.embeddingModel ?? 'gemini-embedding-2';
    this.embeddingDims = options.embeddingDims ?? 256;
  }

  async loadIndex(): Promise<LoadedIndexState | null> {
    const indexPath = this.store.assetsIndexPath;
    let st;
    try {
      st = await fs.stat(indexPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.cachedState = null;
        this.cachedMtimeMs = -1;
        return null;
      }
      throw err;
    }

    if (this.cachedState && Math.round(st.mtimeMs) === this.cachedMtimeMs) {
      return this.cachedState;
    }

    const raw = await fs.readFile(indexPath, 'utf8');
    const manifest = JSON.parse(raw) as AssetIndexManifest;
    const warnings: string[] = [];
    let embeddings: Float32Array | null = null;

    if (
      manifest.embeddingModel &&
      manifest.embeddingDims &&
      manifest.embeddingRowCount > 0
    ) {
      const expectedBytes = manifest.embeddingRowCount * manifest.embeddingDims * 4;
      try {
        const buf = await fs.readFile(this.store.assetsEmbeddingsPath);
        if (buf.byteLength !== expectedBytes) {
          warnings.push(
            `Embedding matrix size mismatch (expected ${expectedBytes} bytes for ${manifest.embeddingRowCount}x${manifest.embeddingDims}, found ${buf.byteLength}); falling back to offline BM25 until re-indexed.`,
          );
        } else {
          // Copy into aligned ArrayBuffer so Float32Array view is always 4-byte aligned
          const aligned = new ArrayBuffer(buf.byteLength);
          new Uint8Array(aligned).set(buf);
          embeddings = new Float32Array(aligned);
        }
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          warnings.push(
            'assets_embeddings.f32 missing on disk; falling back to offline BM25 until re-indexed.',
          );
        } else {
          throw err;
        }
      }
    }

    this.cachedState = { manifest, embeddings, warnings };
    this.cachedMtimeMs = Math.round(st.mtimeMs);
    return this.cachedState;
  }

  async getMountIndexCounts(): Promise<Map<string, number>> {
    const state = await this.loadIndex();
    const counts = new Map<string, number>();
    if (!state) return counts;
    for (const m of state.manifest.mounts) {
      counts.set(m.alias, m.assetCount);
    }
    return counts;
  }

  private async transcodeCaptionPreviewOgg(absPath: string): Promise<Buffer> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'thebooth-cap-'));
    try {
      const outOgg = path.join(tempDir, 'preview.ogg');
      await runCommand(this.ffmpegPath, [
        '-hide_banner',
        '-y',
        '-i',
        absPath,
        '-t',
        '15',
        '-ac',
        '1',
        '-ar',
        '24000',
        '-c:a',
        'libopus',
        '-b:a',
        '48k',
        outOgg,
      ]);
      return await fs.readFile(outOgg);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async indexAssets(options: IndexAssetsOptions = {}): Promise<IndexAssetsSummary> {
    await this.store.ensureDataDirs();
    const warnings: string[] = [];
    const concurrency = Math.max(1, Math.min(16, options.concurrency ?? 6));
    const configuredMounts = this.store.getAssetMounts();
    const requestedMountSet =
      options.mounts && options.mounts.length > 0 ? new Set(options.mounts) : null;

    if (requestedMountSet) {
      const known = new Set(configuredMounts.map((m) => m.alias));
      for (const alias of requestedMountSet) {
        if (!known.has(alias)) {
          throw new StoreError(`Unknown asset mount "${alias}"`, 400);
        }
      }
    }

    // Load previous index & existing vectors so unchanged entries + embeddings are preserved
    const prevState = await this.loadIndex();
    const prevByPath = new Map<string, IndexedAssetEntry>();
    const prevVectorsByPath = new Map<string, Float32Array>();

    if (prevState) {
      const dimsMatch =
        prevState.manifest.embeddingModel === this.embeddingModel &&
        prevState.manifest.embeddingDims === this.embeddingDims &&
        prevState.embeddings !== null;

      for (const entry of prevState.manifest.assets) {
        prevByPath.set(entry.assetPath, entry);
        if (
          dimsMatch &&
          entry.embeddingRow !== undefined &&
          prevState.embeddings
        ) {
          const offset = entry.embeddingRow * this.embeddingDims;
          if (offset >= 0 && offset + this.embeddingDims <= prevState.embeddings.length) {
            prevVectorsByPath.set(
              entry.assetPath,
              prevState.embeddings.slice(offset, offset + this.embeddingDims),
            );
          }
        }
      }
    }

    // Walk selected mounts
    const scannedFiles: ScannedDiskFile[] = [];
    const scannedMountAliases = new Set<string>();
    for (const m of configuredMounts) {
      if (requestedMountSet && !requestedMountSet.has(m.alias)) continue;
      scannedMountAliases.add(m.alias);
      const found = await walkAssetMount(m.rootDir, m.alias, m.readOnly, warnings);
      scannedFiles.push(...found);
    }

    // Preserve assets from mounts not included in a partial rescan
    const nextEntries: IndexedAssetEntry[] = [];
    const configuredAliasSet = new Set(configuredMounts.map((m) => m.alias));
    if (prevState && requestedMountSet) {
      for (const oldEntry of prevState.manifest.assets) {
        if (
          configuredAliasSet.has(oldEntry.mount) &&
          !scannedMountAliases.has(oldEntry.mount)
        ) {
          nextEntries.push(structuredClone(oldEntry));
        }
      }
    }

    // Pass 1: Incremental ffprobe + metadata merge with bounded concurrency
    let reusedCached = 0;
    let probedFiles = 0;
    let completedCount = 0;
    const totalWork = scannedFiles.length;
    options.onProgress?.({ completed: 0, total: totalWork });

    const probedResults: Array<IndexedAssetEntry | null> = new Array(scannedFiles.length).fill(null);
    let cursor = 0;

    const worker = async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= scannedFiles.length) return;
        const file = scannedFiles[idx]!;
        const prev = prevByPath.get(file.assetPath);
        const unchanged =
          !options.forceReprobe &&
          prev &&
          prev.sizeBytes === file.sizeBytes &&
          prev.mtimeMs === file.mtimeMs;

        try {
          let entry: IndexedAssetEntry;
          if (unchanged && prev) {
            reusedCached += 1;
            entry = structuredClone(prev);
            entry.mount = file.mount;
            entry.readOnly = file.readOnly;
            entry.ucsExpanded = expandUcsTokens(file.assetPath);
            // Backfill native loudness telemetry on legacy indexes without requiring forceReprobe
            if (entry.rmsDbfs === undefined || entry.peakDbfs === undefined) {
              const levels = await measureAssetLevels(file.absPath, this.ffmpegPath).catch(
                () => null,
              );
              if (levels) {
                entry.rmsDbfs = levels.rmsDbfs;
                entry.peakDbfs = levels.peakDbfs;
              }
            }
          } else {
            const [probe, levels] = await Promise.all([
              probeAudioWithTags(file.absPath, this.ffprobePath),
              measureAssetLevels(file.absPath, this.ffmpegPath).catch(() => null),
            ]);
            probedFiles += 1;
            const bwfDescription = extractBwfDescription(probe.tags);
            entry = {
              assetPath: file.assetPath,
              mount: file.mount,
              readOnly: file.readOnly,
              sizeBytes: file.sizeBytes,
              mtimeMs: file.mtimeMs,
              extension: file.extension,
              durationMs: probe.durationMs,
              sampleRate: probe.sampleRate,
              channels: probe.channels,
              codecName: probe.codecName,
              ...(levels ? { rmsDbfs: levels.rmsDbfs, peakDbfs: levels.peakDbfs } : {}),
              suggestedKind: probe.durationMs >= 12000 ? 'bed' : 'sfx',
              ...(bwfDescription ? { bwfDescription } : {}),
              ...(Object.keys(probe.tags).length > 0 ? { embeddedTags: probe.tags } : {}),
              ucsExpanded: expandUcsTokens(file.assetPath),
            };
          }

          // Always re-apply catalog.json sidecar with highest priority
          entry.sidecarDescription = file.sidecar?.description;
          entry.sidecarTags = file.sidecar?.tags;
          entry.sidecarKind = file.sidecar?.kind;
          entry.license = file.sidecar?.license;
          if (file.sidecar?.loopable !== undefined) {
            entry.loopable = file.sidecar.loopable;
          }
          if (file.sidecar?.multiVariation !== undefined) {
            entry.multiVariation = file.sidecar.multiVariation;
          }

          probedResults[idx] = entry;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          warnings.push(`Failed to probe "${file.assetPath}": ${msg}`);
        } finally {
          completedCount += 1;
          options.onProgress?.({ completed: completedCount, total: totalWork });
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, Math.max(1, scannedFiles.length)) },
      () => worker(),
    );
    await Promise.all(workers);

    const absPathByAssetPath = new Map<string, string>();
    for (const f of scannedFiles) absPathByAssetPath.set(f.assetPath, f.absPath);

    for (const item of probedResults) {
      if (item) nextEntries.push(item);
    }
    nextEntries.sort((a, b) => a.assetPath.localeCompare(b.assetPath));

    const nextPathSet = new Set(nextEntries.map((e) => e.assetPath));
    let removedStale = 0;
    for (const oldPath of prevByPath.keys()) {
      if (!nextPathSet.has(oldPath)) removedStale += 1;
    }

    // Pass 2a: Optional Gemini Audio Captioning
    let captionedCount = 0;
    if (options.enrichCaptions) {
      if (!this.enricher?.captionAudio) {
        warnings.push(
          'enrichCaptions requested, but no Gemini enricher/API key is configured; skipped audio captioning.',
        );
      } else {
        const maxCaptions = Math.max(1, Math.min(500, options.maxCaptionCount ?? 50));
        const onlyMissing = options.onlyMissingDescriptions ?? true;
        for (const entry of nextEntries) {
          if (captionedCount >= maxCaptions) break;
          if (entry.aiCaption) continue;
          if (onlyMissing && (entry.sidecarDescription || entry.bwfDescription)) {
            continue;
          }
          const absPath = absPathByAssetPath.get(entry.assetPath);
          if (!absPath) continue;
          try {
            const oggBuffer = await this.transcodeCaptionPreviewOgg(absPath);
            const result = await this.enricher.captionAudio({
              oggBuffer,
              assetPath: entry.assetPath,
              durationSec: entry.durationMs / 1000,
              existingDescription: entry.bwfDescription ?? entry.sidecarDescription,
            });
            entry.aiCaption = result.caption;
            entry.aiTags = result.tags;
            entry.aiKind = result.kind;
            entry.aiLoopable = result.loopable;
            if (entry.loopable === undefined) {
              entry.loopable = result.loopable;
            }
            if (entry.multiVariation === undefined) {
              entry.multiVariation = result.multiVariation;
            }
            captionedCount += 1;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            warnings.push(`Captioning failed for "${entry.assetPath}": ${msg}`);
          }
        }
      }
    }

    // Pass 2b: Optional Semantic Embeddings + Atomic Matrix Compaction
    let embeddedCount = 0;
    const vectorByPath = new Map<string, Float32Array>();

    // Retain existing valid vectors whose searchable card hasn't changed
    for (const entry of nextEntries) {
      const card = buildSearchableCard(entry);
      const cardHash = hashText(card);
      const prevVec = prevVectorsByPath.get(entry.assetPath);
      if (prevVec && entry.embeddingCardHash === cardHash) {
        vectorByPath.set(entry.assetPath, prevVec);
      }
    }

    if (options.enrichEmbeddings) {
      if (!this.enricher?.embedTexts) {
        warnings.push(
          'enrichEmbeddings requested, but no Gemini enricher/API key is configured; skipped embeddings.',
        );
      } else {
        const toEmbed: Array<{ entry: IndexedAssetEntry; card: string; hash: string }> = [];
        for (const entry of nextEntries) {
          if (vectorByPath.has(entry.assetPath)) continue;
          const card = buildSearchableCard(entry);
          toEmbed.push({ entry, card, hash: hashText(card) });
        }

        if (toEmbed.length > 0) {
          const vectors = await this.enricher.embedTexts({
            texts: toEmbed.map((t) => t.card),
            taskType: 'RETRIEVAL_DOCUMENT',
            model: this.embeddingModel,
            outputDimensionality: this.embeddingDims,
          });
          for (let i = 0; i < toEmbed.length; i++) {
            const item = toEmbed[i]!;
            const rawVec = vectors[i];
            if (!rawVec || rawVec.length !== this.embeddingDims) {
              warnings.push(
                `Embedding vector length mismatch for "${item.entry.assetPath}" (expected ${this.embeddingDims})`,
              );
              continue;
            }
            vectorByPath.set(item.entry.assetPath, l2Normalize(rawVec));
            item.entry.embeddingCardHash = item.hash;
            embeddedCount += 1;
          }
        }
      }
    }

    // Compact retained + newly embedded vectors into a tight Float32Array matrix
    const embeddedEntries: Array<{ entry: IndexedAssetEntry; vec: Float32Array }> = [];
    for (const entry of nextEntries) {
      const vec = vectorByPath.get(entry.assetPath);
      if (vec) {
        entry.embeddingRow = embeddedEntries.length;
        embeddedEntries.push({ entry, vec });
      } else {
        delete entry.embeddingRow;
        delete entry.embeddingCardHash;
      }
    }

    const hasEmbeddings = embeddedEntries.length > 0;
    let compactedMatrix: Float32Array | null = null;
    if (hasEmbeddings) {
      compactedMatrix = new Float32Array(embeddedEntries.length * this.embeddingDims);
      for (let row = 0; row < embeddedEntries.length; row++) {
        compactedMatrix.set(embeddedEntries[row]!.vec, row * this.embeddingDims);
      }
      const rawBuf = Buffer.from(
        compactedMatrix.buffer,
        compactedMatrix.byteOffset,
        compactedMatrix.byteLength,
      );
      await atomicWriteFile(this.store.assetsEmbeddingsPath, rawBuf);
    } else {
      await fs.rm(this.store.assetsEmbeddingsPath, { force: true }).catch(() => {});
    }

    const mountCounts = new Map<string, number>();
    for (const entry of nextEntries) {
      mountCounts.set(entry.mount, (mountCounts.get(entry.mount) ?? 0) + 1);
    }
    const mountSummaries: AssetIndexMountSummary[] = configuredMounts.map((m) => ({
      alias: m.alias,
      readOnly: m.readOnly,
      assetCount: mountCounts.get(m.alias) ?? 0,
    }));

    const indexedAt = new Date().toISOString();
    const manifest: AssetIndexManifest = {
      schemaVersion: 1,
      indexedAt,
      embeddingModel: hasEmbeddings ? this.embeddingModel : null,
      embeddingDims: hasEmbeddings ? this.embeddingDims : null,
      embeddingRowCount: embeddedEntries.length,
      mounts: mountSummaries,
      assets: nextEntries,
    };

    await atomicWriteFile(
      this.store.assetsIndexPath,
      JSON.stringify(manifest, null, 2) + '\n',
    );

    // Refresh in-memory cache
    try {
      const st = await fs.stat(this.store.assetsIndexPath);
      this.cachedState = { manifest, embeddings: compactedMatrix, warnings: [] };
      this.cachedMtimeMs = Math.round(st.mtimeMs);
    } catch {
      this.cachedState = null;
      this.cachedMtimeMs = -1;
    }

    return {
      indexedAt,
      totalAssets: nextEntries.length,
      scannedFiles: scannedFiles.length,
      reusedCached,
      probedFiles,
      removedStale,
      captionedCount,
      embeddedCount,
      embeddingModel: manifest.embeddingModel,
      embeddingDims: manifest.embeddingDims,
      mounts: mountSummaries,
      warnings,
    };
  }

  async searchAssets(options: AssetSearchOptions): Promise<AssetSearchResult> {
    const query = options.query.trim();
    if (!query) {
      throw new StoreError('Search query must be non-empty', 400);
    }
    const limit = Math.max(1, Math.min(25, options.limit ?? 8));
    const kindFilter = options.kind ?? 'any';

    let state = await this.loadIndex();
    const configuredMounts = this.store.getAssetMounts();
    const hasExternalMounts = this.store.assetLibraryMounts.length > 0;

    if (!state) {
      if (!hasExternalMounts) {
        // Local-only workspace: auto-index seamlessly on first search
        await this.indexAssets();
        state = await this.loadIndex();
      } else {
        return {
          indexed: false,
          mode: 'bm25',
          totalIndexed: 0,
          totalMatchingFilter: 0,
          mounts: configuredMounts.map((m) => ({
            alias: m.alias,
            readOnly: m.readOnly,
            indexedCount: 0,
          })),
          results: [],
          hint: 'Asset index not built yet. Run booth_index_assets first to index your configured libraries.',
        };
      }
    }

    if (!state) {
      return {
        indexed: false,
        mode: 'bm25',
        totalIndexed: 0,
        totalMatchingFilter: 0,
        mounts: configuredMounts.map((m) => ({
          alias: m.alias,
          readOnly: m.readOnly,
          indexedCount: 0,
        })),
        results: [],
      };
    }

    const warnings = [...state.warnings];
    const filtered = state.manifest.assets.filter((entry) => {
      if (kindFilter !== 'any' && getEffectiveKind(entry) !== kindFilter) {
        return false;
      }
      if (options.mount && entry.mount !== options.mount) {
        return false;
      }
      const durSec = entry.durationMs / 1000;
      if (options.minDurationSec !== undefined && durSec < options.minDurationSec) {
        return false;
      }
      if (options.maxDurationSec !== undefined && durSec > options.maxDurationSec) {
        return false;
      }
      if (options.stereoOnly && entry.channels < 2) {
        return false;
      }
      return true;
    });

    const bm25Map = scoreAssetsBm25(filtered, query);

    // Check if hybrid semantic ranking is available & compatible
    let mode: 'bm25' | 'hybrid' = 'bm25';
    const cosineMap = new Map<string, number>();

    const canUseEmbeddings =
      state.embeddings !== null &&
      state.manifest.embeddingModel === this.embeddingModel &&
      state.manifest.embeddingDims === this.embeddingDims &&
      Boolean(this.enricher?.embedTexts);

    if (
      state.embeddings !== null &&
      (state.manifest.embeddingModel !== this.embeddingModel ||
        state.manifest.embeddingDims !== this.embeddingDims)
    ) {
      warnings.push(
        `Stored embeddings (${state.manifest.embeddingModel} @ ${state.manifest.embeddingDims}d) do not match configured (${this.embeddingModel} @ ${this.embeddingDims}d); using offline BM25 until re-indexed.`,
      );
    }

    if (canUseEmbeddings && filtered.length > 0 && this.enricher?.embedTexts) {
      try {
        const [rawQueryVec] = await this.enricher.embedTexts({
          texts: [query],
          taskType: 'RETRIEVAL_QUERY',
          model: this.embeddingModel,
          outputDimensionality: this.embeddingDims,
        });
        if (rawQueryVec && rawQueryVec.length === this.embeddingDims) {
          const queryVec = l2Normalize(rawQueryVec);
          let embeddedCandidates = 0;
          for (const entry of filtered) {
            if (entry.embeddingRow === undefined) continue;
            const sim = cosineSimilarityRow(
              state.embeddings!,
              entry.embeddingRow,
              this.embeddingDims,
              queryVec,
            );
            cosineMap.set(entry.assetPath, sim);
            embeddedCandidates += 1;
          }
          if (embeddedCandidates > 0) {
            mode = 'hybrid';
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Semantic query embedding failed; fell back to offline BM25: ${msg}`);
      }
    }

    // Score & rank candidates
    const ranked: Array<{ entry: IndexedAssetEntry; score: number }> = [];

    if (mode === 'hybrid') {
      // Reciprocal Rank Fusion (RRF) + cosine tie-breaking
      const bm25Order = Array.from(bm25Map.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([p]) => p);
      const cosineOrder = Array.from(cosineMap.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([p]) => p);

      const bm25Rank = new Map<string, number>();
      bm25Order.forEach((p, idx) => bm25Rank.set(p, idx + 1));
      const cosineRank = new Map<string, number>();
      cosineOrder.forEach((p, idx) => cosineRank.set(p, idx + 1));

      const rrfK = 60;
      const maxRrf = 0.65 / (rrfK + 1) + 0.35 / (rrfK + 1);

      for (const entry of filtered) {
        const cRank = cosineRank.get(entry.assetPath);
        const bRank = bm25Rank.get(entry.assetPath);
        if (cRank === undefined && bRank === undefined) continue;
        const rrfScore =
          (cRank !== undefined ? 0.65 / (rrfK + cRank) : 0) +
          (bRank !== undefined ? 0.35 / (rrfK + bRank) : 0);
        const cosVal = Math.max(0, cosineMap.get(entry.assetPath) ?? 0);
        // Blend normalized RRF with raw cosine so returned scores stay intuitive in [0, 1]
        const combined = Math.min(1, 0.5 * (rrfScore / maxRrf) + 0.5 * cosVal);
        ranked.push({ entry, score: Number(combined.toFixed(4)) });
      }
    } else {
      let maxBm25 = 0;
      for (const val of bm25Map.values()) {
        if (val > maxBm25) maxBm25 = val;
      }
      for (const entry of filtered) {
        const raw = bm25Map.get(entry.assetPath);
        if (raw === undefined || raw <= 0) continue;
        const norm = maxBm25 > 0 ? raw / maxBm25 : 0;
        ranked.push({ entry, score: Number(norm.toFixed(4)) });
      }
    }

    ranked.sort((a, b) => b.score - a.score || a.entry.assetPath.localeCompare(b.entry.assetPath));

    const results: AssetSearchHit[] = ranked.slice(0, limit).map(({ entry, score }) => ({
      assetPath: entry.assetPath,
      mount: entry.mount,
      readOnly: entry.readOnly,
      durationSec: Number((entry.durationMs / 1000).toFixed(2)),
      channels: entry.channels,
      sampleRate: entry.sampleRate,
      ...(entry.rmsDbfs !== undefined ? { rmsDbfs: entry.rmsDbfs } : {}),
      ...(entry.peakDbfs !== undefined ? { peakDbfs: entry.peakDbfs } : {}),
      suggestedKind: getEffectiveKind(entry),
      description: getEffectiveDescription(entry),
      tags: getEffectiveTags(entry),
      ...(entry.loopable !== undefined ? { loopable: entry.loopable } : {}),
      ...(entry.multiVariation !== undefined ? { multiVariation: entry.multiVariation } : {}),
      ...(entry.license ? { license: entry.license } : {}),
      score,
    }));

    const mountCountMap = new Map<string, number>();
    for (const m of state.manifest.mounts) {
      mountCountMap.set(m.alias, m.assetCount);
    }

    return {
      indexed: true,
      mode,
      totalIndexed: state.manifest.assets.length,
      totalMatchingFilter: filtered.length,
      mounts: configuredMounts.map((m) => ({
        alias: m.alias,
        readOnly: m.readOnly,
        indexedCount: mountCountMap.get(m.alias) ?? 0,
      })),
      results,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
}
