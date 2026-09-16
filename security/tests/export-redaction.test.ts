/**
 * Exports are sanitised by default (0.5.0). A tool that RETURNS a credential
 * under a secret-shaped key is recorded — Layer 1 (the HIDE_* switches) is off
 * here, and recording tool payloads is the point of the product — so it MUST be
 * on the SQLite / HTTP / WebSocket surfaces, and MUST NOT be in either export
 * unless the user says `--no-redact-secrets`. Values under non-secret keys
 * survive, so the export is still useful.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { graphmind } from '@graphmind-ai/anthropic';
import { cleanupAudit, runAudit, type AuditArtifacts } from '../src/harness.js';

const mint = (tag: string): string => `${tag}_${randomBytes(12).toString('hex')}`;
const TOKEN_CANARY = mint('tok');
const APIKEY_CANARY = mint('key');
const CAMEL_CANARY = mint('cam');
const NOTE_CANARY = mint('note');

const surfaceText = (result: AuditArtifacts, surface: string): string =>
  result.artifacts
    .filter((a) => a.surface === surface)
    .map((a) => String(a.content))
    .join('\n');

async function vaultRun(ctx: { ingestUrl: string }): Promise<void> {
  const gm = graphmind({
    url: ctx.ingestUrl,
    enabled: true,
    app: 'export-redaction',
    waitForAttach: 3000,
    logger: () => {},
  });
  const tools = gm.wrapTools({
    vault: async () => ({
      token: TOKEN_CANARY,
      api_key: APIKEY_CANARY,
      accessToken: CAMEL_CANARY,
      max_tokens: 42,
      note: NOTE_CANARY,
    }),
  });
  try {
    await gm.run('r', async () => {
      await tools.vault();
    });
  } finally {
    await gm.dispose();
  }
}

describe('export redaction (graphmind record, default on)', () => {
  let result: AuditArtifacts;
  beforeAll(async () => {
    result = await runAudit({ agent: vaultRun });
  }, 90_000);
  afterAll(() => {
    if (result !== undefined) cleanupAudit(result);
  });

  it('the credential IS recorded on the live surfaces (by design)', () => {
    for (const surface of ['sqlite', 'http-api', 'websocket']) {
      expect(surfaceText(result, surface), surface).toContain(TOKEN_CANARY);
    }
  });

  it('neither export contains a value under a secret-shaped key, and keeps the rest', () => {
    for (const surface of ['ndjson-export', 'html-export']) {
      const text = surfaceText(result, surface);
      expect(text, `${surface} should be non-empty`).not.toBe('');
      expect(text, `${surface}: token`).not.toContain(TOKEN_CANARY);
      expect(text, `${surface}: api_key`).not.toContain(APIKEY_CANARY);
      expect(text, `${surface}: accessToken (camelCase segment)`).not.toContain(CAMEL_CANARY);
      expect(text, `${surface}: non-secret value survives`).toContain(NOTE_CANARY);
      expect(text, `${surface}: max_tokens is not a token`).toContain('"max_tokens":42');
      expect(text, `${surface}: placeholder present`).toContain('__REDACTED__');
    }
  });
});

describe('export redaction — the opt-out', () => {
  let result: AuditArtifacts;
  beforeAll(async () => {
    result = await runAudit({ agent: vaultRun, recordArgs: ['--no-redact-secrets'] });
  }, 90_000);
  afterAll(() => {
    if (result !== undefined) cleanupAudit(result);
  });

  it('--no-redact-secrets exports the values as recorded', () => {
    for (const surface of ['ndjson-export', 'html-export']) {
      const text = surfaceText(result, surface);
      expect(text, surface).toContain(TOKEN_CANARY);
      expect(text, surface).toContain(CAMEL_CANARY);
    }
  });
});
