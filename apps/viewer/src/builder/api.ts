/**
 * The Build page's calls to `/api/builder/*`. Every call carries the viewer
 * token (`authHeaders`) because every builder route requires it, GET
 * included. Secrets go out exactly once, in `createProject` / `writeEnv`,
 * and are never read back: the server only ever answers with names.
 */
import { authHeaders } from '../connection/auth.js';
import { resolveHttpBase } from '../connection/ServerConnection.js';
import type {
  CreateResponse,
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
  overwrite?: boolean;
}): Promise<CreateResponse> {
  return call<CreateResponse>('/api/builder/projects', { body: input });
}

export function writeEnv(dir: string, secrets: Record<string, string>): Promise<{ dir: string; written: string[]; removed: string[]; keys: string[] }> {
  return call('/api/builder/projects/env', { body: { dir, secrets } });
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
