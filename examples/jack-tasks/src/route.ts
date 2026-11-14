/**
 * A tiny typed-route layer: each route declares its inputs and outputs with
 * Zod, and the SAME declaration does three jobs —
 *   1. validates the request at runtime (app.ts),
 *   2. types the handler,
 *   3. generates the OpenAPI document (openapi.ts) that Jack compiles.
 *
 * This is the pattern Jack recommends: the spec is derived from code, so it
 * cannot drift from what the API actually does. Frameworks like
 * @hono/zod-openapi, FastAPI and NestJS give you the same thing.
 */
import type { z } from 'zod';
import type { TasksStore, User } from './store.js';

export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    detail?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(detail ?? title);
  }
}

export interface Reply {
  status: number;
  body?: unknown;
}

export interface RouteDef<
  P extends z.ZodObject = z.ZodObject,
  Q extends z.ZodObject = z.ZodObject,
  B extends z.ZodType = z.ZodType,
> {
  method: Method;
  /** OpenAPI-style path: `/tasks/{taskId}`. */
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  deprecated?: boolean;
  params?: P;
  query?: Q;
  body?: B;
  /** Success response: status and schema (omit schema for 204). */
  response: { status: 200 | 201 | 204; description: string; schema?: z.ZodType };
  /** Error statuses this route can return, for the spec. */
  errors?: number[];
  /** OAuth scope an access token needs. Default: tasks:read for GET, tasks:write otherwise. */
  scope?: 'tasks:read' | 'tasks:write';
  handler: (ctx: {
    user: User;
    store: TasksStore;
    params: z.output<P>;
    query: z.output<Q>;
    body: z.output<B>;
  }) => Reply | Promise<Reply>;
}

/** Identity function that makes TypeScript infer the handler's argument types. */
export function route<P extends z.ZodObject, Q extends z.ZodObject, B extends z.ZodType>(def: RouteDef<P, Q, B>): RouteDef {
  return def as unknown as RouteDef;
}

export const scopeOf = (r: Pick<RouteDef, 'method' | 'scope'>): 'tasks:read' | 'tasks:write' => r.scope ?? (r.method === 'get' ? 'tasks:read' : 'tasks:write');
