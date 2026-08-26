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
export function deepLink(runId: string, nodeId?: string): string {
  const base = `${location.origin}${location.pathname}${location.search}`;
  const hash =
    nodeId === undefined
      ? `#/run/${encodeURIComponent(runId)}`
      : `#/run/${encodeURIComponent(runId)}/node/${encodeURIComponent(nodeId)}`;
  return `${base}${hash}`;
}
