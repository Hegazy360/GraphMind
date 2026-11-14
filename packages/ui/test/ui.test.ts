import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UI_ASSETS, uiAsset } from '../src/index.js';

describe('@graphmind-ai/ui', () => {
  it('serves the stylesheet and the shell with their types', async () => {
    const css = await uiAsset('graphmind.css');
    expect(css?.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(css?.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await css?.text()).toContain('--gm-accent');
    const js = await uiAsset('shell.js');
    expect(js?.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await js?.text()).toContain('export async function startShell');
  });

  it('serves nothing else, whatever the name', async () => {
    for (const name of ['../package.json', '..%2Fpackage.json', 'index.ts', '', 'shell.js/../../package.json']) {
      expect(await uiAsset(name)).toBeNull();
    }
    expect(Object.keys(UI_ASSETS).sort()).toEqual(['graphmind.css', 'shell.js']);
  });

  it('keeps the shell CSP-clean: no innerHTML, no inline style attributes', () => {
    // Code only: the header comment promises exactly this, in words.
    const shell = readFileSync(new URL('../assets/shell.js', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    expect(shell).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(shell).not.toMatch(/setAttribute\(\s*['"]style['"]/);
  });

  it('uses the same palette as graphmind.ai', () => {
    const shared = readFileSync(new URL('../assets/graphmind.css', import.meta.url), 'utf8');
    const site = readFileSync(new URL('../../../apps/web/styles.css', import.meta.url), 'utf8');
    for (const token of ['bg', 'bg-soft', 'border', 'border-strong', 'text', 'text-2', 'text-3', 'accent', 'danger']) {
      const value = (css: string, name: string) => [...css.matchAll(new RegExp(`--${name}:\\s*([^;]+);`, 'g'))].map((m) => m[1]!.trim());
      expect(value(shared, `gm-${token}`), token).toEqual(value(site, token));
    }
  });
});
