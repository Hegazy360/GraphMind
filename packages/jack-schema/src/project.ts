/**
 * Control-plane records: projects, deployments and how a project's users
 * sign in. Stored by jack-api; returned by its /v1 API.
 */
import { z } from 'zod';
import { manifest } from './manifest.js';

/** DNS label: becomes `<slug>.mcp.graphmind.ai` and the local path prefix. */
export const projectSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'lowercase letters, digits and dashes, 3-40 characters');

/**
 * How the project's users authenticate to the upstream API (plan §3.4 (b)).
 * The MCP-facing side (Jack as the OAuth authorization server) is the same
 * for every mode.
 */
export const authMode = z.enum(['oidc', 'link', 'apikey', 'none']);
export type AuthMode = z.infer<typeof authMode>;

export const authConfig = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('oidc'),
    issuer: z.string().url(),
    clientId: z.string().min(1),
    /** Reference to the encrypted secret, never the secret itself. */
    clientSecretRef: z.string().min(1),
    scopes: z.array(z.string().min(1)).default(['openid']),
  }),
  z.object({
    mode: z.literal('link'),
    /** The customer's "link your account" route; receives `?request=<jwt>` and must be on the upstream origin. */
    linkUrl: z.string().url(),
    /**
     * Reference to the shared secret (`env:NAME` or `secret:NAME`), never the secret.
     * The same value is `JACK_LINK_SECRET` in the customer's app: it signs Jack's
     * link requests and per-call assertions, and the app's link responses (HS256).
     */
    secretRef: z.string().min(1),
  }),
  z.object({
    mode: z.literal('apikey'),
    /** Header the key is sent in upstream (default Authorization: Bearer). */
    header: z.string().min(1).default('authorization'),
    prefix: z.string().default('Bearer '),
    /** Tool used to validate a pasted key before storing it (e.g. `get_me`). */
    whoamiTool: z.string().optional(),
  }),
  z.object({
    mode: z.literal('none'),
    /** Still require MCP sign-in (anonymous grants) for rate limiting. */
    requireSignIn: z.boolean().default(false),
  }),
]);
export type AuthConfig = z.infer<typeof authConfig>;

export const project = z.object({
  id: z.string().min(1),
  slug: projectSlug,
  name: z.string().min(1).max(128),
  /** Origin of the customer's API, e.g. https://api.acme.com — the egress allowlist. */
  upstream: z.string().url(),
  auth: authConfig,
  /** Version of the deployment MCP clients currently get, or null before the first promote. */
  activeVersion: z.number().int().min(1).nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Project = z.infer<typeof project>;

export const deployment = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  version: z.number().int().min(1),
  manifest,
  manifestHash: z.string().length(64),
  createdBy: z.string().min(1),
  createdAt: z.number().int(),
});
export type Deployment = z.infer<typeof deployment>;

/** Request bodies for the control plane. */
export const createProjectBody = z.object({
  slug: projectSlug,
  name: z.string().min(1).max(128).optional(),
  upstream: z.string().url(),
  auth: authConfig.optional(),
});
export type CreateProjectBody = z.infer<typeof createProjectBody>;

export const createDeploymentBody = z.object({
  manifest,
});
