/**
 * Compiler findings. Every finding has a stable code so docs, the dashboard
 * and `jack check --strict` can refer to it.
 *
 *   J001  more tools enabled than lint.maxTools
 *   J002  missing or very short description
 *   J003  description truncated to the 4,000-character limit
 *   J004  jack.yaml mentions a tool the document does not have
 *   J005  operation skipped: unsupported request content type
 *   J006  operation skipped or parameter dropped: cookie parameters
 *   J007  invisible Unicode removed from text sent to the model
 *   J008  description reads like instructions to the model (tool poisoning)
 *   J009  deprecated operation disabled by default
 *   J010  unresolvable or external $ref
 *   J011  recursive / deeply nested schema inlined as an open object  (note)
 *   J012  toolset references a disabled or unknown tool
 *   J013  write operation enabled without a reviewed description      (note)
 */
export type Severity = 'warning' | 'note';

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  tool?: string;
}

export class Diagnostics {
  readonly items: Diagnostic[] = [];
  private readonly seen = new Set<string>();

  private push(d: Diagnostic) {
    const key = `${d.code}\u0000${d.tool ?? ''}\u0000${d.message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.items.push(d);
  }

  warn(code: string, message: string, tool?: string) {
    this.push({ code, severity: 'warning', message, ...(tool !== undefined ? { tool } : {}) });
  }

  note(code: string, message: string, tool?: string) {
    this.push({ code, severity: 'note', message, ...(tool !== undefined ? { tool } : {}) });
  }
}
