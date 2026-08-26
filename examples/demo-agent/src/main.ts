/**
 * CLI entry: `tsx src/main.ts [--live]` (or `pnpm start` / `pnpm start:live`).
 *
 * Runs the trip planner against a local GraphMind server (start one with
 * `graphmind` / `pnpm --filter graphmind-ai ...` first, or just run
 * `graphmind demo --live`, which spawns this file). The planted bug pauses
 * the run when a debugger is attached — resume it from the viewer.
 */
import { runTripPlanner } from './agent.js';

const live = process.argv.includes('--live');

runTripPlanner({
  mode: live ? 'live' : 'mock',
  log: (message) => console.log(`[demo-agent] ${message}`),
}).then(
  (result) => {
    console.log(`\n[demo-agent] final answer:\n${result.text}`);
    process.exitCode = result.aborted ? 0 : 0;
  },
  (error) => {
    console.error(`[demo-agent] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
