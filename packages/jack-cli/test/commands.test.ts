/**
 * M1 authoring loop through the CLI command layer: init → edit → check → build.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parseManifest } from '@graphmind-ai/jack-schema';
import { buildCommand, checkCommand, initCommand, type Io } from '../src/index.js';

const petstore = fileURLToPath(new URL('../../jack-openapi/test/fixtures/petstore-3.0.yaml', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'jack-cli-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function capture(): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l), today: '2026-11-09' };
}

describe('jack init / check / build', () => {
  const spec = join(dir, 'specs', 'petstore.yaml');
  const config = join(dir, 'jack.yaml');

  it('init writes jack.yaml with a relative source and refuses to overwrite', async () => {
    (await import('node:fs')).mkdirSync(join(dir, 'specs'));
    copyFileSync(petstore, spec);
    const io = capture();
    expect(await initCommand(spec, { out: config, upstream: 'https://petstore3.swagger.io/api/v3' }, io)).toBe(0);
    const yaml = readFileSync(config, 'utf8');
    expect(yaml).toContain('source: "./specs/petstore.yaml"');
    expect(io.lines.join('\n')).toMatch(/enabled: {4}4 read tools/);
    expect(io.lines.join('\n')).toMatch(/disabled: {3}3 write operations/);
    expect(io.lines.join('\n')).toContain('1 skipped');

    const again = capture();
    expect(await initCommand(spec, { out: config }, again)).toBe(1);
    expect(again.errors[0]).toMatch(/already exists — pass --force/);
  });

  it('check lists every operation; --strict fails while warnings remain', async () => {
    const io = capture();
    expect(await checkCommand({ config }, io)).toBe(0);
    const text = io.lines.join('\n');
    expect(text).toMatch(/✓ get_pet_by_id +GET +\/api\/v3\/pet\/\{petId\}/);
    expect(text).toMatch(/· delete_pet +DELETE +\/api\/v3\/pet\/\{petId\} +DESTRUCTIVE/);
    expect(text).toMatch(/4 tools enabled of 8, 3 toolsets, \d+ warnings?/);
    const strict = capture();
    expect(await checkCommand({ config, strict: true }, strict)).toBe(1);
  });

  it('edits to jack.yaml show up in check and build; the manifest is valid', async () => {
    const yaml = readFileSync(config, 'utf8').replace(
      /  delete_pet:\n    enabled: false/,
      '  delete_pet:\n    enabled: true\n    name: remove_pet\n    description: "Permanently delete one pet by its numeric id. This cannot be undone."',
    );
    writeFileSync(config, yaml);
    const io = capture();
    await checkCommand({ config }, io);
    expect(io.lines.join('\n')).toMatch(/✓ remove_pet +DELETE .* DESTRUCTIVE {2}\(from delete_pet\)/);

    const b = capture();
    const out = join(dir, 'out', 'manifest.json');
    expect(await buildCommand({ config, out }, b)).toBe(0);
    const manifest = parseManifest(JSON.parse(readFileSync(out, 'utf8')));
    expect(manifest.tools.map((t) => t.name)).toContain('remove_pet');
    expect(b.lines[0]).toMatch(/^jack build — 5 tools, manifest [0-9a-f]{12}$/);
  });
});
