import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { buildServer } from './api/server.js';
import { loadConfig } from './config.js';
import { GeminiDirectorReviewer } from './director/gemini.js';
import { MockDirectorReviewer } from './director/mock.js';
import { GeminiTtsProvider } from './providers/gemini.js';
import { MockTtsProvider } from './providers/mock.js';
import { GeminiAssetEnricher } from './studio/assets-index.js';
import { StudioService } from './studio/service.js';
import { ProjectStore } from './studio/store.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(REPO_ROOT, '.env'), quiet: true });

async function main(): Promise<void> {
  const config = loadConfig(process.env, REPO_ROOT);
  const store = new ProjectStore(config.dataDir, {
    assetLibraryMounts: config.assetLibraryMounts,
  });
  await store.ensureDataDirs();

  const geminiProvider = new GeminiTtsProvider({
    apiKey: config.geminiApiKey,
    defaultModel: config.geminiTtsModel,
    safetyThreshold: config.geminiSafetyThreshold,
  });
  const mockProvider = new MockTtsProvider();
  const director = config.geminiApiKey
    ? new GeminiDirectorReviewer({
        apiKey: config.geminiApiKey,
        model: config.geminiDirectorModel,
      })
    : new MockDirectorReviewer();
  const assetEnricher = config.geminiApiKey
    ? new GeminiAssetEnricher({
        apiKey: config.geminiApiKey,
        captionModel: config.geminiDirectorModel,
      })
    : undefined;

  const service = new StudioService({
    store,
    providers: {
      gemini: geminiProvider,
      mock: mockProvider,
    },
    defaultProvider: config.geminiApiKey ? 'gemini' : 'mock',
    director,
    assetEnricher,
    geminiEmbeddingModel: config.geminiEmbeddingModel,
    assetEmbeddingDims: config.assetEmbeddingDims,
    ffmpegPath: config.ffmpegPath,
    ffprobePath: config.ffprobePath,
    allowCustomFfmpegFilter: config.allowCustomFfmpegFilter,
    allowedExportDirs: config.allowedExportDirs,
  });

  const app = buildServer({ service, logger: true });

  await app.listen({ port: config.port, host: '127.0.0.1' });
  app.log.info(
    `The Booth listening on http://127.0.0.1:${config.port} (dataDir: ${config.dataDir}, defaultProvider: ${config.geminiApiKey ? 'gemini' : 'mock'})`,
  );
}

main().catch((err) => {
  console.error('Failed to start The Booth:', err);
  process.exit(1);
});
