/**
 * Test backends: every store-level and executor-level suite runs once per
 * JournalStore implementation, so the two cannot drift apart. The Postgres
 * leg needs PG_TEST_URL (a throwaway database); without it the pg cases are
 * skipped, so `pnpm test` works on a laptop with no Postgres.
 *
 * Each openStore() call gets a fresh store — for pg a fresh `t_<random>`
 * schema, migrated, and dropped when the test finishes.
 */
import { onTestFinished } from 'vitest';
import { testSql } from '@graphmind-ai/db';
import { PgJournalStore, SqliteJournalStore, type JournalStore } from '../src/index.js';

export type Backend = 'sqlite' | 'pg';
export const BACKENDS: readonly Backend[] = ['sqlite', 'pg'];
export const pgAvailable = Boolean(process.env.PG_TEST_URL);
/** For describe.skipIf: true when this backend cannot run here. */
export const unavailable = (backend: Backend): boolean => backend === 'pg' && !pgAvailable;

export async function openStore(backend: Backend): Promise<JournalStore> {
  if (backend === 'sqlite') {
    const store = new SqliteJournalStore(':memory:');
    onTestFinished(() => store.close());
    return store;
  }
  const t = await testSql();
  if (!t) throw new Error('PG_TEST_URL is not set');
  onTestFinished(() => t.drop());
  const store = new PgJournalStore(t.sql, { schema: t.schema });
  await store.migrate();
  return store;
}

/** A second store over the same pg schema — a second "worker process" for concurrency tests. */
export async function openPgPair(): Promise<{ a: PgJournalStore; b: PgJournalStore; schema: string }> {
  const t1 = await testSql();
  if (!t1) throw new Error('PG_TEST_URL is not set');
  const t2 = await testSql();
  if (!t2) throw new Error('PG_TEST_URL is not set');
  onTestFinished(async () => {
    await t2.drop(); // drops t2's own (unused) schema and closes its pool
    await t1.drop();
  });
  const a = new PgJournalStore(t1.sql, { schema: t1.schema });
  await a.migrate();
  const b = new PgJournalStore(t2.sql, { schema: t1.schema });
  return { a, b, schema: t1.schema };
}
