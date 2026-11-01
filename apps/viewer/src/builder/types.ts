/**
 * The builder's wire shapes, mirrored from the server
 * (packages/cli/src/builder/spec.ts and routes.ts). The server validates;
 * these types only describe what travels. Keep the two in step.
 */
export type TargetId = 'ts-ai-sdk' | 'ts-anthropic' | 'ts-openai' | 'py-openai' | 'py-anthropic';
export type Provider = 'anthropic' | 'openai' | 'google' | 'mistral' | 'xai' | 'groq' | 'deepseek' | 'openrouter' | 'ollama';
export type ParamType = 'string' | 'number' | 'boolean';
export type Language = 'typescript' | 'python';

export interface TargetMeta {
  id: TargetId;
  language: Language;
  framework: string;
  providers: Provider[];
  adapter: string;
  entry: string;
  docs: string;
  /** Which node kinds this target's generator can emit. */
  supports: { mcp: boolean; subAgents: boolean };
}

export interface ToolParam {
  name: string;
  type: ParamType;
  description?: string;
  required: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  params: ToolParam[];
  returns: string;
}

export type McpTransport = 'stdio' | 'http';

/** An MCP server the agent connects to as a client. Never holds a secret. */
export interface McpServerSpec {
  name: string;
  transport: McpTransport;
  /** stdio: the program to spawn, and its arguments. */
  command: string;
  args: string[];
  /** http: the endpoint. */
  url: string;
  /** http: the variable holding the bearer token, if the server needs one. */
  headerEnv?: string;
  /** Only these tools are exposed. Empty = everything the server lists. */
  tools: string[];
}

/** A nested agent: one tool on the parent, its own loop underneath. */
export interface SubAgentSpec {
  name: string;
  description: string;
  systemPrompt?: string;
  model?: string;
  maxSteps: number;
  tools: string[];
  mcpServers: string[];
}

/** What the ROOT agent is wired to. */
export interface AttachSpec {
  tools: string[];
  mcpServers: string[];
  subAgents: string[];
}

export interface WorkflowSpec {
  name: string;
  description?: string;
  target: TargetId;
  provider: Provider;
  model: string;
  systemPrompt?: string;
  prompt: string;
  maxSteps: number;
  tools: ToolSpec[];
  mcpServers: McpServerSpec[];
  subAgents: SubAgentSpec[];
  attach?: AttachSpec;
}

export interface SpecIssue {
  path: string;
  message: string;
}

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface EnvKey {
  name: string;
  required: boolean;
  hint: string;
}

export type AdapterSource = 'registry' | 'checkout';

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
