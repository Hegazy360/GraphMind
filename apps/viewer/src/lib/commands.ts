/**
 * A tiny registry so the command palette can drive the canvas (fit,
 * auto-arrange, centre a node) without either component importing the other
 * or the app threading callbacks through five layers. The canvas registers
 * on mount and unregisters on unmount; every call is a no-op when nothing is
 * mounted, which is exactly what a command palette wants.
 */
export interface CanvasActions {
  fitView: () => void;
  arrange: () => void;
  focusNode: (nodeId: string) => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

let current: CanvasActions | undefined;

export function registerCanvasActions(actions: CanvasActions): () => void {
  current = actions;
  return () => {
    if (current === actions) current = undefined;
  };
}

export function canvasActions(): CanvasActions | undefined {
  return current;
}

/** Copy text, resolving false rather than throwing when the API is blocked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The shareable deep link for a run/node selection. */
/**
 * The `graphmind replay --substitute` command for one recorded call: "what
 * would this run have done if THIS call had returned something else?".
 *
 * The viewer composes the command and copies it; it never runs it. Running
 * an arbitrary shell command on behalf of a web page would need a
 * command-execution endpoint on the local server, which is a far bigger
 * security boundary than a debugger should move for a convenience — and the
 * terminal that started GraphMind is right there.
 *
 * The value is pre-filled with what the call actually returned, so the edit
 * is a diff against reality rather than a blank page.
 */
export function counterfactualCommand(
  runId: string,
  nodeId: string,
  ordinal: number,
  recordedOutput: unknown,
  command = '<your agent command>',
): string {
  let value: string;
  try {
    value = JSON.stringify(recordedOutput ?? null) ?? 'null';
  } catch {
    value = 'null';
  }
  // Wrap in single quotes for the shell. A single quote inside the JSON
  // cannot be escaped within single quotes, so POSIX requires closing,
  // emitting an escaped quote, and reopening: ' -> '\''. Written as a plain
  // string (not a template literal, where \' would just mean ').
  const SHELL_QUOTE_ESCAPE = "'\\''";
  const quoted = `'${value.split("'").join(SHELL_QUOTE_ESCAPE)}'`;
  const target = ordinal === 0 ? nodeId : `${nodeId}#${ordinal}`;
  return `graphmind replay ${runId} --substitute ${target}=${quoted} -- ${command}`;
}

export function deepLink(runId: string, nodeId?: string): string {
  const base = `${location.origin}${location.pathname}${location.search}`;
  const hash =
    nodeId === undefined
      ? `#/run/${encodeURIComponent(runId)}`
      : `#/run/${encodeURIComponent(runId)}/node/${encodeURIComponent(nodeId)}`;
  return `${base}${hash}`;
}
