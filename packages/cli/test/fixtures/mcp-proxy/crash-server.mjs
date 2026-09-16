#!/usr/bin/env node
/**
 * A server that never gets going: it logs to stderr, then exits non-zero
 * before answering anything — a missing env var, a bad import, a crash on
 * boot. `CRASH_LINES=<n>` controls how many stderr lines precede the exit
 * (to prove the ring buffer is bounded); `CRASH_CODE` the exit code.
 */
import { stderr, env, exit } from 'node:process';

const lines = Number(env.CRASH_LINES ?? 3);
for (let i = 1; i <= lines; i += 1) {
  stderr.write(`crash-server: line ${i} of ${lines}\n`);
}
stderr.write('Error: FATAL: DATABASE_URL is not set\n    at boot (crash-server.mjs:9:11)\n');
exit(Number(env.CRASH_CODE ?? 2));
