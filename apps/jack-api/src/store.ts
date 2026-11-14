/**
 * JackStore — the control plane's persistence contract. One interface, two
 * backends (as Circuit): `SqliteStore` on `node:sqlite` for dev, tests and
 * single-node self-hosting; a Postgres store for the hosted service (M7).
 *
 * Per project:
 *   source       the OpenAPI document (text) and where it came from
 *   draft        the jack.yaml being edited (a JackConfig) — what the dashboard
 *                and `jack deploy` write; nothing serves it until deployed
 *   deployments  immutable snapshots (manifest + the config it came from)
 *   secrets      sealed values referenced from config as `secret:NAME`
 *   calls        the call log (never arguments, never credentials)
 *
 * Tenancy: a project has an optional `ownerId` (a user from
 * `@graphmind-ai/accounts`). With accounts on, every control-plane call is
 * scoped to the caller's projects; without them (local `jack serve`) the
 * owner is null and the whole store is one workspace.
 */
import type { AuthConfig, Deployment, JackConfig, Manifest, Project } from '@graphmind-ai/jack-schema';

export interface NewProject {
  slug: string;
  name: string;
  upstream: string;
  auth: AuthConfig;
  /** The account that owns the project, or null for a single-workspace server. */
  ownerId?: string | null;
}

/** A project as stored: the wire shape plus who owns it (never sent to clients). */
export interface OwnedProject extends Project {
  ownerId: string | null;
}

export interface NewDeployment {
  projectId: string;
  manifest: Manifest;
  manifestHash: string;
  createdBy: string;
  /** The jack.yaml the manifest was compiled from (null for raw-manifest uploads). */
  config?: JackConfig | null;
  message?: string | null;
}

export interface StoredDeployment extends Deployment {
  config: JackConfig | null;
  message: string | null;
}

export interface SourceRecord {
  text: string;
  /** Where it was fetched from, or null for an upload. */
  url: string | null;
  updatedAt: number;
}

export interface SecretInfo {
  name: string;
  updatedAt: number;
}

export interface CallRow {
  id: number;
  projectId: string;
  version: number | null;
  tool: string;
  status: string;
  upstreamStatus: number | null;
  ms: number;
  requestBytes: number;
  responseBytes: number;
  subject: string | null;
  clientId: string | null;
  at: number;
}

export interface JackStore {
  createProject(p: NewProject): OwnedProject;
  getProject(id: string): OwnedProject | null;
  getProjectBySlug(slug: string): OwnedProject | null;
  /** All projects, or only those owned by `ownerId` when given. */
  listProjects(ownerId?: string): OwnedProject[];
  updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'upstream' | 'auth' | 'activeVersion'>>): OwnedProject;
  deleteProject(id: string): boolean;

  getSource(projectId: string): SourceRecord | null;
  putSource(projectId: string, source: Omit<SourceRecord, 'updatedAt'>): void;
  getDraft(projectId: string): { config: JackConfig; updatedAt: number } | null;
  putDraft(projectId: string, config: JackConfig): void;

  /** Assigns the next version number for the project. */
  createDeployment(d: NewDeployment): StoredDeployment;
  getDeployment(projectId: string, version: number): StoredDeployment | null;
  listDeployments(projectId: string): StoredDeployment[];
  /** The deployment MCP clients get right now, or null before the first promote. */
  activeDeployment(projectId: string): StoredDeployment | null;

  putSecret(projectId: string, name: string, sealed: string): void;
  getSecret(projectId: string, name: string): string | null;
  listSecrets(projectId: string): SecretInfo[];
  deleteSecret(projectId: string, name: string): boolean;

  insertCall(row: Omit<CallRow, 'id'>): void;
  listCalls(projectId: string, opts?: { limit?: number; before?: number }): CallRow[];

  close(): void;
}

export class SlugTakenError extends Error {
  override name = 'SlugTakenError';
  constructor(slug: string) {
    super(`a project with slug '${slug}' already exists`);
  }
}

export class NotFoundError extends Error {
  override name = 'NotFoundError';
}
