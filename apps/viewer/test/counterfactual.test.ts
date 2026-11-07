/**
 * The "what if?" command the node place copies. It is only ever composed
 * and copied — the viewer does not run commands — so what matters is that
 * the string is correct and safe to paste into a shell.
 */
import { describe, expect, it } from 'vitest';
import { counterfactualCommand } from '../src/lib/commands.js';

describe('counterfactualCommand', () => {
  it('pre-fills the recorded value, so the edit is a diff against reality', () => {
    const command = counterfactualCommand('run_1', 'tool:convert', 0, { usd: 60_000_000 });
    expect(command).toBe(
      `graphmind replay run_1 --substitute tool:convert='{"usd":60000000}' -- <your agent command>`,
    );
  });

  it('names the call number for anything but the first', () => {
    expect(counterfactualCommand('run_1', 'tool:read', 2, 1)).toContain('--substitute tool:read#2=');
  });

  it('escapes a single quote in the value so the shell line stays intact', () => {
    const command = counterfactualCommand('run_1', 'tool:say', 0, { text: "it's fine" });
    // POSIX single-quote escaping: close, escaped quote, reopen.
    expect(command).toContain(String.raw`'{"text":"it'\''s fine"}'`);
    // Outside the escape sequences the quoting is balanced (one pair).
    expect(command.split(String.raw`'\''`).join('').split("'").length - 1).toBe(2);
  });

  it('falls back to null for a value that cannot be serialized', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(counterfactualCommand('run_1', 'tool:x', 0, cyclic)).toContain("tool:x='null'");
  });

  it('renders a missing output as null rather than "undefined"', () => {
    expect(counterfactualCommand('run_1', 'tool:x', 0, undefined)).toContain("tool:x='null'");
  });

  it('takes the agent command when one is known', () => {
    expect(counterfactualCommand('run_1', 'tool:x', 0, 1, 'node agent.js')).toMatch(/-- node agent\.js$/);
  });
});
