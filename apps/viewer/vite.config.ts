import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** The port `pnpm dev` runs `graphmind serve` on (scripts/dev.mjs). */
const SERVER_PORT = 4747;

/**
 * DEV ONLY: hand the running server's viewer token to the dev viewer.
 *
 * `graphmind serve` writes `#token=…` into a private redirect file for the
 * browser it opens. Under `pnpm dev` the viewer is on Vite's origin instead,
 * so without this a contributor has to spot the token line in the terminal
 * and paste it — and until they do, the Build page cannot create or run
 * anything and half the debugger is read-only.
 *
 * This reads that same file, on the same machine, as the same user, and only
 * ever in `vite dev`. It is not part of any build output.
 */
function devTokenPlugin(): Plugin {
  return {
    name: 'graphmind-dev-token',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__graphmind/dev-token', (_req, res) => {
        const home = process.env.GRAPHMIND_HOME ?? join(homedir(), '.graphmind');
        const opener = join(home, 'run', `open-${process.env.GRAPHMIND_PORT ?? SERVER_PORT}.html`);
        let token: string | undefined;
        try {
          token = /#token=([A-Za-z0-9_-]+)/.exec(readFileSync(opener, 'utf8'))?.[1];
        } catch {
          token = undefined; // no server running yet
        }
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify(token === undefined ? { token: null } : { token }));
      });
    },
  };
}

/**
 * The CLI reads its own version out of package.json through `createRequire`,
 * which a browser has no answer for — and the generator imports it to pin
 * the adapter versions it writes into a project. Swap that one module for
 * the same string, baked in at build time.
 */
function versionPlugin(): Plugin {
  const versionModule = fileURLToPath(new URL('../../packages/cli/src/version.ts', import.meta.url));
  const { version } = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../packages/cli/package.json', import.meta.url)), 'utf8'),
  ) as { version: string };
  return {
    name: 'graphmind-cli-version',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!source.endsWith('version.js') || importer === undefined) return null;
      const resolved = join(dirname(importer), source).replace(/\.js$/, '.ts');
      return resolved === versionModule ? versionModule : null;
    },
    load(id) {
      return id === versionModule ? `export const VERSION = ${JSON.stringify(version)};\n` : null;
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), devTokenPlugin(), versionPlugin()],
  /**
   * The workflow spec and its code generator are pure TypeScript with no
   * node imports, and the Build page runs them in the browser so it can show
   * the project it describes with no server attached. They live next to the
   * CLI that also runs them (server-side, for Create), rather than in a
   * package of their own: the viewer is built into that same CLI and
   * released with it, so there is no version to skew and nothing to publish.
   */
  resolve: {
    alias: { '@workflow': fileURLToPath(new URL('../../packages/cli/src/builder', import.meta.url)) },
  },
  server: {
    port: 5199,
    strictPort: true,
  },
});
