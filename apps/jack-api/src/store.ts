/**
 * JackStore — the control plane's persistence contract. One interface, two
 * backends (as Circuit): `SqliteStore` on `node:sqlite` for dev, tests and
 * single-node self-hosting; `PgJackStore` (./pg-store.ts) for the hosted
 * service. Every method is async because the hosted backend is a network
 * database; SQLite resolves immediately.
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
  createProject(p: NewProject): Promise<OwnedProject>;
  getProject(id: string): Promise<OwnedProject | null>;
  getProjectBySlug(slug: string): Promise<OwnedProject | null>;
  /** All projects, or only those owned by `ownerId` when given. */
  listProjects(ownerId?: string): Promise<OwnedProject[]>;
  updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'upstream' | 'auth' | 'activeVersion'>>): Promise<OwnedProject>;
  deleteProject(id: string): Promise<boolean>;

  getSource(projectId: string): Promise<SourceRecord | null>;
  putSource(projectId: string, source: Omit<SourceRecord, 'updatedAt'>): Promise<void>;
  getDraft(projectId: string): Promise<{ config: JackConfig; updatedAt: number } | null>;
  putDraft(projectId: string, config: JackConfig): Promise<void>;

  /** Assigns the next version number for the project. */
  createDeployment(d: NewDeployment): Promise<StoredDeployment>;
  getDeployment(projectId: string, version: number): Promise<StoredDeployment | null>;
  listDeployments(projectId: string): Promise<StoredDeployment[]>;
  /** The deployment MCP clients get right now, or null before the first promote. */
  activeDeployment(projectId: string): Promise<StoredDeployment | null>;

  putSecret(projectId: string, name: string, sealed: string): Promise<void>;
  getSecret(projectId: string, name: string): Promise<string | null>;
  listSecrets(projectId: string): Promise<SecretInfo[]>;
  deleteSecret(projectId: string, name: string): Promise<boolean>;

  insertCall(row: Omit<CallRow, 'id'>): Promise<void>;
  listCalls(projectId: string, opts?: { limit?: number; before?: number }): Promise<CallRow[]>;

  close(): Promise<void>;
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
