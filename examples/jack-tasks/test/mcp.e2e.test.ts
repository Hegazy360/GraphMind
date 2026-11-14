/**
 * The whole M2 stack, the way an engineer uses it:
 *   Acme Tasks (real HTTP) ← jack preview (this repo's jack.yaml) ← MCP client
 *
 * Uses the CLI's own `startPreview` and `jack call` client, so what passes
 * here is what the QA steps in the README exercise by hand.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callCommand, connectClient, startPreview, type Io, type PreviewHandle } from '@graphmind-ai/jack-cli';
import { createTasksApp } from '../src/app.js';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'jack-tasks-e2e-'));
let api: ServerType;
let configPath = '';
const previews: PreviewHandle[] = [];

/** The committed jack.yaml, unchanged: its upstream comes from ${ACME_TASKS_URL}, as in any worktree. */
let apiUrl = '';

function capture(): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) };
}

async function preview(key: string, extra: { egress?: 'any' | 'public' } = {}) {
  const io = capture();
  const handle = await startPreview({ config: configPath, port: 0, watch: false, env: { JACK_UPSTREAM_API_KEY: key, ACME_TASKS_URL: apiUrl }, ...extra }, io);
  previews.push(handle);
  /** Call a tool the way `jack call` does; returns the printed text and exit code. */
  const call = async (tool: string, args: Record<string, unknown> = {}, confirm: 'yes' | 'no' = 'yes') => {
    const out = capture();
    const code = await callCommand(tool, JSON.stringify(args), { url: handle.url!, confirm }, out);
    const text = out.lines.join('\n');
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON: an error or a note */
    }
    return { code, text, json, prompts: out.errors.join('\n') };
  };
  return { handle, io, call };
}

beforeAll(async () => {
  const { app } = await createTasksApp();
  await new Promise<void>((r) => {
    api = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => r());
  });
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  configPath = here('../jack.yaml');
});

afterAll(async () => {
  await Promise.all(previews.map((p) => p.close()));
  await new Promise<void>((r) => api.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe('jack preview of Acme Tasks', () => {
  it('publishes exactly the curated tools, with annotations and model-facing descriptions', async () => {
    const { handle, io } = await preview('tk_demo_alice');
    expect(io.lines[0]).toMatch(/jack preview — Acme Tasks: 12 tools/);
    const client = await connectClient({ url: handle.url! }, capture());
    const { tools } = await client.listTools();
    await client.close();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_comment',
      'create_project',
      'create_task',
      'delete_task',
      'get_activity_report',
      'get_me',
      'get_task',
      'list_comments',
      'list_projects',
      'list_tasks',
      'replace_task_labels',
      'update_task',
    ]);
    const del = tools.find((t) => t.name === 'delete_task')!;
    expect(del.annotations).toMatchObject({ destructiveHint: true });
    expect(del.description).toMatch(/asked to approve first/);
    expect(tools.find((t) => t.name === 'get_task')!.description).toMatch(/Use list_tasks first/);
  });

  it('an agent-style session: look up, create, update, comment, relabel, filter', async () => {
    const { call } = await preview('tk_demo_alice');
    const me = await call('get_me');
    expect(me.json).toMatchObject({ id: 'usr_alice', name: 'Alice Martin' });

    const projects = await call('list_projects');
    const launch = projects.json.items.find((p: { name: string }) => p.name === 'Website launch');

    const created = await call('create_task', { projectId: launch.id, title: 'Draft press kit', priority: 'high', dueDate: '2026-11-25' });
    expect(created.code).toBe(0);
    expect(created.json).toMatchObject({ title: 'Draft press kit', status: 'todo', priority: 'high' });
    const id = created.json.id as string;

    expect((await call('update_task', { taskId: id, status: 'done' })).json).toMatchObject({ status: 'done' });
    expect((await call('add_comment', { taskId: id, body: 'Sent to the agency.' })).json).toMatchObject({ author: { name: 'Alice Martin' } });
    // Array request body (bodyArg) all the way through.
    expect((await call('replace_task_labels', { taskId: id, body: ['press', 'launch'] })).json.labels).toEqual(['press', 'launch']);

    const filtered = await call('list_tasks', { label: 'press' });
    expect(filtered.json.items.map((t: { id: string }) => t.id)).toEqual([id]);
    expect((await call('list_comments', { taskId: id })).json.items).toHaveLength(1);
    expect((await call('get_task', { taskId: id })).json.commentCount).toBe(1);
  });

  it('delete_task needs the user\'s approval: declined does nothing, approved deletes', async () => {
    const { call, io } = await preview('tk_demo_alice');
    const target = (await call('list_tasks', { q: 'on-call' })).json.items[0].id as string;

    const no = await call('delete_task', { taskId: target }, 'no');
    expect(no.code).toBe(1);
    expect(no.prompts).toMatch(/Delete a task — This action is destructive/);
    expect(no.text).toMatch(/did not approve/);
    expect((await call('get_task', { taskId: target })).code).toBe(0);

    const yes = await call('delete_task', { taskId: target }, 'yes');
    expect(yes.code).toBe(0);
    expect(yes.text).toMatch(/HTTP 204/);
    const gone = await call('get_task', { taskId: target });
    expect(gone.code).toBe(1);
    expect(gone.text).toMatch(/HTTP 404[\s\S]*no task/);
    expect(io.errors.some((l) => /✗ delete_task +— .*declined/.test(l))).toBe(true);
  });

  it('acts as exactly one user: Bob\'s preview cannot see Alice\'s tasks', async () => {
    const alice = await preview('tk_demo_alice');
    const bob = await preview('tk_demo_bob');
    const aliceTask = (await alice.call('list_tasks')).json.items[0].id as string;
    expect((await bob.call('get_me')).json.id).toBe('usr_bob');
    expect((await bob.call('get_task', { taskId: aliceTask })).text).toMatch(/HTTP 404/);
  });

  it('tells the model what went wrong: bad arguments, API validation, truncation', async () => {
    const { call } = await preview('tk_demo_alice');
    const enumErr = await call('update_task', { taskId: 'tsk_0003', status: 'finished' });
    expect(enumErr.text).toMatch(/Invalid arguments for update_task: \/status must be equal to one of the allowed values/);
    const apiErr = await call('create_project', { name: 'Operations' });
    expect(apiErr.text).toMatch(/HTTP 409[\s\S]*already have a project named/);
    const report = await call('get_activity_report');
    expect(report.text).toMatch(/\[Truncated by Jack: the response was \d+ bytes and this tool returns at most 6000/);
    expect((await call('get_activity_report', { days: 0 })).text).toMatch(/days must be >= 1/);
  });

  it('a wrong API key surfaces as a 401 the model can explain; without a key the preview switches to per-user sign-in', async () => {
    const { call } = await preview('tk_not_a_key');
    expect((await call('get_me')).text).toMatch(/HTTP 401[\s\S]*refused the credentials/);
    const signIn = await startPreview({ config: configPath, port: 0, watch: false, env: { ACME_TASKS_URL: apiUrl }, stateDir: join(dir, 'state-m2') }, capture());
    previews.push(signIn);
    expect(signIn.mode).toBe('sign-in');
    expect(signIn.auth).not.toBeNull();
  });

  it('--egress public behaves like the hosted service: localhost is refused', async () => {
    const { call } = await preview('tk_demo_alice', { egress: 'public' });
    expect((await call('get_me')).text).toMatch(/not a public address/);
  });
});
