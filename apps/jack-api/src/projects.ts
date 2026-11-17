/**
 * Project operations shared by the dashboard and `jack deploy`: import a
 * spec, edit the draft jack.yaml, see lint and the diff against what is
 * live, deploy, roll back, export. Every write goes through `compile`, so a
 * draft that would not compile is never saved.
 */
import { stringify as toYaml } from 'yaml';
import {
  diffManifests,
  jackConfig,
  manifestHash,
  projectSlug,
  toolOverride,
  type AuthConfig,
  type JackConfig,
  type Manifest,
  type ManifestDiff,
  type Project,
  type ToolAnnotations,
} from '@graphmind-ai/jack-schema';
import {
  compile,
  CompileError,
  generateConfig,
  LoadError,
  parseDocumentText,
  UnsupportedDocumentError,
  type CompileResult,
  type Diagnostic,
} from '@graphmind-ai/jack-openapi';
import type { SecretBox } from '@graphmind-ai/jack-auth';
import { NotFoundError, type JackStore, type StoredDeployment } from './store.js';

export class DraftError extends Error {
  override name = 'DraftError';
}

/** Errors from the compiler that mean "your input is wrong" (400), not "we broke" (500). */
export const isUserError = (err: unknown): boolean =>
  err instanceof DraftError || err instanceof CompileError || err instanceof LoadError || err instanceof UnsupportedDocumentError;

export interface ToolView {
  key: string;
  name: string;
  enabled: boolean;
  kind: 'read' | 'write' | 'destructive';
  method: string;
  path: string;
  summary?: string;
  deprecated: boolean;
  tags: string[];
  /** Effective values (spec + overrides), also for disabled tools so they can be edited before enabling. */
  description: string;
  descriptionIsCustom: boolean;
  confirm: boolean;
  requiredScopes: string[];
  annotations: ToolAnnotations;
  diagnostics: Diagnostic[];
}

export interface DraftView {
  config: JackConfig;
  dialect: string;
  baseUrl: string;
  tools: ToolView[];
  /** Project-level findings (tool-level ones are on each tool). */
  diagnostics: Diagnostic[];
  enabled: number;
  scopes: string[];
  toolsets: Manifest['toolsets'];
  live: { version: number | null; diff: ManifestDiff; changes: number; configChanged: boolean };
}

const kindOrder = { read: 0, write: 1, destructive: 2 } as const;

/** The spec's own text for a tool (summary + description), as the compiler would use it. */
function parse(text: string) {
  const doc = parseDocumentText(text, 'source');
  if (!doc || typeof doc !== 'object') throw new DraftError('the source is not an OpenAPI document');
  return doc;
}

export interface ImportPreview {
  title: string;
  dialect: string;
  baseUrl: string;
  operations: number;
  enabled: number;
  writes: number;
  diagnostics: Diagnostic[];
  config: JackConfig;
  tools: Array<{ key: string; method: string; path: string; summary?: string; enabled: boolean; kind: string }>;
}

/** Dry run of an import: what `jack init` would produce for this document. */
export function previewImport(text: string, opts: { url?: string | null; upstream?: string }): ImportPreview {
  const doc = parse(text);
  const { yaml, result, upstream } = generateConfig(doc, {
    source: opts.url ?? 'openapi.json',
    ...(opts.url ? { documentUrl: opts.url } : {}),
    ...(opts.upstream ? { upstream: opts.upstream } : {}),
  });
  const config = jackConfig.parse(parseDocumentText(yaml, 'generated'));
  return {
    title: result.manifest.name,
    dialect: result.dialect,
    baseUrl: upstream,
    operations: result.tools.length,
    enabled: result.tools.filter((t) => t.enabled).length,
    writes: result.tools.filter((t) => t.kind !== 'read').length,
    diagnostics: result.diagnostics,
    config,
    tools: result.tools.map((t) => ({ key: t.key, method: t.method, path: t.path, ...(t.summary ? { summary: t.summary } : {}), enabled: t.enabled, kind: t.kind })),
  };
}

