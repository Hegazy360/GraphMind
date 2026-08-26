/** CLI argument parsing (hand-rolled, subcommand-shaped). */
import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/args.js';

describe('parseCliArgs', () => {
  it('defaults to the serve command with open enabled', () => {
    const parsed = parseCliArgs([]);
    expect(parsed.command).toBe('serve');
    expect(parsed.flags).toEqual({
      port: undefined,
      db: undefined,
      open: true,
      help: false,
      version: false,
      live: false,
      out: undefined,
      install: false,
      write: false,
    });
    expect(parsed.errors).toEqual([]);
  });

  it('parses flags in both "--flag value" and "--flag=value" forms', () => {
    const a = parseCliArgs(['--port', '5000', '--db', '/tmp/x.db', '--no-open']);
    expect(a.flags.port).toBe(5000);
    expect(a.flags.db).toBe('/tmp/x.db');
    expect(a.flags.open).toBe(false);

    const b = parseCliArgs(['--port=4748', '--db=./y.db']);
    expect(b.flags.port).toBe(4748);
    expect(b.flags.db).toBe('./y.db');
  });

  it('keeps a subcommand table shape: first positional is the command', () => {
    const parsed = parseCliArgs(['import', 'trace.jsonl', '--db', '/tmp/z.db']);
    expect(parsed.command).toBe('import');
    expect(parsed.positionals).toEqual(['trace.jsonl']);
    expect(parsed.flags.db).toBe('/tmp/z.db');
  });

  it('rejects invalid ports and unknown options', () => {
    expect(parseCliArgs(['--port', 'abc']).errors[0]).toContain('--port');
    expect(parseCliArgs(['--port', '0']).errors[0]).toContain('--port');
    expect(parseCliArgs(['--port', '70000']).errors[0]).toContain('--port');
    expect(parseCliArgs(['--bogus']).errors[0]).toContain('--bogus');
    expect(parseCliArgs(['--port']).errors[0]).toContain('requires a value');
  });

  it('recognizes -v/--version and -h/--help', () => {
    expect(parseCliArgs(['-v']).flags.version).toBe(true);
    expect(parseCliArgs(['--version']).flags.version).toBe(true);
    expect(parseCliArgs(['-h']).flags.help).toBe(true);
    expect(parseCliArgs(['--help']).flags.help).toBe(true);
  });
});
