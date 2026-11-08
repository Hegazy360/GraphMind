import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRIES, normalizeRetries, workflow, WorkflowConfigError, z } from '../src/index.js';

describe('workflow()', () => {
  it('applies defaults', () => {
    const wf = workflow({ name: 'triage-invoice' }, async () => null);
    expect(wf.config.triggers).toEqual([{ type: 'api' }]);
    expect(wf.config.onError).toBe('pause');
    expect(wf.config.retries).toEqual(DEFAULT_RETRIES);
    expect(wf.config.timeoutMs).toBe(7 * 86_400_000);
  });

  it('rejects bad names at definition time', () => {
    for (const name of ['Triage', 'has space', '-lead', '', 'a'.repeat(65)]) {
      expect(() => workflow({ name }, async () => null)).toThrow(WorkflowConfigError);
    }
  });

  it('keeps explicit schemas and triggers', () => {
    const wf = workflow(
      {
        name: 'x',
        input: z.object({ id: z.string() }),
        triggers: [{ type: 'cron', schedule: '0 9 * * 1-5', tz: 'Europe/Berlin' }],
        retries: 3,
        onError: 'fail',
        timeout: '48h',
      },
      async (_ctx, input) => input.id,
    );
    expect(wf.config.retries.max).toBe(3);
    expect(wf.config.onError).toBe('fail');
    expect(wf.config.timeoutMs).toBe(48 * 3_600_000);
  });
});

describe('normalizeRetries', () => {
  it('expands a number and validates a policy', () => {
    expect(normalizeRetries(5, DEFAULT_RETRIES).max).toBe(5);
    expect(normalizeRetries(undefined, DEFAULT_RETRIES)).toBe(DEFAULT_RETRIES);
    expect(() => normalizeRetries(0, DEFAULT_RETRIES)).toThrow(WorkflowConfigError);
    expect(() => normalizeRetries(1.5, DEFAULT_RETRIES)).toThrow(WorkflowConfigError);
  });
});
