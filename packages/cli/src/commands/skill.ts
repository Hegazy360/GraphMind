/**
 * `graphmind skill [name] [--install [--force]]` — GraphMind's Agent Skills.
 *
 * The skills (skills/<dir>/SKILL.md, shipped in the npm package) teach a
 * coding agent to use GraphMind's services:
 *
 *   graphmind   the debugger: set it up, run the serve/pauses/wait/resume loop
 *   circuit     durable workflows: start, inspect, fix and resume runs
 *   jack        the user's API as a hosted MCP server
 *
 *   graphmind skill [name]                    print one (default: graphmind)
 *   graphmind skill [name|all] --install      write .claude/skills/<dir>/SKILL.md here
 *   graphmind skill [name|all] --install --force  ...replacing existing ones
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ParsedCli } from '../args.js';
import { packageRoot } from '../paths.js';
import { recordTelemetry } from '../telemetry.js';

/** Skill name on the command line → its directory under skills/ (and under .claude/skills/). */
export const SKILLS = { graphmind: 'graphmind', circuit: 'graphmind-circuit', jack: 'graphmind-jack' } as const;
export type SkillName = keyof typeof SKILLS;

export const skillSource = (name: SkillName) => join(packageRoot, 'skills', SKILLS[name], 'SKILL.md');
/** Relative to the directory the command runs in (Claude Code's project skills). */
export const skillInstallPath = (name: SkillName) => join('.claude', 'skills', SKILLS[name], 'SKILL.md');

export const SKILL_SOURCE = skillSource('graphmind');
export const SKILL_INSTALL_PATH = skillInstallPath('graphmind');

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
  if (parsed.positionals.length > 1) {
    io.error(`graphmind skill: unexpected argument "${parsed.positionals[1]}"`);
    return 1;
  }
  const choice = parsed.positionals[0] ?? 'graphmind';
  const known = Object.keys(SKILLS) as SkillName[];
  if (choice !== 'all' && !known.includes(choice as SkillName)) {
    io.error(`graphmind skill: unknown skill "${choice}" (one of: ${known.join(', ')}, all)`);
    return 1;
  }
  if (choice === 'all' && !parsed.flags.install) {
    io.error('graphmind skill: "all" only works with --install; print one skill at a time');
    return 1;
  }
  const names = choice === 'all' ? known : [choice as SkillName];
  const texts = new Map<SkillName, string>();
  for (const name of names) {
    try {
      texts.set(name, readFileSync(skillSource(name), 'utf8'));
    } catch (error) {
      io.error(`graphmind skill: cannot read ${skillSource(name)} (${(error as Error).message})`);
      return 1;
    }
  }
  if (!parsed.flags.install) {
    io.out(texts.get(names[0] as SkillName) as string);
    return 0;
  }
  // Refuse before writing anything, so `all` never leaves a half-installed set.
  const targets = names.map((name) => [name, join(io.cwd, skillInstallPath(name))] as const);
  const existing = targets.filter(([, target]) => existsSync(target));
  if (existing.length > 0 && !parsed.flags.force) {
    for (const [, target] of existing) io.error(`graphmind skill: ${target} already exists; re-run with --force to overwrite it`);
    return 1;
  }
  for (const [name, target] of targets) {
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, texts.get(name) as string);
    } catch (error) {
      io.error(`graphmind skill: cannot write ${target} (${(error as Error).message})`);
      return 1;
    }
    io.log(`Wrote ${target}`);
  }
  io.log('Claude Code picks them up in this project; other agents can read the same files.');
  return 0;
}
