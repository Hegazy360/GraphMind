/**
 * Parity pin: the retrospective silent-failure count must agree with the
 * live `error-result` smart breakpoint, shape for shape.
 */
import { describe, expect, it } from 'vitest';
import { errorResultShape as clientShape } from '@graphmind-ai/client';
import { errorResultShape } from '../src/errorShape.js';

const SAMPLES: unknown[] = [
  undefined,
  null,
  'error',
  42,
  ['error'],
  { isError: true },
  { isError: false, text: 'fine' },
  { success: false },
  { success: true },
  { exit_code: 1 },
  { exitCode: 0 },
  { exitCode: NaN },
  { exitStatus: 2, out: '' },
  { error: 'boom' },
  { error: null },
  { error: false },
  { error: 'boom', detail: 'x' }, // two keys: not the error-only shape
  Object.assign(Object.create({ inherited: 1 }) as object, { error: 'boom' }),
];

describe('errorResultShape', () => {
  it('matches the client rule on every sample', () => {
    for (const sample of SAMPLES) {
      expect(errorResultShape(sample)).toBe(clientShape(sample));
    }
  });

  it('never throws on hostile objects', () => {
    const trap = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
        ownKeys() {
          throw new Error('trap');
        },
      },
    );
    expect(errorResultShape(trap)).toBeUndefined();
  });
});
