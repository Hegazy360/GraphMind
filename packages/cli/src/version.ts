/** Package version, read from package.json (works from both src/ and dist/). */
import { createRequire } from 'node:module';

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

export const VERSION: string = pkg.version;
