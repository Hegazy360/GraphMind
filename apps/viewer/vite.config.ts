import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

export default defineConfig({
  plugins: [react(), tailwindcss(), devTokenPlugin()],
  server: {
    port: 5199,
    strictPort: true,
  },
});
