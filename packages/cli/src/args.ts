/**
 * Hand-rolled CLI argument parsing — small enough that a dependency would
 * cost more than it saves. Subcommand-shaped from day one: the first
 * positional selects a command (default `serve`), so `import` / `mcp` /
 * `record` can be added to the command table without redesign.
 */

export interface CliFlags {
  port: number | undefined;
  db: string | undefined;
  /** `--no-open` clears it; `--open` (re)sets it. Default true. */
  open: boolean;
  help: boolean;
  version: boolean;
  /** `graphmind demo --live`: run the real demo agent instead of the replay. */
  live: boolean;
  /** `graphmind record --out <file>`: output path override. */
  out: string | undefined;
  /** `graphmind init --install`: run the package-manager install. */
  install: boolean;
  /** `graphmind init --write`: write a graphmind.example.ts snippet file. */
  write: boolean;
}

export interface ParsedCli {
  command: string;
  positionals: string[];
  flags: CliFlags;
  errors: string[];
}

function splitInline(token: string): [string, string | undefined] {
  const eq = token.indexOf('=');
  if (eq === -1) return [token, undefined];
  return [token.slice(0, eq), token.slice(eq + 1)];
}

export function parseCliArgs(argv: string[]): ParsedCli {
  const flags: CliFlags = {
    port: undefined,
    db: undefined,
    open: true,
    help: false,
    version: false,
    live: false,
    out: undefined,
    install: false,
    write: false,
  };
  const positionals: string[] = [];
  const errors: string[] = [];

  const takeValue = (name: string, inline: string | undefined, next: () => string | undefined) => {
    if (inline !== undefined) return inline;
    const value = next();
    if (value === undefined) errors.push(`${name} requires a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }
    const [name, inline] = splitInline(token);
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) return undefined;
      i += 1;
      return value;
    };
    switch (name) {
      case '--help':
      case '-h':
        flags.help = true;
        break;
      case '--version':
      case '-v':
        flags.version = true;
        break;
      case '--port': {
        const raw = takeValue('--port', inline, next);
        if (raw === undefined) break;
        const port = Number(raw);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          errors.push(`--port must be an integer between 1 and 65535 (got "${raw}")`);
        } else {
          flags.port = port;
        }
        break;
      }
      case '--db': {
        const raw = takeValue('--db', inline, next);
        if (raw !== undefined) flags.db = raw;
        break;
      }
      case '--no-open':
        flags.open = false;
        break;
      case '--live':
        flags.live = true;
        break;
      case '--install':
        flags.install = true;
        break;
      case '--write':
        flags.write = true;
        break;
      case '--out': {
        const raw = takeValue('--out', inline, next);
        if (raw !== undefined) flags.out = raw;
        break;
      }
      case '--open':
        flags.open = true;
        break;
      default:
        errors.push(`unknown option "${name}"`);
    }
  }

  const command = positionals.shift() ?? 'serve';
  return { command, positionals, flags, errors };
}
