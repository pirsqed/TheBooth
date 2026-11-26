import { randomUUID } from 'node:crypto';
import { writeFile, rename } from 'node:fs/promises';

const revision = randomUUID();
const marker = new URL('../dist/.mcp-build', import.meta.url);
const temporary = new URL('./.mcp-build-' + revision + '.tmp', marker);
await writeFile(temporary, revision);
await rename(temporary, marker);
