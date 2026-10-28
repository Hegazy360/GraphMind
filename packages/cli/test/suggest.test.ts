/**
 * The typo path: a mistyped subcommand must come back with the right name,
 * and a string that is not close to anything must not get a wild guess —
 * a wrong suggestion is worse than none.
 */
import { describe, expect, it } from 'vitest';
import { editDistance, suggestCommands, unknownCommandLines } from '../src/suggest.js';

// The real table from cli.ts, mirrored: suggestions are only as good as the
// candidate list they are tested against.
const COMMANDS = [
  'serve',
  'demo',
  'init',
  'import',
  'mcp',
  'mcp-proxy',
  'runs',
  'record',
  'pauses',
  'wait',
  'resume',
  'skill',
  'help',
];

describe('editDistance', () => {
  it('is 0 only for equal strings', () => {
    expect(editDistance('serve', 'serve')).toBe(0);
    expect(editDistance('', '')).toBe(0);
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('abc', '')).toBe(3);
  });

  it('counts a transposition as one edit, not two', () => {
    expect(editDistance('sevre', 'serve')).toBe(1);
    expect(editDistance('rnus', 'runs')).toBe(1);
  });

  it('counts inserts, deletes and substitutions', () => {
    expect(editDistance('serv', 'serve')).toBe(1);
    expect(editDistance('serves', 'serve')).toBe(1);
    expect(editDistance('serle', 'serve')).toBe(1);
  });
});

describe('suggestCommands', () => {
  it('lands the classic transposition typos', () => {
    expect(suggestCommands('sevre', COMMANDS)).toEqual(['serve']);
    expect(suggestCommands('rnus', COMMANDS)).toEqual(['runs']);
    expect(suggestCommands('hlep', COMMANDS)).toEqual(['help']);
  });

  it('treats a prefix as a suggestion', () => {
    expect(suggestCommands('rec', COMMANDS)).toEqual(['record']);
    // Ambiguous prefixes offer every match.
    expect(suggestCommands('re', COMMANDS)).toEqual(['record', 'resume']);
    expect(suggestCommands('mcp', COMMANDS)).toContain('mcp');
  });

  it('is case-insensitive about the input', () => {
    expect(suggestCommands('SERVE', COMMANDS)).toEqual(['serve']);
  });

  it('allows one edit on short names, two on longer ones', () => {
    expect(suggestCommands('wat', COMMANDS)).toEqual(['wait']);
    // Two edits away from a 4-letter command is a different word, not a typo.
    expect(suggestCommands('went', COMMANDS)).toEqual([]);
    expect(suggestCommands('pasues', COMMANDS)).toEqual(['pauses']);
  });

  it('says nothing rather than guessing', () => {
    expect(suggestCommands('xyzzy', COMMANDS)).toEqual([]);
    expect(suggestCommands('workflow', COMMANDS)).toEqual([]);
  });
});

describe('unknownCommandLines', () => {
  it('names the typo, offers the fix, and points at `help`', () => {
    expect(unknownCommandLines('sevre', COMMANDS)).toEqual([
      'graphmind: unknown command "sevre"',
      '  did you mean "serve"?',
      'Run "graphmind help" for the list of commands.',
    ]);
  });

  it('lists every candidate when more than one is close', () => {
    const lines = unknownCommandLines('re', COMMANDS);
    expect(lines[1]).toBe('  did you mean one of: "record", "resume"?');
  });

  it('skips the suggestion line when there is nothing to suggest', () => {
    expect(unknownCommandLines('xyzzy', COMMANDS)).toEqual([
      'graphmind: unknown command "xyzzy"',
      'Run "graphmind help" for the list of commands.',
    ]);
  });
});
