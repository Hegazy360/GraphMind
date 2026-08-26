/** `graphmind demo` — replay the bundled planted-bug demo run through the real
 * ingest pipeline (interactive: honors pause/resume); `--live` runs the real
 * demo agent with the user's API key. */
import type { ParsedCli } from '../args.js';

export async function runDemo(parsed: ParsedCli): Promise<number> {
  void parsed;
  console.error('graphmind demo: not implemented yet');
  return 1;
}
