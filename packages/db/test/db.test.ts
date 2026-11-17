import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ident, migrate, testSql, type Sql } from '../src/index.js';

const t = await testSql();
const d = t ? describe : describe.skip;

d('db (PG_TEST_URL)', () => {
  let sql: Sql;
  let schema: string;
  beforeAll(() => {
    sql = t!.sql;
    schema = t!.schema;
  });
  afterAll(async () => t?.drop());

  it('applies each migration once, in order', async () => {
    const m = [
      { id: 'a', statements: ['CREATE TABLE {schema}.things (id TEXT PRIMARY KEY, n BIGINT NOT NULL)'] },
      { id: 'b', statements: ['ALTER TABLE {schema}.things ADD COLUMN body JSONB'] },
    ];
    expect(await migrate(sql, schema, m)).toEqual(['a', 'b']);
    expect(await migrate(sql, schema, m)).toEqual([]);
    const both = await Promise.all([migrate(sql, schema, m), migrate(sql, schema, m)]);
    expect(both).toEqual([[], []]);
  });

  it('parses bigint as number and jsonb as objects', async () => {
    await sql.query(`INSERT INTO ${ident(schema)}.things (id, n, body) VALUES ($1, $2, $3)`, ['x', 1_763_400_000_000, { a: [1] }]);
    const [row] = await sql.query<{ n: number; body: unknown }>(`SELECT n, body FROM ${ident(schema)}.things WHERE id = $1`, ['x']);
    expect(row).toEqual({ n: 1_763_400_000_000, body: { a: [1] } });
  });

  it('rolls a transaction back when it throws', async () => {
    await expect(
      sql.tx(async (q) => {
        await q.query(`INSERT INTO ${ident(schema)}.things (id, n) VALUES ('y', 1)`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await sql.query(`SELECT 1 FROM ${ident(schema)}.things WHERE id = 'y'`)).toEqual([]);
  });

  it('refuses unsafe identifiers', () => {
    expect(() => ident('a"; drop')).toThrow();
  });
});
