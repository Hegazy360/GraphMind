/**
 * An upstream response → what the model receives.
 *
 * Models pay for every byte (context window) and act on what they read, so:
 * JSON is projected with `response.pick` when configured, pretty-printed,
 * and cut at `response.maxBytes` with an explicit note; binary content is
 * described, never inlined; errors become `isError` results carrying the
 * API's own explanation so the model can correct itself.
 */
import type { JsonValue, ToolDefinition } from '@graphmind-ai/jack-schema';
import type { UpstreamResponse } from './http.js';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, JsonValue>;
  isError?: boolean;
}

export class PickError extends Error {
  override name = 'PickError';
}

type Step = { kind: 'key'; key: string } | { kind: 'index'; index: number } | { kind: 'all' } | { kind: 'fields'; fields: string[] };

/**
 * A small, predictable JSONPath subset:
 *   $.data            key
 *   $.data[0]         index
 *   $.data[*]         every element (later steps map over them)
 *   $.data[*].{id,name}   keep only these fields
 */
export function parsePick(expr: string): Step[] {
  const s = expr.trim();
  if (!s.startsWith('$')) throw new PickError(`pick must start with $, got '${expr}'`);
  const steps: Step[] = [];
  const re = /\.([A-Za-z_$][\w$-]*)|\[(\d+)\]|\[\*\]|\.\{([^}]*)\}/y;
  re.lastIndex = 1;
  while (re.lastIndex < s.length) {
    const start = re.lastIndex;
    const m = re.exec(s);
    if (!m || m.index !== start) throw new PickError(`cannot parse pick '${expr}' at position ${start}`);
    if (m[1] !== undefined) steps.push({ kind: 'key', key: m[1] });
    else if (m[2] !== undefined) steps.push({ kind: 'index', index: Number(m[2]) });
    else if (m[3] !== undefined) {
      const fields = m[3].split(',').map((f) => f.trim()).filter(Boolean);
      if (fields.length === 0) throw new PickError(`empty field list in pick '${expr}'`);
      steps.push({ kind: 'fields', fields });
    } else steps.push({ kind: 'all' });
  }
  return steps;
}

function apply(value: JsonValue | undefined, steps: Step[]): JsonValue | undefined {
  if (steps.length === 0 || value === undefined) return value;
  const [step, ...rest] = steps as [Step, ...Step[]];
  switch (step.kind) {
    case 'key':
      return value && typeof value === 'object' && !Array.isArray(value) ? apply(value[step.key], rest) : undefined;
    case 'index':
      return Array.isArray(value) ? apply(value[step.index], rest) : undefined;
    case 'all':
      return Array.isArray(value) ? value.map((v) => apply(v, rest) ?? null) : undefined;
    case 'fields': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const out: Record<string, JsonValue> = {};
      for (const f of step.fields) if (value[f] !== undefined) out[f] = value[f];
      return apply(out, rest);
    }
  }
}

export const pick = (value: JsonValue, expr: string): JsonValue | undefined => apply(value, parsePick(expr));

const text = (t: string): ToolResult['content'][number] => ({ type: 'text', text: t });

/** Cut text to `max` bytes of UTF-8 without splitting a character, with a note the model can act on. */
export function truncate(t: string, max: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(t, 'utf8');
  if (bytes.length <= max) return { text: t, truncated: false };
  let cut = bytes.subarray(0, max).toString('utf8');
  if (cut.endsWith('�')) cut = cut.slice(0, -1);
  return {
    text: `${cut}\n\n[Truncated by Jack: the response was ${bytes.length} bytes and this tool returns at most ${max}. Narrow the request (filters, a shorter period, a smaller page size) to see the rest.]`,
    truncated: true,
  };
}

const isJsonType = (ct: string) => /^application\/(?:[\w.+-]*\+)?json\b/i.test(ct) || /^application\/problem\+json/i.test(ct);
const isTextType = (ct: string) => /^text\//i.test(ct) || /^application\/(?:xml|x-www-form-urlencoded|javascript)\b/i.test(ct);

const ERROR_BODY_MAX = 2_000;

export function shapeResponse(tool: ToolDefinition, res: UpstreamResponse): ToolResult {
  const ct = String(res.headers['content-type'] ?? '');
  const raw = res.body.toString('utf8');

  if (res.status >= 300 && res.status < 400) {
    return {
      isError: true,
      content: [text(`The API answered with a redirect (HTTP ${res.status}). Jack does not follow redirects; the tool's path or the project's upstream URL may be out of date.`)],
    };
  }

  if (res.status >= 400) {
    const detail = raw.trim() === '' ? '' : `\n\n${truncate(raw.trim(), ERROR_BODY_MAX).text}`;
    let hint = '';
    if (res.status === 401 || res.status === 403) {
      hint = '\n\nThe API refused the credentials Jack sent for this user. They may need to reconnect, or lack permission for this action.';
    } else if (res.status === 404) {
      hint = '\n\nCheck the identifiers passed to the tool; list the resources first if unsure.';
    } else if (res.status === 429) {
      hint = '\n\nThe API is rate limiting. Wait before retrying.';
    }
    return { isError: true, content: [text(`The API returned HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.${hint}${detail}`)] };
  }

  if (res.body.length === 0) return { content: [text(`Done (HTTP ${res.status}, no content).`)] };

  const max = tool.response.maxBytes;
  if (isJsonType(ct) || (ct === '' && /^[\s]*[[{]/.test(raw))) {
    let value: JsonValue;
    try {
      value = JSON.parse(raw) as JsonValue;
    } catch {
      return { content: [text(truncate(raw, max).text)] };
    }
    if (tool.response.pick !== undefined) {
      const picked = pick(value, tool.response.pick);
      if (picked !== undefined) value = picked;
    }
    const shaped = truncate(JSON.stringify(value, null, 2), max);
    const structured = !shaped.truncated && value !== null && typeof value === 'object' && !Array.isArray(value);
    return {
      content: [text(shaped.text)],
      ...(structured ? { structuredContent: value as Record<string, JsonValue> } : {}),
    };
  }
  if (isTextType(ct) || ct === '') return { content: [text(truncate(raw, max).text)] };
  return {
    content: [text(`The API returned ${res.body.length} bytes of ${ct.split(';')[0]}. Binary content is not passed to the model.`)],
  };
}
