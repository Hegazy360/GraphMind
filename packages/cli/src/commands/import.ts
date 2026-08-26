/** `graphmind import <file>` — load an OTel/OpenInference trace as a run. */
import type { ParsedCli } from '../args.js';

export async function runImport(parsed: ParsedCli): Promise<number> {
  void parsed;
  console.error('graphmind import: not implemented yet');
  return 1;
}
