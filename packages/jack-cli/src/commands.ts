/**
 * `jack init | check | build` — the M1 authoring loop:
 *
 *   jack init  <openapi file|url>   write a reviewed-by-default jack.yaml
 *   jack check                      compile it; print every tool and every finding
 *   jack build                      write the manifest a deployment is made of
 *
 * Each command returns an exit code and writes through `io`, so tests drive
 * them without spawning processes.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { manifestHash } from '@graphmind-ai/jack-schema';
import {
  compileProject,
  generateConfig,
  isUrl,
  loadSource,
  type CompileResult,
  type Diagnostic,
} from '@graphmind-ai/jack-openapi';

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  fetchImpl?: typeof fetch;
  today?: string;
}

export const DEFAULT_CONFIG = 'jack.yaml';
export const DEFAULT_MANIFEST = 'jack.manifest.json';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function printDiagnostics(io: Io, diagnostics: Diagnostic[]): void {
  if (diagnostics.length === 0) return;
  io.out('');
  for (const d of diagnostics) {
    const mark = d.severity === 'warning' ? 'warning' : 'note   ';
    io.out(`  ${mark} ${d.code}${d.tool ? ` ${d.tool}` : ''}: ${d.message}`);
  }
}

const warnings = (r: CompileResult) => r.diagnostics.filter((d) => d.severity === 'warning').length;

export async function initCommand(
  sourceArg: string | undefined,
  opts: { out?: string; upstream?: string; force?: boolean },
  io: Io,
): Promise<number> {
  if (sourceArg === undefined) {
    io.err('jack init needs an OpenAPI document: a file path or an http(s) URL');
    return 1;
  }
  const outPath = resolve(opts.out ?? DEFAULT_CONFIG);
  if (existsSync(outPath) && !opts.force) {
    io.err(`${relative(process.cwd(), outPath) || outPath} already exists — pass --force to overwrite it`);
    return 1;
  }
  const loaded = await loadSource(sourceArg, io.fetchImpl ? { fetchImpl: io.fetchImpl } : {});
  // `source:` is written relative to jack.yaml, so the pair can move together in a repo.
  let source = sourceArg;
  if (!isUrl(sourceArg)) {
    const rel = relative(dirname(outPath), resolve(sourceArg));
    source = rel.startsWith('..') || rel.startsWith(sep) ? rel : `./${rel}`;
  }
  const { yaml, result, upstream } = generateConfig(loaded.document, {
    source,
    ...(loaded.documentUrl ? { documentUrl: loaded.documentUrl } : {}),
    ...(opts.upstream ? { upstream: opts.upstream } : {}),
    ...(io.today ? { today: io.today } : {}),
  });
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, yaml);

  const enabled = result.tools.filter((t) => t.enabled);
  const writes = result.tools.filter((t) => !t.enabled && t.kind !== 'read').length;
  const skipped = result.diagnostics.filter((d) => d.code === 'J005' || (d.code === 'J006' && d.message.includes('skipped'))).length;
  io.out(`jack init — ${result.manifest.name} (${result.dialect})`);
  io.out(`  upstream:   ${upstream}`);
  io.out(`  operations: ${result.tools.length} usable${skipped ? `, ${skipped} skipped` : ''}`);
  io.out(`  enabled:    ${plural(enabled.length, 'read tool')}`);
  io.out(`  disabled:   ${plural(writes, 'write operation')} (enable deliberately in jack.yaml)`);
  printDiagnostics(io, result.diagnostics);
  io.out('');
  io.out(`wrote ${relative(process.cwd(), outPath) || outPath}`);
  io.out('next: review it, then `jack check`');
  return 0;
}

export async function checkCommand(opts: { config?: string; strict?: boolean }, io: Io): Promise<number> {
  const configPath = resolve(opts.config ?? DEFAULT_CONFIG);
  const r = await compileProject(configPath, io.fetchImpl ? { fetchImpl: io.fetchImpl } : {});
  io.out(`jack check — ${r.manifest.name} (${r.dialect}) → ${r.baseUrl}`);
  io.out('');
  const width = Math.max(...r.tools.map((t) => t.name.length), 4);
  for (const t of r.tools) {
    const mark = t.enabled ? '✓' : '·';
    const kind = t.kind === 'read' ? '' : t.kind === 'destructive' ? '  DESTRUCTIVE' : '  writes';
    const renamed = t.name !== t.key ? `  (from ${t.key})` : '';
    io.out(`  ${mark} ${t.name.padEnd(width)}  ${t.method.padEnd(6)} ${t.path}${kind}${renamed}`);
  }
  printDiagnostics(io, r.diagnostics);
  io.out('');
  const w = warnings(r);
  io.out(
    `${plural(r.manifest.tools.length, 'tool')} enabled of ${r.tools.length}` +
      `${r.manifest.toolsets.length ? `, ${plural(r.manifest.toolsets.length, 'toolset')}` : ''}` +
      `, ${plural(w, 'warning')}`,
  );
  if (opts.strict && w > 0) {
    io.err(`--strict: ${plural(w, 'warning')} must be resolved`);
    return 1;
  }
  return 0;
}

export async function buildCommand(opts: { config?: string; out?: string }, io: Io): Promise<number> {
  const configPath = resolve(opts.config ?? DEFAULT_CONFIG);
  const r = await compileProject(configPath, io.fetchImpl ? { fetchImpl: io.fetchImpl } : {});
  const outPath = resolve(opts.out ?? resolve(dirname(configPath), DEFAULT_MANIFEST));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(r.manifest, null, 2)}\n`);
  io.out(`jack build — ${plural(r.manifest.tools.length, 'tool')}, manifest ${manifestHash(r.manifest).slice(0, 12)}`);
  if (warnings(r) > 0) io.out(`  ${plural(warnings(r), 'warning')} — run \`jack check\` to see them`);
  io.out(`wrote ${relative(process.cwd(), outPath) || outPath}`);
  return 0;
}
