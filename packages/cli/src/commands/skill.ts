/**
 * `graphmind skill [--install [--force]]` — the GraphMind Agent Skill.
 *
 * The skill (skills/graphmind/SKILL.md, shipped in the npm package) teaches a
 * coding agent to set GraphMind up for the user's agent and to run the debug
 * loop with `serve --json`, `pauses`, `wait` and `resume`.
 *
 *   graphmind skill                    print it (pipe it wherever you like)
 *   graphmind skill --install          write .claude/skills/graphmind/SKILL.md here
 *   graphmind skill --install --force  ...replacing an existing one
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ParsedCli } from '../args.js';
import { packageRoot } from '../paths.js';
import { recordTelemetry } from '../telemetry.js';

export const SKILL_SOURCE = join(packageRoot, 'skills', 'graphmind', 'SKILL.md');
/** Relative to the directory the command runs in (Claude Code's project skills). */
export const SKILL_INSTALL_PATH = join('.claude', 'skills', 'graphmind', 'SKILL.md');

export interface SkillIo {
  out(text: string): void;
  log(message: string): void;
  error(message: string): void;
  cwd: string;
}

const defaultIo = (): SkillIo => ({
  out: (text) => void process.stdout.write(text),
  log: (message) => console.log(message),
  error: (message) => console.error(message),
  cwd: process.cwd(),
});

export async function runSkill(parsed: ParsedCli, io: SkillIo = defaultIo()): Promise<number> {
  recordTelemetry('skill');
  if (parsed.positionals.length > 0) {
    io.error(`graphmind skill: unexpected argument "${parsed.positionals[0]}"`);
    return 1;
  }
  let text: string;
  try {
    text = readFileSync(SKILL_SOURCE, 'utf8');
  } catch (error) {
    io.error(`graphmind skill: cannot read ${SKILL_SOURCE} (${(error as Error).message})`);
    return 1;
  }
  if (!parsed.flags.install) {
    io.out(text);
    return 0;
  }
  const target = join(io.cwd, SKILL_INSTALL_PATH);
  if (existsSync(target) && !parsed.flags.force) {
    io.error(`graphmind skill: ${target} already exists; re-run with --force to overwrite it`);
    return 1;
  }
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  } catch (error) {
    io.error(`graphmind skill: cannot write ${target} (${(error as Error).message})`);
    return 1;
  }
  io.log(`Wrote ${target}`);
  io.log('Claude Code picks it up in this project; other agents can read the same file.');
  return 0;
}
