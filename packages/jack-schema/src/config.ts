/**
 * jack.yaml — the reviewed, in-git curation of a project's tools (plan §3.1).
 *
 * The OpenAPI document says what the API CAN do; jack.yaml says what AI
 * clients MAY do with it and how it is described to them. `jack-openapi`
 * compiles (document + jack.yaml) → Manifest.
 *
 * Defaults are deliberately conservative: a tool not mentioned here is
 * enabled only if it is read-only (GET/HEAD) and not deprecated, so an
 * operation that writes is never published because someone added it to the
 * spec — someone has to enable it here.
 */
import { z } from 'zod';
import { authConfig } from './project.js';
import { responseShaping, toolAnnotations, toolName } from './manifest.js';

export const toolOverride = z.object({
  enabled: z.boolean().optional(),
  /** Publish under a different tool name. */
  name: toolName.optional(),
  /** Replaces the spec's summary + description, which are written for humans. */
  description: z.string().min(1).max(4_000).optional(),
  /** Merged over the inferred annotations (GET → readOnly, DELETE → destructive…). */
  annotations: toolAnnotations.optional(),
  /** Replaces the scopes inferred from the operation's `security` requirement. */
  requiredScopes: z.array(z.string().min(1)).optional(),
  confirm: z.boolean().optional(),
  response: responseShaping.partial().optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
});
export type ToolOverride = z.infer<typeof toolOverride>;

export const jackConfig = z.object({
  /** Server name shown to MCP clients. Default: the spec's `info.title`. */
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(2_000).optional(),
  /** OpenAPI document: a path relative to jack.yaml, or an http(s) URL. */
  source: z.string().min(1),
  /**
   * Base URL of the API (origin + optional path prefix), e.g.
   * https://api.acme.com/v2. Default: the spec's first server.
   */
  upstream: z.string().url().optional(),
  auth: authConfig.optional(),
  /** Keyed by the tool name `jack init` generated (or the operation's own name). */
  tools: z.record(z.string(), toolOverride.nullable()).default({}),
  toolsets: z
    .record(
      z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
      z.object({ description: z.string().max(1_000).optional(), tools: z.array(z.string()).min(1) }),
    )
    .default({}),
  lint: z.object({ maxTools: z.number().int().min(1).max(500).default(30) }).prefault({}),
});
export type JackConfig = z.infer<typeof jackConfig>;
