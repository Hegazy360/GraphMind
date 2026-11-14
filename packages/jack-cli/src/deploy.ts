/**
 * `jack deploy` — push a reviewed jack.yaml to a Jack server and make it live.
 *
 *   jack deploy [--config jack.yaml] [--project <slug>] [--server <url>] [--api-key <key>] [--message "…"]
 *
 * The same API the dashboard uses: create the project (first time) or
 * replace its spec, save jack.yaml as the draft, deploy. Compiles locally
 * first, so a broken file never reaches the server. An oidc client secret
 * given as `env:NAME` is uploaded into the project's encrypted secrets
 * (the server may not share your environment) and referenced as `secret:NAME`.
 */
import { compileProject } from '@graphmind-ai/jack-openapi';
import { projectSlug, type JackConfig } from '@graphmind-ai/jack-schema';
import type { Io } from './commands.js';
import { readRunInfo } from './ports.js';

export interface DeployOptions {
  config?: string;
  project?: string;
  server?: string;
  apiKey?: string;
  message?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export class DeployError extends Error {
  override name = 'DeployError';
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');

export async function deployCommand(opts: DeployOptions, io: Io): Promise<number> {
  const env = opts.env ?? process.env;
  const server = (opts.server ?? readRunInfo('serve')?.url)?.replace(/\/$/, '');
  if (!server) throw new DeployError('no Jack server to deploy to: start `jack serve` in this worktree, or pass --server <url>');
  const f = opts.fetchImpl ?? fetch;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await f(`${server}/v1${path}`, {
      method,
      headers: {
        'x-jack-actor': 'jack deploy',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }).catch((err: Error) => {
      throw new DeployError(`could not reach ${server} (${err.message})`);
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) throw new DeployError(`${method} ${path}: ${data.detail ?? data.title ?? `HTTP ${res.status}`}`);
    return data;
  };

  // 1. Compile here: the same compiler the server runs, so errors show up before anything is sent.
  const local = await compileProject(opts.config ?? 'jack.yaml', { env });
  const slug = opts.project ?? slugify(local.config.name ?? local.manifest.name);
  if (!projectSlug.safeParse(slug).success) throw new DeployError(`'${slug}' is not a valid project slug; pass --project <slug>`);
  const text = JSON.stringify(local.source.document);
  const sourceUrl = local.source.documentUrl ?? null;
  io.out(`jack deploy — ${local.manifest.name}: ${local.manifest.tools.length} tools → ${server} (project ${slug})`);

  // 2. Project: create on first deploy, otherwise replace its spec (overrides live in jack.yaml).
  const { projects } = await call('GET', '/projects');
  let project = (projects as Array<{ id: string; slug: string }>).find((p) => p.slug === slug);
  if (!project) {
    const created = await call('POST', '/projects', { slug, name: local.config.name ?? local.manifest.name, upstream: local.baseUrl, source: { text, ...(sourceUrl ? { url: sourceUrl } : {}) } });
    project = created.project as { id: string; slug: string };
    io.out(`  created project ${slug}`);
  } else {
    await call('PUT', `/projects/${project.id}/source`, { text, ...(sourceUrl ? { url: sourceUrl } : {}) });
  }

  // 3. Secrets: env:NAME in jack.yaml → the project's encrypted secret store.
  const config: JackConfig = { ...local.config, source: sourceUrl ?? 'openapi.json', upstream: local.baseUrl };
  if (config.auth?.mode === 'oidc') {
    const m = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(config.auth.clientSecretRef);
    if (m) {
      const value = env[m[1] as string];
      if (!value) throw new DeployError(`auth.clientSecretRef is ${config.auth.clientSecretRef}, but ${m[1]} is not set here`);
      await call('PUT', `/projects/${project.id}/secrets/${m[1]}`, { value });
      config.auth = { ...config.auth, clientSecretRef: `secret:${m[1]}` };
      io.out(`  uploaded secret ${m[1]} (stored encrypted)`);
    }
  }

  // 4. Draft, then deploy.
  await call('PUT', `/projects/${project.id}/draft`, { config });
  const r = await call('POST', `/projects/${project.id}/deploy`, { ...(opts.message ? { message: opts.message } : {}) });
  const d = r.diff as { added: string[]; removed: string[]; changed: string[]; rewired: string[] };
  const parts = [
    d.added.length ? `+${d.added.length} added` : '',
    d.removed.length ? `-${d.removed.length} removed` : '',
    d.changed.length ? `${d.changed.length} changed` : '',
    d.rewired.length ? `${d.rewired.length} settings` : '',
  ].filter(Boolean);
  io.out(`  deployed v${r.deployment.version} (${parts.join(', ') || 'no tool changes'})`);
  io.out(`  MCP URL:   ${r.project.mcpUrl}`);
  io.out(`  dashboard: ${server}/#/p/${project.id}/deploy`);
  return 0;
}
