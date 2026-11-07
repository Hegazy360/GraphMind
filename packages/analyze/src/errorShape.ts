/**
 * The strict error-shaped-result rule, ported from the client's smart
 * breakpoints (@graphmind-ai/client, smart.ts `errorResultShape`) so a
 * retrospective analysis counts exactly the results the live `error-result`
 * breakpoint would have held on. The client cannot be imported here (the
 * viewer bundles this package); test/errorShape.test.ts pins parity.
 *
 * Top level only, no substring matching:
 *   - `isError === true` (MCP's tool-error result);
 *   - `success === false`;
 *   - `exit_code` / `exitCode` / `exitStatus` is a number other than 0;
 *   - a plain object whose ONLY own key is `error`, with a value other than
 *     null / undefined / false.
 */

export type ErrorResultShape = 'isError' | 'success' | 'exit_code' | 'exitCode' | 'exitStatus' | 'error';

const EXIT_KEYS = ['exit_code', 'exitCode', 'exitStatus'] as const;

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The shape by which `result` says "failure", or undefined. Never throws. */
export function errorResultShape(result: unknown): ErrorResultShape | undefined {
  try {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) return undefined;
    const record = result as Record<string, unknown>;
    if (record['isError'] === true) return 'isError';
    if (record['success'] === false) return 'success';
    for (const key of EXIT_KEYS) {
      const code = record[key];
      if (typeof code === 'number' && !Number.isNaN(code) && code !== 0) return key;
    }
    if (!isPlainObject(record)) return undefined;
    const keys = Object.keys(record);
    if (keys.length !== 1 || keys[0] !== 'error') return undefined;
    const error = record['error'];
    if (error === null || error === undefined || error === false) return undefined;
    return 'error';
  } catch {
    return undefined;
  }
}
