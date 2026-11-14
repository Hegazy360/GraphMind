/**
 * OpenAPI 3.1 document generated from the route table — the input to
 * `jack init` / `jack check`. Run `pnpm spec` to refresh openapi.json; a
 * test fails if the committed file drifts from the code.
 */
import { z } from 'zod';
import { SCOPES } from './idp.js';
import { scopeOf, type RouteDef } from './route.js';

export const DEFAULT_ORIGIN = 'http://127.0.0.1:4830';

type Json = Record<string, unknown>;

function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): Json {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io, target: 'draft-2020-12', unrepresentable: 'any' }) as Json;
  return rest;
}

const PROBLEM: Json = {
  type: 'object',
  description: 'RFC 9457 problem details',
  properties: { type: { type: 'string' }, title: { type: 'string' }, status: { type: 'integer' }, detail: { type: 'string' } },
  required: ['title', 'status'],
};

const ERROR_TEXT: Record<number, string> = {
  400: 'The request was invalid',
  401: 'Missing or invalid API key / access token',
  403: 'The access token lacks the scope this operation needs',
  404: 'Not found (or not yours)',
  409: 'Conflicts with existing data',
};

export function buildOpenApi(routes: RouteDef[], origin = DEFAULT_ORIGIN): Json {
  const paths: Record<string, Json> = {};
  for (const r of routes) {
    const parameters: Json[] = [];
    const add = (obj: z.ZodObject | undefined, where: 'path' | 'query') => {
      if (!obj) return;
      const s = jsonSchema(obj, 'input');
      const required = new Set((s.required as string[] | undefined) ?? []);
      for (const [name, prop] of Object.entries((s.properties ?? {}) as Record<string, Json>)) {
        const { description, ...schema } = prop;
        parameters.push({
          name,
          in: where,
          required: where === 'path' || required.has(name),
          ...(description !== undefined ? { description } : {}),
          schema,
        });
      }
    };
    add(r.params, 'path');
    add(r.query, 'query');

    const responses: Json = {
      [String(r.response.status)]: {
        description: r.response.description,
        ...(r.response.schema ? { content: { 'application/json': { schema: jsonSchema(r.response.schema, 'output') } } } : {}),
      },
    };
    for (const code of [401, 403, ...(r.errors ?? [])]) {
      responses[String(code)] = { description: ERROR_TEXT[code] ?? 'Error', content: { 'application/problem+json': { schema: PROBLEM } } };
    }

    (paths[r.path] ??= {})[r.method] = {
      operationId: r.operationId,
      summary: r.summary,
      ...(r.description ? { description: r.description } : {}),
      tags: r.tags,
      ...(r.deprecated ? { deprecated: true } : {}),
      // OAuth first: it is the alternative that carries scopes (Jack reads the first one).
      security: [{ acme_oauth: [scopeOf(r)] }, { bearerAuth: [] }],
      ...(parameters.length ? { parameters } : {}),
      ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(r.body, 'input') } } } } : {}),
      responses,
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Acme Tasks API',
      version: '1.0.0',
      description: 'Projects, tasks and comments for one signed-in user. Authenticate with a personal API key or an OAuth access token from Acme\'s sign-in (Authorization: Bearer).',
    },
    servers: [{ url: origin }],
    tags: [
      { name: 'account' },
      { name: 'projects' },
      { name: 'tasks' },
      { name: 'comments' },
      { name: 'reports' },
    ],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Personal API key, e.g. tk_demo_alice' },
        acme_oauth: {
          type: 'oauth2',
          description: 'Acme sign-in (OpenID Connect discovery at /.well-known/openid-configuration)',
          flows: {
            authorizationCode: { authorizationUrl: `${origin}/oauth/authorize`, tokenUrl: `${origin}/oauth/token`, scopes: SCOPES },
          },
        },
      },
    },
  };
}