export function slugFrom(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return projectSlug.safeParse(base).success ? base : `api-${Math.random().toString(36).slice(2, 8)}`;
}

export class Projects {
  constructor(
    private readonly store: JackStore,
    private readonly box: SecretBox,
    private readonly env: Record<string, string | undefined>,
  ) {}

  private async project(id: string): Promise<Project> {
    const p = await this.store.getProject(id);
    if (!p) throw new NotFoundError(`project ${id}`);
    return p;
  }

  private async source(projectId: string) {
    const s = await this.store.getSource(projectId);
    if (!s) throw new DraftError('this project has no API spec yet: import one first');
    return s;
  }

  private async draftConfig(projectId: string): Promise<JackConfig> {
    const d = await this.store.getDraft(projectId);
    if (!d) throw new DraftError('this project has no draft yet: import a spec first');
    return d.config;
  }

  /** Compile a config against the project's stored document. Throws on configs that cannot compile. */
  async compileConfig(projectId: string, config: JackConfig): Promise<CompileResult> {
    const s = await this.source(projectId);
    return compile(parse(s.text), config, s.url ? { documentUrl: s.url } : {});
  }

  /** Create a project from a spec. Returns the project and its first draft. */
  async createFromSource(input: { slug?: string; name?: string; text: string; url?: string | null; upstream?: string; ownerId?: string | null }) {
    const preview = previewImport(input.text, { url: input.url ?? null, ...(input.upstream ? { upstream: input.upstream } : {}) });
    const slug = input.slug ?? slugFrom(input.name ?? preview.title);
    const config: JackConfig = { ...preview.config, ...(input.name ? { name: input.name } : {}) };
    const project = await this.store.createProject({
      slug,
      name: input.name ?? preview.title,
      upstream: new URL(preview.baseUrl).origin,
      auth: { mode: 'none', requireSignIn: false },
      ownerId: input.ownerId ?? null,
    });
    await this.store.putSource(project.id, { text: input.text, url: input.url ?? null });
    await this.store.putDraft(project.id, config);
    return { project, draft: await this.draftView(project.id) };
  }

  /** Replace the spec (a new version of the API). Keeps every override in the draft. */
  async replaceSource(projectId: string, text: string, url: string | null) {
    await this.project(projectId);
    const existing = await this.store.getDraft(projectId);
    parse(text); // validate before storing
    await this.store.putSource(projectId, { text, url });
    if (!existing) {
      const preview = previewImport(text, { url });
      await this.store.putDraft(projectId, preview.config);
    } else {
      // A draft that no longer compiles against the new spec is still kept; the view reports why.
      await this.store.putDraft(projectId, { ...existing.config, ...(url ? { source: url } : {}) });
    }
    return await this.draftView(projectId);
  }

