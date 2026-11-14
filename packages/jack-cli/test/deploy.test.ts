/**
 * `jack deploy`: jack.yaml from git → a Jack server (the same API the dashboard uses).
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createJack, SqliteStore } from 'jack-api';
import { deployCommand, DeployError, type Io } from '../src/index.js';

const fixture = fileURLToPath(new URL('../../jack-openapi/test/fixtures/petstore-3.0.yaml', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'jack-deploy-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SERVER = 'http://127.0.0.1:4998';
function server() {
  const store = new SqliteStore(':memory:');
  const jack = createJack({ store, publicOrigin: SERVER, dataDir: join(dir, 'data'), secretKey: randomBytes(32), egress: 'any', env: {} });
  const fetchImpl = ((url: string, init?: RequestInit) => jack.app.fetch(new Request(url, init))) as typeof fetch;
  return { store, jack, fetchImpl };
}
const io = (): Io & { lines: string[] } => {
  const lines: string[] = [];
  return { lines, out: (l) => lines.push(l), err: (l) => lines.push(l) };
};

describe('jack deploy', () => {
  it('first deploy creates the project; the next one updates it and reports the diff', async () => {
    const s = server();
    const config = join(dir, 'jack.yaml');
    writeFileSync(config, `name: Pets\nsource: ${JSON.stringify(fixture)}\nupstream: "https://petstore3.swagger.io/api/v3"\n`);
    const a = io();
    expect(await deployCommand({ config, server: SERVER, fetchImpl: s.fetchImpl, message: 'v1 from git' }, a)).toBe(0);
    expect(a.lines.join('\n')).toMatch(/created project pets[\s\S]*deployed v1 \(\+4 added\)[\s\S]*MCP URL: {3}http:\/\/127\.0\.0\.1:4998\/p\/pets\/mcp/);

    writeFileSync(config, `name: Pets\nsource: ${JSON.stringify(fixture)}\nupstream: "https://petstore3.swagger.io/api/v3"\ntools:\n  add_pet: { enabled: true, description: "Add a pet (reviewed)." }\n  login_user: { enabled: false }\n`);
    const b = io();
    await deployCommand({ config, server: SERVER, fetchImpl: s.fetchImpl }, b);
    expect(b.lines.join('\n')).toMatch(/deployed v2 \(\+1 added, -1 removed\)/);
    const p = s.store.getProjectBySlug('pets')!;
    expect(p.activeVersion).toBe(2);
    expect(s.store.listDeployments(p.id)[1]!.message).toBe('v1 from git');
    await s.jack.close();
  });

  it('moves an env: client secret into the project\'s encrypted secrets, never into the draft', async () => {
    const s = server();
    const config = join(dir, 'oidc.yaml');
    writeFileSync(
      config,
      `name: Pets OIDC\nsource: ${JSON.stringify(fixture)}\nupstream: "https://petstore3.swagger.io/api/v3"\nauth: { mode: oidc, issuer: "https://login.example", clientId: jack, clientSecretRef: "env:PETS_SECRET" }\n`,
    );
    await expect(deployCommand({ config, server: SERVER, fetchImpl: s.fetchImpl, env: {} }, io())).rejects.toThrow(DeployError);
    expect(await deployCommand({ config, server: SERVER, fetchImpl: s.fetchImpl, env: { PETS_SECRET: 's3cret-value' } }, io())).toBe(0);
    const p = s.store.getProjectBySlug('pets-oidc')!;
    expect(p.auth).toMatchObject({ mode: 'oidc', clientSecretRef: 'secret:PETS_SECRET' });
    expect(s.store.listSecrets(p.id).map((x) => x.name)).toEqual(['PETS_SECRET']);
    expect(JSON.stringify(s.store.getDraft(p.id))).not.toContain('s3cret-value');
    await s.jack.close();
  });

  it('a broken jack.yaml never reaches the server', async () => {
    const s = server();
    const config = join(dir, 'broken.yaml');
    writeFileSync(config, `source: ${JSON.stringify(fixture)}\nupstream: "https://petstore3.swagger.io/api/v3"\ntools:\n  get_inventory: { name: get_pet_by_id }\n`);
    let called = false;
    const spy = ((u: string, i?: RequestInit) => {
      called = true;
      return s.fetchImpl(u, i);
    }) as typeof fetch;
    await expect(deployCommand({ config, server: SERVER, fetchImpl: spy }, io())).rejects.toThrow(/two enabled tools/);
    expect(called).toBe(false);
    await s.jack.close();
  });
});
