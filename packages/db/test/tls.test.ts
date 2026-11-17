import { X509Certificate, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SUPABASE_ROOT_CA_2021, connectionOptions } from '../src/index.js';

describe('connectionOptions', () => {
  it('verifies Supabase hosts against the pinned root and drops URL ssl overrides', () => {
    const o = connectionOptions('postgres://graphmind_app.ref:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?sslmode=require&uselibpqcompat=true');
    expect(o.connectionString).toBe('postgres://graphmind_app.ref:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres');
    expect(o.ssl).toEqual({ ca: SUPABASE_ROOT_CA_2021, rejectUnauthorized: true, servername: 'aws-0-eu-west-1.pooler.supabase.com' });
    expect(connectionOptions('postgres://u:p@db.ref.supabase.co:5432/postgres').ssl).toMatchObject({ rejectUnauthorized: true });
  });

  it('leaves other hosts alone, including look-alikes', () => {
    expect(connectionOptions('postgres://gm@127.0.0.1:5432/x')).toEqual({ connectionString: 'postgres://gm@127.0.0.1:5432/x' });
    expect(connectionOptions('postgres://u:p@supabase.com.evil.example/x').ssl).toBeUndefined();
  });

  it('never echoes an unparseable connection string', () => {
    expect(() => connectionOptions('not a url with secret-pw')).toThrow('invalid Postgres connection string');
    try {
      connectionOptions('not a url with secret-pw');
    } catch (e) {
      expect(String(e)).not.toContain('secret-pw');
    }
  });

  it('pins the expected certificate', () => {
    const cert = new X509Certificate(SUPABASE_ROOT_CA_2021);
    expect(cert.subject).toContain('CN=Supabase Root 2021 CA');
    expect(cert.fingerprint256).toBe('80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA');
    expect(createHash('sha256').update(cert.raw).digest('hex')).toHaveLength(64);
  });
});
