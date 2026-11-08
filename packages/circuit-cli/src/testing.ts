/**
 * `circuit test` — replay every recorded fixture against the current code.
 * A fixture is exportFixture() JSON committed to the repo; the suite fails
 * on any divergence or output regression, with the exact entry named.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { replayFixture, type Fixture, type FixtureVerdict } from '@graphmind-ai/circuit-engine';
import type { AnyWorkflow } from '@graphmind-ai/circuit-sdk';

export interface FixtureResult {
  file: string;
  workflow: string;
  verdict: FixtureVerdict | { kind: 'no-workflow' };
}

export function describeVerdict(verdict: FixtureResult['verdict']): string {
  switch (verdict.kind) {
    case 'pass':
      return 'pass';
    case 'no-workflow':
      return 'FAIL — no workflow with this name is exported';
    case 'output-changed':
      return `FAIL — same trajectory, different output: recorded ${JSON.stringify(verdict.recorded)}, now ${JSON.stringify(verdict.replayed)}`;
    case 'diverged':
      return `FAIL — ${verdict.divergence.type} divergence`;
    case 'incomplete':
      return `FAIL — ${verdict.detail}`;
    case 'replay-error':
      return `FAIL — workflow code threw during replay: ${verdict.error.name}: ${verdict.error.message}`;
  }
}

export async function runFixtureTests(
  defs: ReadonlyArray<AnyWorkflow>,
  fixtureDir: string,
): Promise<{ results: FixtureResult[]; failed: number }> {
  const byName = new Map(defs.map((def) => [def.config.name, def]));
  const results: FixtureResult[] = [];
  const files = readdirSync(fixtureDir)
    .filter((file) => file.endsWith('.json'))
    .sort();
  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(fixtureDir, file), 'utf8')) as Fixture;
    if (fixture.circuitFixture !== 1) continue;
    const def = byName.get(fixture.workflow);
    if (!def) {
      results.push({ file, workflow: fixture.workflow, verdict: { kind: 'no-workflow' } });
      continue;
    }
    results.push({ file, workflow: fixture.workflow, verdict: await replayFixture(def, fixture) });
  }
  const failed = results.filter((r) => r.verdict.kind !== 'pass').length;
  return { results, failed };
}
