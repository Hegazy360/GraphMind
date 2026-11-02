/**
 * What the Build page works with.
 *
 * The spec and the generator are not mirrored any more: they are imported
 * from the one place that defines them (`@workflow`, the CLI's builder
 * source, aliased in vite.config.ts), and the page runs the generator
 * itself. Only the HTTP shapes below are written out here — they mirror
 * routes.ts, which cannot be imported into a browser because it is a server.
 */
export type {
  AttachSpec,
  Language,
  McpServerSpec,
  McpTransport,
  ParamType,
  Provider,
  SpecIssue,
  SubAgentSpec,
  TargetId,
  TargetMeta,
  ToolParam,
  ToolSpec,
  WorkflowSpec,
} from '@workflow/spec.js';
export type { AdapterSource, EnvKey, GeneratedFile } from '@workflow/codegen/types.js';

import type { AdapterSource, EnvKey, GeneratedFile } from '@workflow/codegen/types.js';
import type { Provider, SpecIssue, TargetId, TargetMeta, WorkflowSpec } from '@workflow/spec.js';

export interface TargetsResponse {
  version: string;
  platform: 'posix' | 'win32';
  workflowsDir: string;
  /** `checkout`: the server runs from the repository; adapters are local tarballs. */
  source: AdapterSource;
  /** The Python the runner would use, or null when none >= 3.10 was found. */
  python: { kind: 'uv' | 'interpreter'; describe: string } | null;
  targets: TargetMeta[];
  defaultSpec: WorkflowSpec;
}

export interface PreviewResponse {
  spec: WorkflowSpec;
  target: TargetMeta;
  source: AdapterSource;
  files: GeneratedFile[];
  install: string[];
  start: string;
  envKeys: EnvKey[];
}

export interface ProjectSummary {
  dir: string;
  name: string;
  target: TargetId;
  provider: Provider;
  model: string;
  toolCount: number;
  createdAt: string | undefined;
  installed: boolean;
  envKeys: string[];
  sessionKeys?: string[];
}

export interface CreateResponse {
  dir: string;
  files: string[];
  envWritten: string[];
  /** Names of the keys held in the server's memory only. Never values. */
  sessionKeys: string[];
  install: string[];
  start: string;
  project: ProjectSummary;
}

export type JobPhase = 'installing' | 'running' | 'exited' | 'failed' | 'stopped';

export interface JobInfo {
  id: string;
  dir: string;
  name: string;
  phase: JobPhase;
  startedAt: number;
  endedAt: number | undefined;
  exitCode: number | undefined;
  total: number;
  pid: number | undefined;
}

export interface JobLine {
  i: number;
  stream: 'out' | 'err' | 'sys';
  text: string;
  ts: number;
}

export interface JobResponse {
  job: JobInfo;
  lines: JobLine[];
}

export interface ProjectsResponse {
  workflowsDir: string;
  projects: ProjectSummary[];
  jobs: JobInfo[];
}

/** One tool an MCP probe found. */
export interface ProbeTool {
  name: string;
  description: string;
}

/** What `POST /api/builder/mcp/probe` answers. */
export type ProbeResult =
  | { ok: true; server: { name: string; version: string }; tools: ProbeTool[]; ms: number }
  | { ok: false; message: string; stderr?: string; ms: number };
