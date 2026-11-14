/**
 * @graphmind-ai/ui — the browser files every GraphMind dashboard shares,
 * and one function to serve them.
 *
 *   graphmind.css   the design tokens and components of graphmind.ai
 *   shell.js        the shell: top bar, product switcher, user menu,
 *                   sign-in / sign-up, the account page (profile, plan,
 *                   API tokens, sign out)
 *
 * Servers expose them under `gm/` next to their own page
 * (`app.get('/gm/:name', …)`), and pages load them with page-relative URLs
 * (`./gm/graphmind.css`), so the same files work at an origin root and
 * under the platform's `/app/circuit/` and `/app/jack/`.
 */
import { readFile } from 'node:fs/promises';

const ASSETS_DIR = new URL('../assets/', import.meta.url);

export const UI_ASSETS: Readonly<Record<string, string>> = {
  'graphmind.css': 'text/css; charset=utf-8',
  'shell.js': 'text/javascript; charset=utf-8',
};

/** The asset as a Response, or null if `name` is not one of ours (never reads outside assets/). */
export async function uiAsset(name: string): Promise<Response | null> {
  const type = UI_ASSETS[name];
  if (type === undefined) return null;
  const body = await readFile(new URL(name, ASSETS_DIR), 'utf8');
  return new Response(body, {
    headers: { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}
