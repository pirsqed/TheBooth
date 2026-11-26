import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../config.js';
import { GeminiDirectorReviewer } from '../director/gemini.js';
import { MockDirectorReviewer } from '../director/mock.js';
import { GeminiTtsProvider } from '../providers/gemini.js';
import { MockTtsProvider } from '../providers/mock.js';
import { StudioService } from '../studio/service.js';
import { ProjectStore } from '../studio/store.js';
import { createMcpServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new ProjectStore(config.dataDir);
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

  const service = new StudioService({
    store,
    providers: {
      gemini: geminiProvider,
      mock: mockProvider,
    },
    defaultProvider: config.geminiApiKey ? 'gemini' : 'mock',
    director,
    ffmpegPath: config.ffmpegPath,
    ffprobePath: config.ffprobePath,
    allowCustomFfmpegFilter: config.allowCustomFfmpegFilter,
  });

  const server = createMcpServer(service);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Important: never write logs to stdout in an MCP stdio server
  console.error(
    `[the-booth-mcp] connected on stdio (dataDir: ${config.dataDir}, defaultProvider: ${config.geminiApiKey ? 'gemini' : 'mock'})`,
  );
}

main().catch((err) => {
  console.error('[the-booth-mcp] fatal error:', err);
  process.exit(1);
});
