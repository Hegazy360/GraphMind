/**
 * Trace-file importer entry point: text -> detected container -> classified
 * spans -> synthetic envelope sequence. Pure (no I/O, no clock, no random
 * ids) so tests can golden-match the exact output; the CLI command wraps it
 * with file reading, id generation, and storage insertion.
 */
import type { SdkInfo } from '@graphmind-ai/schema';
import { classifySpan } from './classify.js';
import { buildEnvelopes, type ConvertResult } from './convert.js';
import { parseFlatSpans } from './flat.js';
import { parseOtlpJson } from './otlp.js';
import { ImportError, type Dialect, type ImportedNode, type RawSpan } from './types.js';

export { ImportError } from './types.js';
export type { ImportSummary, ConvertResult } from './convert.js';

export interface ConvertTraceOptions {
  runId: string;
  /** File name recorded in run meta and used in fallback app naming. */
  fileName: string;
  sdk: SdkInfo;
  /** Overrides the derived app name when set. */
  app?: string;
}

interface DetectedSpans {
  container: 'otlp' | 'spans';
  spans: RawSpan[];
  resourceAttrs: Record<string, unknown>;
}

function detect(text: string): DetectedSpans {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (error) {
    const jsonl = tryJsonl(text);
    if (jsonl !== null) return { container: 'spans', spans: jsonl, resourceAttrs: {} };
    throw new ImportError(
      `file is not valid JSON (${error instanceof Error ? error.message : String(error)}) ` +
        'and not JSONL either — expected an OTLP/JSON trace export or an OpenInference span export',
    );
  }

  const otlp = parseOtlpJson(root);
  if (otlp !== null) {
    return { container: 'otlp', spans: otlp.spans, resourceAttrs: otlp.resourceAttrs };
  }
  const flat = parseFlatSpans(root);
  if (flat !== null) return { container: 'spans', spans: flat, resourceAttrs: {} };

  const shape = Array.isArray(root)
    ? 'a JSON array of non-object items'
    : root !== null && typeof root === 'object'
      ? `a JSON object with keys [${Object.keys(root).slice(0, 8).join(', ')}]`
      : `a JSON ${root === null ? 'null' : typeof root}`;
  throw new ImportError(
    `unrecognized trace format: the file is ${shape}; expected OTLP/JSON ` +
      '(an object with "resourceSpans") or an OpenInference span export ' +
      '(a JSON array of span objects, or an object with a "spans"/"data" array)',
  );
}

/** JSONL: every non-empty line is a JSON object -> treated as a span list. */
function tryJsonl(text: string): RawSpan[] | null {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return null;
  const items: unknown[] = [];
  for (const line of lines) {
    try {
      items.push(JSON.parse(line));
    } catch {
      return null;
    }
  }
  return parseFlatSpans(items);
}

/**
 * Convert a trace file's text into a synthetic envelope sequence.
 * Throws `ImportError` with a message naming what was unrecognized.
 */
export function convertTraceText(text: string, options: ConvertTraceOptions): ConvertResult {
  const detected = detect(text);
  if (detected.spans.length === 0) {
    throw new ImportError(
      detected.container === 'otlp'
        ? 'the OTLP file contains no spans (empty resourceSpans/scopeSpans)'
        : 'the file contains no span objects',
    );
  }

  const nodes: ImportedNode[] = [];
  const skippedReasons: string[] = [];
  for (const span of detected.spans) {
    const result = classifySpan(span);
    if (result.kind === 'node') nodes.push(result.node);
    else skippedReasons.push(result.reason);
  }

  if (nodes.length === 0) {
    const seen = [...new Set(skippedReasons)].slice(0, 10).join(', ');
    throw new ImportError(
      `no recognized AI spans in ${detected.spans.length} span(s) — saw ${seen}. ` +
        'Supported: Vercel AI SDK telemetry (ai.* / gen_ai.* attributes) and ' +
        'OpenInference (openinference.span.kind / span_kind LLM|TOOL|CHAIN|AGENT)',
    );
  }

  const dialects = [...new Set<Dialect>(nodes.map((node) => node.dialect))].sort();
  const format = `${detected.container}/${dialects.join('+')}`;

  const serviceName = detected.resourceAttrs['service.name'];
  const rootAgent = nodes.find(
    (node) => node.kind === 'agent' && node.span.parentSpanId === undefined,
  );
  const app =
    options.app ??
    (typeof serviceName === 'string' && serviceName !== '' ? serviceName : undefined) ??
    rootAgent?.name ??
    options.fileName;

  return buildEnvelopes(nodes, detected.spans, skippedReasons, {
    runId: options.runId,
    app,
    sdk: options.sdk,
    format,
    file: options.fileName,
  });
}
