/**
 * The argument editor's own state (0.6.0, contract C2), kept out of the
 * component so it survives what the inspector does to it: closing the panel
 * with Escape, selecting another node, the card asking the panel to open.
 *
 *  - `drafts`        — what the user typed, per pause. A refused edit is
 *                      fixed and retried, not retyped.
 *  - `pending`       — the edit request in flight, per pause: the requestId
 *                      the app's `exec.resumed` / `exec.refused` will echo.
 *  - `editorRequest` — "open the editor in the inspector" from the keyboard
 *                      (`e`) or the card's button, consumed by the panel that
 *                      opens it so a remount never reopens it by surprise.
 *
 * Everything is keyed by pauseId and dropped with `forgetPause` when the gate
 * is released; a pauseId is never reused, so a stale entry is inert anyway.
 */
import { create } from 'zustand';
import type { PendingEdit } from '../lib/editArgs.js';

export interface EditorRequest {
  pauseId: string;
  nonce: number;
}

interface EditState {
  drafts: Record<string, string>;
  pending: Record<string, PendingEdit>;
  editorRequest: EditorRequest | undefined;
  setDraft: (pauseId: string, text: string) => void;
  setPending: (pending: PendingEdit) => void;
  clearPending: (pauseId: string) => void;
  requestEditor: (pauseId: string) => void;
  /** Drop the request once a panel has acted on it (only if it is still that request). */
  consumeEditorRequest: (nonce: number) => void;
  forgetPause: (pauseId: string) => void;
}

let nonce = 0;

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const { [key]: _dropped, ...rest } = record;
  return rest;
}

export const useEditStore = create<EditState>((set) => ({
  drafts: {},
  pending: {},
  editorRequest: undefined,
  setDraft: (pauseId, text) =>
    set((s) => (s.drafts[pauseId] === text ? s : { drafts: { ...s.drafts, [pauseId]: text } })),
  setPending: (pending) => set((s) => ({ pending: { ...s.pending, [pending.pauseId]: pending } })),
  clearPending: (pauseId) =>
    set((s) => {
      const next = without(s.pending, pauseId);
      return next === s.pending ? s : { pending: next };
    }),
  requestEditor: (pauseId) => set({ editorRequest: { pauseId, nonce: ++nonce } }),
  consumeEditorRequest: (done) =>
    set((s) => (s.editorRequest?.nonce === done ? { editorRequest: undefined } : s)),
  forgetPause: (pauseId) =>
    set((s) => {
      const drafts = without(s.drafts, pauseId);
      const pending = without(s.pending, pauseId);
      const request = s.editorRequest?.pauseId === pauseId ? undefined : s.editorRequest;
      if (drafts === s.drafts && pending === s.pending && request === s.editorRequest) return s;
      return { drafts, pending, editorRequest: request };
    }),
}));
