import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  Project,
  ProjectSchema,
  ProjectSummary,
  SafeIdSchema,
} from '../types/project.js';

export class StoreError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

export const ALLOWED_ASSET_EXTENSIONS = new Set([
  '.wav',
  '.ogg',
  '.mp3',
  '.flac',
  '.m4a',
]);

export interface AssetFileEntry {
  path: string;
  sizeBytes: number;
  extension: string;
  modifiedAt: string;
}

async function atomicWriteFile(filePath: string, data: string | Buffer): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpName = `${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const tmpPath = path.join(dir, tmpName);
  try {
    await fs.writeFile(tmpPath, data);
    // Windows can briefly hold a handle via antivirus/indexer; retry rename a few times.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.rename(tmpPath, filePath);
        return;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

function assertSafeId(id: string, label: string): void {
  const res = SafeIdSchema.safeParse(id);
  if (!res.success) {
    throw new StoreError(`Invalid ${label}: ${id}`, 400);
  }
}

function assertWithinRoot(rootDir: string, targetPath: string, label: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(resolvedRoot, targetPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new StoreError(`Path escapes sandbox (${label}): ${targetPath}`, 400);
  }
  return resolvedTarget;
}

export class ProjectStore {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly dataDir: string) {}

  get rootDir(): string {
    return path.resolve(this.dataDir);
  }

  get assetsDir(): string {
    return path.join(this.rootDir, 'assets');
  }

  get projectsRootDir(): string {
    return path.join(this.rootDir, 'projects');
  }

  get voicePreviewsDir(): string {
    return path.join(this.rootDir, 'voice_previews');
  }

  resolveVoicePreviewPath(voiceId: string): string {
    const cleanId = voiceId.startsWith('voices/') ? voiceId.slice('voices/'.length) : voiceId;
    assertSafeId(cleanId, 'voiceId');
    return assertWithinRoot(this.voicePreviewsDir, `${cleanId}.wav`, 'voice preview');
  }

  async writeVoicePreviewWav(voiceId: string, wavBuffer: Buffer): Promise<string> {
    const absPath = this.resolveVoicePreviewPath(voiceId);
    await atomicWriteFile(absPath, wavBuffer);
    return absPath;
  }

  async deleteVoicePreviewWav(voiceId: string): Promise<void> {
    const absPath = this.resolveVoicePreviewPath(voiceId);
    await fs.rm(absPath, { force: true }).catch(() => {});
  }

  projectDir(projectId: string): string {
    assertSafeId(projectId, 'projectId');
    return assertWithinRoot(this.projectsRootDir, projectId, 'project');
  }

  projectJsonPath(projectId: string): string {
    return path.join(this.projectDir(projectId), 'project.json');
  }

  takesDir(projectId: string): string {
    return path.join(this.projectDir(projectId), 'takes');
  }

  exportsDir(projectId: string): string {
    return path.join(this.projectDir(projectId), 'exports');
  }

  visualsDir(projectId: string): string {
    return path.join(this.projectDir(projectId), 'visuals');
  }

  resolveProjectFile(projectId: string, relativePath: string): string {
    return assertWithinRoot(this.projectDir(projectId), relativePath, 'project file');
  }

  resolveAssetPath(assetPath: string): string {
    if (!assetPath || path.isAbsolute(assetPath)) {
      throw new StoreError(`Asset path must be relative to assets/: ${assetPath}`, 400);
    }
    return assertWithinRoot(this.assetsDir, assetPath, 'asset');
  }

  async ensureDataDirs(): Promise<void> {
    await fs.mkdir(this.assetsDir, { recursive: true });
    await fs.mkdir(this.projectsRootDir, { recursive: true });
  }

  /**
   * Serializes all mutations to a given project ID via an in-process FIFO lock.
   */
  async withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    assertSafeId(projectId, 'projectId');
    const prev = this.locks.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(() => next);
    this.locks.set(projectId, chained);

    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(projectId) === chained) {
        this.locks.delete(projectId);
      }
    }
  }

  async createProject(project: Project): Promise<Project> {
    const validated = ProjectSchema.parse(project);
    return this.withProjectLock(validated.id, async () => {
      await this.ensureDataDirs();
      const dir = this.projectDir(validated.id);
      const manifestPath = this.projectJsonPath(validated.id);
      try {
        await fs.access(manifestPath);
        throw new StoreError(`Project already exists: ${validated.id}`, 409);
      } catch (err: unknown) {
        if (err instanceof StoreError) throw err;
      }
      await fs.mkdir(path.join(dir, 'takes'), { recursive: true });
      await fs.mkdir(path.join(dir, 'exports'), { recursive: true });
      await atomicWriteFile(manifestPath, JSON.stringify(validated, null, 2) + '\n');
      return validated;
    });
  }

  async getProject(projectId: string): Promise<Project | null> {
    assertSafeId(projectId, 'projectId');
    const manifestPath = this.projectJsonPath(projectId);
    try {
      const raw = await fs.readFile(manifestPath, 'utf8');
      return ProjectSchema.parse(JSON.parse(raw));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async requireProject(projectId: string): Promise<Project> {
    const project = await this.getProject(projectId);
    if (!project) {
      throw new StoreError(`Project not found: ${projectId}`, 404);
    }
    return project;
  }

  async listProjects(): Promise<ProjectSummary[]> {
    await this.ensureDataDirs();
    const entries = await fs.readdir(this.projectsRootDir, { withFileTypes: true });
    const summaries: ProjectSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const safe = SafeIdSchema.safeParse(entry.name);
      if (!safe.success) continue;
      const project = await this.getProject(entry.name);
      if (!project) continue;
      summaries.push({
        id: project.id,
        name: project.name,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        cueCount: project.cues.length,
        renderedCueCount: project.cues.filter((c) => c.activeTakeId !== null).length,
        exportCount: project.exports.length,
      });
    }
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return summaries;
  }

  async updateProject(
    projectId: string,
    updater: (project: Project) => Project | Promise<Project>,
  ): Promise<Project> {
    return this.withProjectLock(projectId, async () => {
      const current = await this.requireProject(projectId);
      const updated = await updater(structuredClone(current));
      updated.updatedAt = new Date().toISOString();
      const validated = ProjectSchema.parse(updated);
      await atomicWriteFile(
        this.projectJsonPath(projectId),
        JSON.stringify(validated, null, 2) + '\n',
      );
      return validated;
    });
  }

  async writeTakeWav(
    projectId: string,
    takeId: string,
    wavBuffer: Buffer,
  ): Promise<string> {
    assertSafeId(projectId, 'projectId');
    assertSafeId(takeId, 'takeId');
    const relPath = `takes/${takeId}.wav`;
    const absPath = this.resolveProjectFile(projectId, relPath);
    await atomicWriteFile(absPath, wavBuffer);
    return relPath;
  }

  async writeAuditionWav(
    projectId: string,
    auditionId: string,
    wavBuffer: Buffer,
  ): Promise<string> {
    assertSafeId(projectId, 'projectId');
    assertSafeId(auditionId, 'auditionId');
    const relPath = `auditions/${auditionId}.wav`;
    const absPath = this.resolveProjectFile(projectId, relPath);
    await atomicWriteFile(absPath, wavBuffer);
    return relPath;
  }

  async writeExportTelemetry(
    projectId: string,
    exportId: string,
    telemetry: unknown,
  ): Promise<string> {
    assertSafeId(projectId, 'projectId');
    assertSafeId(exportId, 'exportId');
    const relPath = `exports/${exportId}.json`;
    const absPath = this.resolveProjectFile(projectId, relPath);
    await atomicWriteFile(absPath, JSON.stringify(telemetry, null, 2) + '\n');
    return relPath;
  }

  async writeVisualPng(
    projectId: string,
    fileId: string,
    pngBuffer: Buffer,
  ): Promise<{ relPath: string; absPath: string }> {
    assertSafeId(projectId, 'projectId');
    assertSafeId(fileId, 'fileId');
    const relPath = `visuals/${fileId}.png`;
    const absPath = this.resolveProjectFile(projectId, relPath);
    await atomicWriteFile(absPath, pngBuffer);
    return { relPath, absPath };
  }

  async writeSharedVisualPng(fileId: string, pngBuffer: Buffer): Promise<string> {
    assertSafeId(fileId, 'fileId');
    const dir = path.join(this.rootDir, 'visuals');
    const absPath = assertWithinRoot(dir, `${fileId}.png`, 'shared visual');
    await atomicWriteFile(absPath, pngBuffer);
    return absPath;
  }

  async deleteProject(projectId: string): Promise<void> {
    return this.withProjectLock(projectId, async () => {
      const dir = this.projectDir(projectId);
      await fs.rm(dir, { recursive: true, force: true });
    });
  }

  /**
   * Lists all reusable audio assets stored under DATA_DIR/assets/.
   */
  async listAssets(): Promise<AssetFileEntry[]> {
    await this.ensureDataDirs();
    const results: AssetFileEntry[] = [];

    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name.endsWith('.tmp')) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!ALLOWED_ASSET_EXTENSIONS.has(ext)) continue;
          const st = await fs.stat(abs);
          const rel = path.relative(this.assetsDir, abs).replace(/\\/g, '/');
          results.push({
            path: rel,
            sizeBytes: st.size,
            extension: ext,
            modifiedAt: st.mtime.toISOString(),
          });
        }
      }
    };

    await walk(this.assetsDir);
    results.sort((a, b) => a.path.localeCompare(b.path));
    return results;
  }

  assertValidAssetExtension(assetPath: string): string {
    const ext = path.extname(assetPath).toLowerCase();
    if (!ALLOWED_ASSET_EXTENSIONS.has(ext)) {
      throw new StoreError(
        `Unsupported audio asset extension "${ext || '(none)'}". Allowed: ${Array.from(ALLOWED_ASSET_EXTENSIONS).join(', ')}`,
        400,
      );
    }
    return ext;
  }

  async writeAssetFile(assetPath: string, data: Buffer): Promise<string> {
    this.assertValidAssetExtension(assetPath);
    const absPath = this.resolveAssetPath(assetPath);
    await this.ensureDataDirs();
    await atomicWriteFile(absPath, data);
    return path.relative(this.assetsDir, absPath).replace(/\\/g, '/');
  }

  async deleteAssetFile(assetPath: string): Promise<void> {
    const absPath = this.resolveAssetPath(assetPath);
    try {
      const st = await fs.stat(absPath);
      if (!st.isFile()) {
        throw new StoreError(`Asset is not a file: ${assetPath}`, 400);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new StoreError(`Asset not found: ${assetPath}`, 404);
      }
      throw err;
    }
    await fs.rm(absPath, { force: true });
  }
}
