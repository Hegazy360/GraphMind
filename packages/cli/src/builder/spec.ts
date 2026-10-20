/**
 * The workflow builder's input: what an engineer describes in the viewer's
 * Build page, validated once here and then turned into a runnable project
 * (codegen/) in the language and framework they picked.
 *
 * Deliberately small. A spec is one agent: a model, a system prompt, a task
 * prompt, and a list of tools with typed parameters. Each tool starts as a
 * stub that returns a fixed value, so the generated project runs end to end
 * on the first try and the engineer replaces the stubs with real code in
 * their editor. GraphMind never owns that code afterwards: the project is
 * plain files in a plain directory, instrumented with the public adapters.
 *
 * Nothing in a spec is a secret. API keys travel separately (routes.ts ->
 * env-file.ts) and are never part of the spec file written next to the code.
 */
import { z } from 'zod';

export const TARGET_IDS = ['ts-ai-sdk', 'ts-anthropic', 'ts-openai', 'py-openai', 'py-anthropic'] as const;
export type TargetId = (typeof TARGET_IDS)[number];

export const PROVIDERS = ['anthropic', 'openai'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PARAM_TYPES = ['string', 'number', 'boolean'] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

export type Language = 'typescript' | 'python';

export interface TargetMeta {
  id: TargetId;
  language: Language;
  /** Shown in the picker: the framework the generated code uses. */
  framework: string;
  /** Which providers the target can call. */
  providers: readonly Provider[];
  /** The GraphMind package the generated code imports. */
  adapter: string;
  /** The file to open first. */
  entry: string;
  docs: string;
}

export const TARGETS: Record<TargetId, TargetMeta> = {
  'ts-ai-sdk': {
    id: 'ts-ai-sdk',
    language: 'typescript',
    framework: 'Vercel AI SDK',
    providers: ['anthropic', 'openai'],
    adapter: '@graphmind-ai/sdk',
    entry: 'src/main.ts',
    docs: 'https://graphmind.ai/docs/integrations/vercel-ai-sdk/',
  },
  'ts-anthropic': {
    id: 'ts-anthropic',
    language: 'typescript',
    framework: 'Anthropic SDK',
    providers: ['anthropic'],
    adapter: '@graphmind-ai/anthropic',
    entry: 'src/main.ts',
    docs: 'https://graphmind.ai/docs/integrations/anthropic/',
  },
  'ts-openai': {
    id: 'ts-openai',
    language: 'typescript',
    framework: 'OpenAI SDK',
    providers: ['openai'],
    adapter: '@graphmind-ai/openai',
    entry: 'src/main.ts',
    docs: 'https://graphmind.ai/docs/integrations/openai/',
  },
  'py-openai': {
    id: 'py-openai',
    language: 'python',
    framework: 'OpenAI SDK',
    providers: ['openai'],
    adapter: 'graphmind-ai',
    entry: 'main.py',
    docs: 'https://graphmind.ai/docs/integrations/python/',
  },
  'py-anthropic': {
    id: 'py-anthropic',
    language: 'python',
    framework: 'Anthropic SDK',
    providers: ['anthropic'],
    adapter: 'graphmind-ai',
    entry: 'main.py',
    docs: 'https://graphmind.ai/docs/integrations/python/',
  },
};

/** The environment variable each provider's SDK reads its key from. */
export const PROVIDER_ENV_KEY: Record<Provider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

export const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-5.1',
};

/**
 * Identifiers must be valid in BOTH languages the builder emits, so one spec
 * can switch target without renaming anything: letters, digits and
 * underscores, not starting with a digit, and not a keyword of either.
 */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;

const RESERVED_WORDS: ReadonlySet<string> = new Set([
  // JavaScript / TypeScript
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function',
  'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null',
  'package', 'private', 'protected', 'public', 'return', 'static', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'arguments',
  'eval', 'undefined', 'any', 'string', 'number', 'boolean', 'type', 'of',
  // Python
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'def', 'del', 'elif', 'except',
  'from', 'global', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  // names the generated files use themselves
  'tools', 'input', 'json', 'os', 'gm', 'client', 'messages', 'model', 'main',
]);

export function isIdentifier(value: string): boolean {
  return IDENTIFIER_RE.test(value) && !RESERVED_WORDS.has(value);
}

const identifier = (what: string) =>
  z
    .string()
    .refine((value) => IDENTIFIER_RE.test(value), {
      message: `${what} must be a plain identifier (letters, digits, underscores; not starting with a digit; at most 48 characters)`,
    })
    .refine((value) => !RESERVED_WORDS.has(value), {
      message: `${what} is a reserved word in TypeScript or Python`,
    });

/** The project name: a directory name and the `app` label on every run. */
export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

