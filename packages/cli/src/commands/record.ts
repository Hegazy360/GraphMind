/** `graphmind record` — capture an incoming run's envelope stream to a
 * replayable NDJSON fixture file. */
import type { ParsedCli } from '../args.js';

export async function runRecord(parsed: ParsedCli): Promise<number> {
  void parsed;
  console.error('graphmind record: not implemented yet');
  return 1;
}
