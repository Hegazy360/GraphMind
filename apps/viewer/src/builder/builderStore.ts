/**
 * What the Build page remembers while you look at a run and come back: the
 * spec being edited, the project it was written to, and the job running
 * it. Deliberately NOT here: any secret. API keys live in a password
 * field's component state for the length of one request, then nowhere.
 */
import { create } from 'zustand';
import { defaultSpec } from './model.js';
import type { CreateResponse, JobInfo, JobLine, WorkflowSpec } from './types.js';

interface BuilderState {
  spec: WorkflowSpec;
  /** Path of the generated file shown in the code panel. */
  selectedFile: string | undefined;
  /** The project on disk, once Create has run for this spec. */
  created: CreateResponse | undefined;
  job: JobInfo | undefined;
  lines: JobLine[];

  setSpec: (spec: WorkflowSpec) => void;
  patchSpec: (patch: Partial<WorkflowSpec>) => void;
  selectFile: (path: string | undefined) => void;
  setCreated: (created: CreateResponse | undefined) => void;
  setJob: (job: JobInfo | undefined) => void;
  appendLines: (lines: readonly JobLine[]) => void;
  resetJob: () => void;
  reset: () => void;
}

/** Lines kept on the page; the server keeps its own, larger, buffer. */
const MAX_LINES = 1500;

export const useBuilderStore = create<BuilderState>((set) => ({
  spec: defaultSpec(),
  selectedFile: undefined,
  created: undefined,
  job: undefined,
  lines: [],

  setSpec: (spec) => set({ spec }),
  patchSpec: (patch) => set((s) => ({ spec: { ...s.spec, ...patch } })),
  selectFile: (path) => set({ selectedFile: path }),
  setCreated: (created) => set({ created }),
  setJob: (job) => set({ job }),
  appendLines: (lines) =>
    set((s) => {
      if (lines.length === 0) return s;
      const last = s.lines[s.lines.length - 1]?.i ?? -1;
      const fresh = lines.filter((line) => line.i > last);
      if (fresh.length === 0) return s;
      const next = [...s.lines, ...fresh];
      return { lines: next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next };
    }),
  resetJob: () => set({ job: undefined, lines: [] }),
  reset: () => set({ spec: defaultSpec(), selectedFile: undefined, created: undefined, job: undefined, lines: [] }),
}));
