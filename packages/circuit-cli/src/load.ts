/**
 * Load workflow definitions from a user module. Any export (named, default,
 * or an array) that looks like a WorkflowDefinition counts. TypeScript
 * sources import directly on Node >= 23.6 via native type stripping; on
 * older Nodes we say so instead of failing cryptically.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { AnyWorkflow } from '@graphmind-ai/circuit-sdk';

export function isWorkflowDefinition(value: unknown): value is AnyWorkflow {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { config?: { name?: unknown }; fn?: unknown };
  return typeof candidate.fn === 'function' && typeof candidate.config?.name === 'string';
}

export async function loadWorkflows(modulePath: string, opts: { bust?: boolean } = {}): Promise<AnyWorkflow[]> {
  // ESM caches by URL; a changing query string is the supported way to
  // re-import a changed file (dev reload). Old module instances are retained
  // until process exit — acceptable for a dev server.
  const bust = opts.bust === true ? `?t=${Date.now()}` : '';
  const url = pathToFileURL(resolve(modulePath)).href + bust;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(url)) as Record<string, unknown>;
  } catch (err) {
    if (modulePath.endsWith('.ts') && err instanceof SyntaxError) {
      throw new Error(
        `Could not import ${modulePath} as TypeScript — this Node (${process.version}) may lack native type stripping. Use Node >= 23.6, or point --workflows at compiled JS.`,
      );
    }
    throw err;
  }
  const found = new Map<string, AnyWorkflow>();
  const visit = (value: unknown): void => {
    if (isWorkflowDefinition(value)) {
      found.set(value.config.name, value);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    }
  };
  for (const value of Object.values(mod)) visit(value);
  if (found.size === 0) {
    throw new Error(`${modulePath} exports no workflows — export the result of workflow({...}, fn).`);
  }
  return [...found.values()];
}
