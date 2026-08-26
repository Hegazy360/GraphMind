/** Minimal PASS/FAIL harness with a summary table. */

export interface CheckResult {
  id: string;
  desc: string;
  pass: boolean;
  detail: string;
}

export class Suite {
  readonly results: CheckResult[] = [];

  check(id: string, desc: string, pass: boolean, detail = ''): void {
    this.results.push({ id, desc, pass, detail });
    const tag = pass ? 'PASS' : 'FAIL';
    console.log(`  [${tag}] ${id}: ${desc}${detail !== '' ? ` -- ${detail}` : ''}`);
  }

  get failures(): CheckResult[] {
    return this.results.filter(r => !r.pass);
  }

  printSummary(): void {
    console.log('\n================ SUMMARY ================');
    for (const r of this.results) {
      console.log(
        `${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(4)} ${r.desc}${r.detail !== '' ? ` (${r.detail})` : ''}`,
      );
    }
    const failed = this.failures.length;
    console.log('-----------------------------------------');
    console.log(
      failed === 0
        ? `ALL ${this.results.length} ASSERTIONS PASSED`
        : `${failed}/${this.results.length} ASSERTIONS FAILED`,
    );
  }
}

export const fmt = (n: number | undefined): string =>
  n === undefined ? 'n/a' : `${n.toFixed(1)}ms`;

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k, i) =>
      k === kb[i] &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}