export const ParamSchema = z.object({
  name: identifier('a parameter name'),
  type: z.enum(PARAM_TYPES),
  description: z.string().max(300).optional(),
  required: z.boolean().default(true),
});
export type ToolParam = z.infer<typeof ParamSchema>;

export const ToolSchema = z
  .object({
    name: identifier('a tool name'),
    description: z.string().trim().min(1, 'a tool needs a description: it is what the model reads').max(500),
    params: z.array(ParamSchema).max(12).default([]),
    /**
     * What the stub returns. JSON text becomes a literal of the matching
     * language; anything else becomes a string. The engineer replaces it.
     */
    returns: z.string().max(4000).default('{ "ok": true }'),
  })
  .superRefine((tool, ctx) => {
    const seen = new Set<string>();
    tool.params.forEach((param, index) => {
      if (seen.has(param.name)) {
        ctx.addIssue({ code: 'custom', path: ['params', index, 'name'], message: `duplicate parameter "${param.name}"` });
      }
      seen.add(param.name);
    });
  });
export type ToolSpec = z.infer<typeof ToolSchema>;

export const WorkflowSpecSchema = z
  .object({
    name: z
      .string()
      .regex(PROJECT_NAME_RE, 'use lowercase letters, digits and dashes (e.g. "support-agent"), at most 48 characters'),
    description: z.string().max(500).optional(),
    target: z.enum(TARGET_IDS),
    provider: z.enum(PROVIDERS),
    model: z
      .string()
      .trim()
      .min(1, 'pick a model')
      .max(100)
      .regex(/^[A-Za-z0-9._:/-]+$/, 'a model id is letters, digits and . _ : / -'),
    systemPrompt: z.string().max(20_000).optional(),
    prompt: z.string().trim().min(1, 'the agent needs a task').max(20_000),
    maxSteps: z.number().int().min(1).max(50).default(8),
    tools: z.array(ToolSchema).max(20).default([]),
  })
  .superRefine((spec, ctx) => {
    const target = TARGETS[spec.target];
    if (!target.providers.includes(spec.provider)) {
      ctx.addIssue({
        code: 'custom',
        path: ['provider'],
        message: `${target.framework} (${target.language}) cannot call ${spec.provider}; pick ${target.providers.join(' or ')}`,
      });
    }
    const seen = new Set<string>();
    spec.tools.forEach((tool, index) => {
      if (seen.has(tool.name)) {
        ctx.addIssue({ code: 'custom', path: ['tools', index, 'name'], message: `duplicate tool "${tool.name}"` });
      }
      seen.add(tool.name);
    });
  });

export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>;
/** What a caller sends: defaults not yet applied. */
export type WorkflowSpecInput = z.input<typeof WorkflowSpecSchema>;

export interface SpecIssue {
  /** Dotted path into the spec (`tools.1.name`); empty for the whole spec. */
  path: string;
  message: string;
}

export type ParseSpecResult = { ok: true; spec: WorkflowSpec } | { ok: false; issues: SpecIssue[] };

/** Validate an untrusted spec. Never throws. */
export function parseSpec(input: unknown): ParseSpecResult {
  const result = WorkflowSpecSchema.safeParse(input);
  if (result.success) return { ok: true, spec: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  };
}

/**
 * The spec the Build page opens with: a small, runnable agent with two stub
 * tools, so "Create" and "Run" work before anything is typed.
 */
export function defaultSpec(target: TargetId = 'ts-ai-sdk'): WorkflowSpec {
  const meta = TARGETS[target];
  const provider = meta.providers[0] as Provider;
  return {
    name: 'my-agent',
    description: 'A starter agent with two stub tools. Replace the stubs with real code.',
    target,
    provider,
    model: DEFAULT_MODEL[provider],
    systemPrompt: 'You are a concise assistant. Use the tools when they help, then answer in two sentences.',
    prompt: 'What is the weather like in Lisbon this weekend, and should I pack a jacket?',
    maxSteps: 6,
    tools: [
      {
        name: 'getWeather',
        description: 'Typical weather for a city on a given day.',
        params: [
          { name: 'city', type: 'string', description: 'City name', required: true },
          { name: 'day', type: 'string', description: 'ISO date or a word like "saturday"', required: true },
        ],
        returns: '{ "highC": 19, "lowC": 12, "summary": "sunny, breezy in the evening" }',
      },
      {
        name: 'packingAdvice',
        description: 'Whether to pack a jacket for a temperature range.',
        params: [
          { name: 'lowC', type: 'number', description: 'Lowest expected temperature', required: true },
        ],
        returns: '{ "jacket": true, "reason": "evenings drop below 15C" }',
      },
    ],
  };
}
