// The package version, read once from package.json so the CLI and the MCP server agree.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const VERSION = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;
