/**
 * The Build page's calls to `/api/builder/*`. No route requires a credential
 * (routes.ts explains why); a viewer token is still sent when this tab has
 * one, which is what a server started with GRAPHMIND_BUILDER_REQUIRE_TOKEN=1
 * asks for. Secrets go out exactly once, in `createProject` / `writeEnv`,
 * and are never read back: the server only ever answers with names.
 */
import { authHeaders } from '../connection/auth.js';
import { resolveHttpBase } from '../connection/ServerConnection.js';
import type {
  CreateResponse,
  McpServerSpec,
  ProbeResult,
  JobInfo,
  JobResponse,
  PreviewResponse,
  ProjectsResponse,
  SpecIssue,
  TargetsResponse,
  WorkflowSpec,
} from './types.js';

export class BuilderApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: SpecIssue[] = [],
  ) {
    super(message);
    this.name = 'BuilderApiError';
  }

  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

function base(): string {
  return resolveHttpBase(typeof location === 'undefined' ? '' : location.search);
}

async function call<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const url = `${base()}${path}`;
  const headers: Record<string, string> = { ...authHeaders(url) };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new BuilderApiError(0, 'unreachable', 'the debugger server is not reachable');
  }
  if (!response.ok) {
    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      // not JSON: fall through to a status-only error
    }
    const code = typeof body['error'] === 'string' ? body['error'] : `http-${response.status}`;
    const message = typeof body['message'] === 'string' ? body['message'] : `HTTP ${response.status}`;
    const issues = Array.isArray(body['issues']) ? (body['issues'] as SpecIssue[]) : [];
    throw new BuilderApiError(response.status, code, message, issues);
  }
  return (await response.json()) as T;
}

export function fetchTargets(): Promise<TargetsResponse> {
  return call<TargetsResponse>('/api/builder/targets');
}

export function previewProject(spec: WorkflowSpec, signal?: AbortSignal): Promise<PreviewResponse> {
  return call<PreviewResponse>('/api/builder/preview', { body: { spec }, ...(signal === undefined ? {} : { signal }) });
}

export function listProjects(): Promise<ProjectsResponse> {
  return call<ProjectsResponse>('/api/builder/projects');
}

export function createProject(input: {
  spec: WorkflowSpec;
  dir?: string;
  secrets?: Record<string, string>;
  /** false = hold the keys in the server's memory instead of writing .env. */
  persistSecrets?: boolean;
  overwrite?: boolean;
}): Promise<CreateResponse> {
  return call<CreateResponse>('/api/builder/projects', { body: input });
}

export interface EnvResponse {
  dir: string;
  written: string[];
  removed: string[];
  /** Names set in .env. */
  keys: string[];
  /** Names held in the server's memory only. */
  sessionKeys: string[];
}

/**
 * Send keys once. `persist: false` is the no-trace path: the server holds
 * them in memory for the run and writes nothing. Either way the response is
 * names only — a value sent from here can never be read back.
 */
export function writeEnv(dir: string, secrets: Record<string, string>, persist: boolean): Promise<EnvResponse> {
  return call<EnvResponse>('/api/builder/projects/env', { body: { dir, secrets, persist } });
}

/** Drop the session-only keys for a project, now. */
export function forgetEnv(dir: string): Promise<{ dir: string; forgotten: string[]; sessionKeys: string[] }> {
  return call('/api/builder/projects/env/forget', { body: { dir } });
}

/**
 * Test an MCP node: the server connects the way the generated project will
 * and lists the tools. A bearer token for an HTTP server is sent once, for
 * this connection only, and is never stored on either side.
 */
export function probeMcp(server: McpServerSpec, bearer?: string): Promise<ProbeResult> {
  return call<ProbeResult>('/api/builder/mcp/probe', {
    body: { server, ...(bearer === undefined || bearer === '' ? {} : { bearer }) },
  });
}

export function startJob(dir: string): Promise<{ job: JobInfo }> {
  return call<{ job: JobInfo }>('/api/builder/jobs', { body: { dir } });
}

export function pollJob(id: string, after: number): Promise<JobResponse> {
  return call<JobResponse>(`/api/builder/jobs/${encodeURIComponent(id)}?after=${after}`);
}

export function stopJob(id: string): Promise<{ ok: boolean; job: JobInfo }> {
  return call<{ ok: boolean; job: JobInfo }>(`/api/builder/jobs/${encodeURIComponent(id)}/stop`, { method: 'POST', body: {} });
}