  /** Validate a whole config (from `jack deploy` or an import of jack.yaml) and save it as the draft. */
  async saveDraft(projectId: string, raw: unknown): Promise<DraftView> {
    await this.project(projectId);
    const parsed = jackConfig.safeParse(raw);
    if (!parsed.success) throw new DraftError(`not a valid jack.yaml: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    await this.compileConfig(projectId, parsed.data);
    await this.store.putDraft(projectId, parsed.data);
    return await this.draftView(projectId);
  }

  /**
   * Change one tool's override. `null` for a field removes the override
   * (back to the spec / the default rules).
   */
  async updateTool(projectId: string, key: string, patch: Record<string, unknown>): Promise<DraftView> {
    const config = structuredClone(await this.draftConfig(projectId));
    const current = { ...(config.tools[key] ?? {}) } as Record<string, unknown>;
    for (const [field, value] of Object.entries(patch)) {
      if (value === null) delete current[field];
      else current[field] = value;
    }
    const parsed = toolOverride.safeParse(current);
    if (!parsed.success) throw new DraftError(`invalid change to ${key}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')}`);
    config.tools[key] = parsed.data;
    const result = await this.compileConfig(projectId, config);
    if (!result.tools.some((t) => t.key === key)) throw new DraftError(`'${key}' is not an operation in the spec`);
    await this.store.putDraft(projectId, config);
    return await this.draftView(projectId);
  }

  /** Project-level settings in the draft: name, description, upstream, auth, lint, toolsets. */
  async updateSettings(projectId: string, patch: Record<string, unknown>): Promise<DraftView> {
    const config = structuredClone(await this.draftConfig(projectId)) as Record<string, unknown>;
    for (const [field, value] of Object.entries(patch)) {
      if (!['name', 'description', 'upstream', 'auth', 'lint', 'toolsets'].includes(field)) throw new DraftError(`unknown setting '${field}'`);
      if (value === null) delete config[field];
      else config[field] = value;
    }
    return await this.saveDraft(projectId, config);
  }

  async draftView(projectId: string): Promise<DraftView> {
    const config = await this.draftConfig(projectId);
    const result = await this.compileConfig(projectId, config);
    // Definitions for disabled tools too: compile once more with everything enabled.
    const allOn: JackConfig = {
      ...config,
      tools: Object.fromEntries(result.tools.map((t) => [t.key, { ...(config.tools[t.key] ?? {}), enabled: true }])),
    };
    let everything: CompileResult | null = null;
    try {
      everything = await this.compileConfig(projectId, allOn);
    } catch {
      everything = null; // e.g. two disabled tools renamed to the same name; enabled ones still show
    }
    const defs = new Map((everything ?? result).manifest.tools.map((t) => [t.name, t]));
    const toolDiags = new Map<string, Diagnostic[]>();
    const projectDiags: Diagnostic[] = [];
    for (const d of result.diagnostics) {
      const row = d.tool ? result.tools.find((t) => t.name === d.tool || t.key === d.tool) : undefined;
      if (row) toolDiags.set(row.key, [...(toolDiags.get(row.key) ?? []), d]);
      else projectDiags.push(d);
    }
    const tools: ToolView[] = result.tools
      .map((row) => {
        const def = defs.get(row.name);
        const override = config.tools[row.key] ?? {};
        return {
          key: row.key,
          name: row.name,
          enabled: row.enabled,
          kind: row.kind,
          method: row.method,
          path: row.path,
          ...(row.summary ? { summary: row.summary } : {}),
          deprecated: row.deprecated,
          tags: row.tags,
          description: def?.description ?? row.summary ?? '',
          descriptionIsCustom: override.description !== undefined,
          confirm: def?.confirm ?? override.confirm ?? false,
          requiredScopes: def?.requiredScopes ?? [],
          annotations: def?.annotations ?? {},
          diagnostics: toolDiags.get(row.key) ?? [],
        };
      })
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || kindOrder[a.kind] - kindOrder[b.kind]);

    const live = await this.store.activeDeployment(projectId);
    const diff = diffManifests(live?.manifest ?? null, result.manifest);
    const changes = diff.added.length + diff.removed.length + diff.changed.length + diff.rewired.length;
    const configChanged =
      live !== null && JSON.stringify(live.config?.auth ?? null) !== JSON.stringify(config.auth ?? { mode: 'none', requireSignIn: false });
    return {
      config,
      dialect: result.dialect,
      baseUrl: result.baseUrl,
      tools,
      diagnostics: projectDiags,
      enabled: result.manifest.tools.length,
      scopes: result.manifest.scopes,
      toolsets: result.manifest.toolsets,
      live: { version: live?.version ?? null, diff, changes, configChanged },
    };
  }

  /** Resolve `secret:NAME` (project secrets) and `env:NAME` (server environment). */
  async resolveSecret(projectId: string, ref: string): Promise<string | undefined> {
    const m = /^(secret|env):([A-Za-z_][A-Za-z0-9_]*)$/.exec(ref);
    if (!m) return undefined;
    if (m[1] === 'env') return this.env[m[2] as string];
    const sealed = await this.store.getSecret(projectId, m[2] as string);
    return sealed ? this.box.open(sealed, `secret:${projectId}:${m[2]}`) : undefined;
  }

