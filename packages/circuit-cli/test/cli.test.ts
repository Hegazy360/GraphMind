import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workflow, type Ctx } from '@graphmind-ai/circuit-sdk';
import { Executor, exportFixture, ManualClock, SqliteJournalStore } from '@graphmind-ai/circuit-engine';
import { loadWorkflows } from '../src/load.js';
import { runFixtureTests } from '../src/testing.js';

describe('loadWorkflows', () => {
  it('finds every exported definition and ignores lookalikes', async () => {
    const defs = await loadWorkflows(join(import.meta.dirname, 'fixtures', 'workflows.mjs'));
    expect(defs.map((d) => d.config.name).sort()).toEqual(['greet', 'sum']);
  });

  it('refuses a module with no workflows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'circuit-cli-'));
    const empty = join(dir, 'empty.mjs');
    writeFileSync(empty, 'export const x = 1;\n');
    await expect(loadWorkflows(empty)).rejects.toThrow(/exports no workflows/);
  });
});

describe('runFixtureTests', () => {
  const v1 = () =>
    workflow({ name: 'trip' }, async (ctx: Ctx) => {
      const yen = await ctx.step('fetch-price', () => 402_000);
      return { usd: Math.round((yen as number) / 150) };
    });

  async function recordFixtureDir() {
    const clock = new ManualClock();
    const store = new SqliteJournalStore(':memory:');
    const executor = new Executor({ store, clock, workflows: [v1()] });
    const run = executor.enqueue('trip', null);
    await executor.drain();
    const dir = mkdtempSync(join(tmpdir(), 'circuit-fixtures-'));
    writeFileSync(join(dir, 'trip.json'), JSON.stringify(exportFixture(store, run.id)));
    return dir;
  }

  it('passes against unchanged code and fails on a regression, naming it', async () => {
    const dir = await recordFixtureDir();
    const pass = await runFixtureTests([v1()], dir);
    expect(pass.failed).toBe(0);
    expect(readdirSync(dir)).toEqual(['trip.json']);

    const regressed = workflow({ name: 'trip' }, async (ctx: Ctx) => {
      const yen = await ctx.step('fetch-price', () => 0);
      return { usd: Math.round((yen as number) * 150) }; // inverted the rate
    });
    const fail = await runFixtureTests([regressed], dir);
    expect(fail.failed).toBe(1);
    expect(fail.results[0]?.verdict.kind).toBe('output-changed');
  });

  it('reports a fixture whose workflow is gone', async () => {
    const dir = await recordFixtureDir();
    const { results, failed } = await runFixtureTests([], dir);
    expect(failed).toBe(1);
    expect(results[0]?.verdict.kind).toBe('no-workflow');
  });
});
