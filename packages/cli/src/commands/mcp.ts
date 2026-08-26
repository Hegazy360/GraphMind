/** `graphmind mcp` — expose runs/steps to MCP clients (Claude Code, Cursor). */
import type { ParsedCli } from '../args.js';

export async function runMcp(parsed: ParsedCli): Promise<number> {
  void parsed;
  console.error('graphmind mcp: not implemented yet');
  return 1;
}