  async setSecret(projectId: string, name: string, value: string) {
    await this.project(projectId);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new DraftError('secret names are letters, digits and _');
    if (value === '' || value.length > 8192) throw new DraftError('secret value must be 1–8192 characters');
    await this.store.putSecret(projectId, name, this.box.seal(value, `secret:${projectId}:${name}`));
  }

  private async checkDeployable(projectId: string, auth: AuthConfig | undefined) {
    if (auth?.mode === 'oidc' && (await this.resolveSecret(projectId, auth.clientSecretRef)) === undefined) {
      throw new DraftError(`sign-in needs the client secret (${auth.clientSecretRef}); set it on the Sign-in page before deploying`);
    }
    if (auth?.mode === 'link' && (await this.resolveSecret(projectId, auth.secretRef)) === undefined) {
      throw new DraftError(`account linking needs the shared secret (${auth.secretRef}); set it on the Sign-in page before deploying`);
    }
  }

  /** Compile the draft, snapshot it as a new version, and make it live. */
  async deploy(projectId: string, actor: string, message?: string): Promise<{ deployment: StoredDeployment; diff: ManifestDiff; project: Project }> {
    const config = await this.draftConfig(projectId);
    await this.checkDeployable(projectId, config.auth);
    const result = await this.compileConfig(projectId, config);
    const before = await this.store.activeDeployment(projectId);
    const deployment = await this.store.createDeployment({
      projectId,
      manifest: result.manifest,
      manifestHash: manifestHash(result.manifest),
      createdBy: actor,
      config,
      message: message ?? null,
    });
    const project = await this.promote(projectId, deployment.version);
    return { deployment, diff: diffManifests(before?.manifest ?? null, result.manifest), project };
  }

  /** Make a version live (deploy or roll back). Its sign-in settings go live with it. */
  async promote(projectId: string, version: number): Promise<Project> {
    const d = await this.store.getDeployment(projectId, version);
    if (!d) throw new NotFoundError(`deployment ${version}`);
    if (d.config) await this.checkDeployable(projectId, d.config.auth);
    return await this.store.updateProject(projectId, {
      activeVersion: version,
      upstream: d.manifest.upstream,
      ...(d.config ? { auth: d.config.auth ?? { mode: 'none', requireSignIn: false } } : {}),
    });
  }

  async history(projectId: string) {
    const all = await this.store.listDeployments(projectId);
    return all.map((d, i) => {
      const prev = all[i + 1];
      const diff = diffManifests(prev?.manifest ?? null, d.manifest);
      return {
        version: d.version,
        createdAt: d.createdAt,
        createdBy: d.createdBy,
        message: d.message,
        tools: d.manifest.tools.length,
        auth: d.config?.auth?.mode ?? null,
        manifestHash: d.manifestHash,
        diff,
      };
    });
  }

  async exportYaml(projectId: string): Promise<string> {
    const p = await this.project(projectId);
    const config = await this.draftConfig(projectId);
    const s = await this.store.getSource(projectId);
    const out: Record<string, unknown> = { ...config, source: s?.url ?? './openapi.json' };
    // Drop empty defaults so the file reads like a hand-written one.
    if (Object.keys(config.toolsets).length === 0) delete out.toolsets;
    const header = [
      `# jack.yaml for ${p.name} — exported from the Jack dashboard on ${new Date().toISOString().slice(0, 10)}.`,
      '# Commit it next to your spec; `jack deploy` uploads it back.',
      ...(s?.url ? [] : ['# The spec was uploaded to the dashboard: save it as ./openapi.json next to this file.']),
      '',
    ].join('\n');
    return header + toYaml(out, { lineWidth: 100 });
  }
}
