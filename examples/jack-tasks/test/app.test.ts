/**
 * Acme Tasks as an ordinary API — before Jack is involved.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTasksApp } from '../src/app.js';
import { buildOpenApi } from '../src/openapi.js';
import { routes } from '../src/routes.js';

const call = async (app: Awaited<ReturnType<typeof createTasksApp>>['app'], method: string, path: string, key: string | null = 'tk_demo_alice', body?: unknown) => {
  const res = await app.request(path, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : null, type: res.headers.get('content-type') };
};

describe('the committed spec', () => {
  it('matches the code (run `pnpm --filter jack-tasks spec` after changing routes)', () => {
    const committed = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
    expect(committed).toEqual(buildOpenApi(routes));
  });
});

describe('Acme Tasks API', () => {
  it('requires a known API key, with an RFC 9457 problem', async () => {
    const { app } = await createTasksApp();
    for (const key of [null, 'tk_wrong']) {
      const r = await call(app, 'GET', '/tasks', key);
      expect(r.status).toBe(401);
      expect(r.type).toContain('application/problem+json');
    }
    expect((await call(app, 'GET', '/health', null)).status).toBe(200);
    expect((await call(app, 'GET', '/openapi.json', null)).json!.openapi).toBe('3.1.0');
  });

  it('isolates users: Bob never sees or touches Alice\'s data', async () => {
    const { app } = await createTasksApp();
    const bobs = (await call(app, 'GET', '/tasks', 'tk_demo_bob')).json!.items as Array<{ id: string }>;
    const alices = (await call(app, 'GET', '/tasks?limit=100')).json!.items as Array<{ id: string }>;
    expect(bobs.length).toBe(2);
    expect(alices.some((t) => bobs.some((b) => b.id === t.id))).toBe(false);
    expect((await call(app, 'GET', `/tasks/${alices[0]!.id}`, 'tk_demo_bob')).status).toBe(404);
    expect((await call(app, 'DELETE', `/tasks/${alices[0]!.id}`, 'tk_demo_bob')).status).toBe(404);
  });

  it('paginates with an opaque cursor and sorts most urgent first', async () => {
    const { app } = await createTasksApp();
    const p1 = (await call(app, 'GET', '/tasks?limit=2')).json!;
    expect(p1.items.map((t: { priority: string }) => t.priority)).toEqual(['urgent', 'high']);
    expect(p1.nextCursor).toEqual(expect.any(String));
    const p2 = (await call(app, 'GET', `/tasks?limit=2&cursor=${p1.nextCursor}`)).json!;
    expect(p2.items).toHaveLength(2);
    const p3 = (await call(app, 'GET', `/tasks?limit=2&cursor=${p2.nextCursor}`)).json!;
    expect(p3.nextCursor).toBeNull();
  });

  it('validates input and reports field errors', async () => {
    const { app } = await createTasksApp();
    const bad = await call(app, 'POST', '/tasks', 'tk_demo_alice', { projectId: 'prj_0001', title: '', dueDate: 'next week' });
    expect(bad.status).toBe(400);
    expect(bad.json!.errors.map((e: { path: string }) => e.path).sort()).toEqual(['dueDate', 'title']);
    expect((await call(app, 'POST', '/tasks', 'tk_demo_alice', '{nope')).status).toBe(400);
    expect((await call(app, 'PATCH', '/tasks/tsk_0003', 'tk_demo_alice', {})).status).toBe(400);
    expect((await call(app, 'POST', '/projects', 'tk_demo_alice', { name: 'operations' })).status).toBe(409);
  });

  it('routes the literal /tasks/search before /tasks/{taskId}', async () => {
    const { app } = await createTasksApp();
    const r = await call(app, 'GET', '/tasks/search?q=tls');
    expect(r.status).toBe(200);
    expect(r.json!.items[0].title).toBe('Renew TLS certificates');
  });
});
