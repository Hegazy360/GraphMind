/** What a generator produces, and what the runner executes. */
import type { TargetMeta } from '../spec.js';

export interface GeneratedFile {
  /** Relative, `/`-separated, inside the project directory. */
  path: string;
  content: string;
}

/** One process to run in the project directory. No shell: argv as given. */
export interface Command {
  argv: string[];
  /** One line for the log and the README. */
  label: string;
}

export interface EnvKey {
  name: string;
  required: boolean;
  hint: string;
}

/** Where the GraphMind adapter comes from. */
export type AdapterSource = 'registry' | 'checkout';

export interface GeneratedProject {
  target: TargetMeta;
  /** `checkout` when the adapter is a local tarball / path (this CLI runs from the repository). */
  source: AdapterSource;
  files: GeneratedFile[];
  /** Run in order, once, before the first start (skipped when already installed). */
  install: Command[];
  start: Command;
  /** The environment variables the project reads; the viewer asks for these. */
  envKeys: EnvKey[];
}
