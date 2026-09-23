/**
 * The files a running `graphmind serve` leaves for the CLI and the browser
 * (Phase 7, contract C3), in `$GRAPHMIND_HOME/run/` (default
 * `~/.graphmind/run/`, directory 0700, files 0600):
 *
 *   serve-<port>.json   {port, pid, url, agentToken, version} — what
 *                       `graphmind pauses|wait|resume` read to find the
 *                       server and present the agent token
 *   open-<port>.html    a redirect to `http://127.0.0.1:<port>/#token=<viewer>`
 *
 * Why a redirect FILE: a URL on a command line (`open http://…#token=…`) is
 * visible to every local user in `ps`, and in shell history and CI logs. A
 * 0600 file in a 0700 directory is readable by this OS user only; the browser
 * is handed its path, and the token travels in the fragment, which is never
 * sent to a server or in a Referer.
 *
 * Both files are removed when the server shuts down cleanly. A crash leaves
 * them behind; the next server on that port overwrites them, and the CLI
 * treats a token the server refuses as stale.
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ControlTokens } from './control-auth.js';
import { openBrowser } from './open-browser.js';
import { resolveRunDir, type EnvLike } from './paths.js';

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** What `serve-<port>.json` holds. */
export interface RunFileContent {
  port: number;
  pid: number;
  url: string;
  agentToken: string;
  version: string;
}

export interface RunFiles {
  readonly credentialPath: string;
  readonly openerPath: string;
  /** Delete both files if they are still this server's. Never throws. */
  remove(): void;
}

const isPosix = process.platform !== 'win32';

export function credentialPathFor(env: EnvLike, port: number): string {
  return join(resolveRunDir(env), `serve-${port}.json`);
}

export function openerPathFor(env: EnvLike, port: number): string {
  return join(resolveRunDir(env), `open-${port}.html`);
}

function ownedByMe(uid: number): boolean {
  return typeof process.getuid !== 'function' || process.getuid() === uid;
}

/**
 * Create (or tighten) the run directory. Refuses a symlink, a non-directory,
 * or a directory owned by someone else — writing a credential into a place
 * another user controls would hand it to them.
 */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${dir} is not a directory`);
  }
  if (!isPosix) return;
  if (!ownedByMe(stat.uid)) throw new Error(`${dir} is owned by another user`);
  if ((stat.mode & 0o777) !== DIR_MODE) {
    // mkdirSync's mode is masked by the umask and ignored for an existing
    // directory, so the permission is set explicitly.
    chmodSync(dir, DIR_MODE);
  }
}

/**
 * Write `content` to `path` with mode 0600, atomically: a fresh temp file is
 * created exclusively (`wx`, so a planted file or symlink is never followed),
 * written, and renamed over the target.
 */
function writePrivateFile(path: string, content: string): void {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(temp, 'wx', FILE_MODE);
  try {
    writeSync(fd, content);
    if (isPosix) fchmodSync(fd, FILE_MODE);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // best effort
    }
    throw error;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** The redirect page: script first, meta refresh and a link as fallbacks. */
export function openerHtml(target: string): string {
  const attr = escapeHtml(target);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="0;url=${attr}">
<title>Opening GraphMind…</title>
<script>location.replace(${JSON.stringify(target).replaceAll('<', '\\u003c')});</script>
</head>
<body>
<p><a href="${attr}" rel="noreferrer">Open GraphMind</a></p>
</body>
</html>
`;
}

/**
 * Write both run files. Throws on failure; the server treats that as "no CLI
 * control and no token link" and keeps serving (fail-open).
 */
export function writeRunFiles(options: {
  env: EnvLike;
  port: number;
  url: string;
  tokens: ControlTokens;
  version: string;
}): RunFiles {
  const dir = resolveRunDir(options.env);
  ensurePrivateDir(dir);
  const credentialPath = credentialPathFor(options.env, options.port);
  const openerPath = openerPathFor(options.env, options.port);
  const content: RunFileContent = {
    port: options.port,
    pid: process.pid,
    url: options.url,
    agentToken: options.tokens.agent,
    version: options.version,
  };
  writePrivateFile(credentialPath, `${JSON.stringify(content, null, 2)}\n`);
  writePrivateFile(openerPath, openerHtml(`${options.url}/#token=${options.tokens.viewer}`));

  const ours = (path: string, marker: string): boolean => {
    try {
      return readFileSync(path, 'utf8').includes(marker);
    } catch {
      return false;
    }
  };
  let removed = false;
  return {
    credentialPath,
    openerPath,
    remove() {
      if (removed) return;
      removed = true;
      // Only our own files: a newer server on the same port (after a crash
      // of this one) has written its own, which must survive our exit.
      for (const [path, marker] of [
        [credentialPath, options.tokens.agent],
        [openerPath, options.tokens.viewer],
      ] as const) {
        if (!ours(path, marker)) continue;
        try {
          unlinkSync(path);
        } catch {
          // already gone
        }
      }
    },
  };
}

export type ReadRunFileResult =
  | { ok: true; path: string; content: RunFileContent }
  | { ok: false; path: string; reason: 'missing' | 'insecure' | 'invalid'; message: string };

/**
 * Read `serve-<port>.json` for the CLI. Refuses a file another user owns or
 * other users can read: its token cannot be trusted to still be secret (and
 * a planted one could point the CLI somewhere else).
 */
export function readRunFile(env: EnvLike, port: number): ReadRunFileResult {
  const path = credentialPathFor(env, port);
  let text: string;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) {
      return { ok: false, path, reason: 'insecure', message: `${path} is not a regular file` };
    }
    if (isPosix && (!ownedByMe(stat.uid) || (stat.mode & 0o077) !== 0)) {
      return {
        ok: false,
        path,
        reason: 'insecure',
        message: `${path} is readable by other users or owned by someone else; delete it and restart graphmind serve`,
      };
    }
    text = readFileSync(path, 'utf8');
  } catch {
    return {
      ok: false,
      path,
      reason: 'missing',
      message: `no credential file at ${path} — is \`graphmind serve\` running on port ${port} as this user?`,
    };
  }
  try {
    const parsed = JSON.parse(text) as Partial<RunFileContent>;
    if (typeof parsed.agentToken !== 'string' || typeof parsed.port !== 'number') throw new Error('shape');
    return {
      ok: true,
      path,
      content: {
        port: parsed.port,
        pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
        url: typeof parsed.url === 'string' ? parsed.url : `http://127.0.0.1:${port}`,
        agentToken: parsed.agentToken,
        version: typeof parsed.version === 'string' ? parsed.version : 'unknown',
      },
    };
  } catch {
    return { ok: false, path, reason: 'invalid', message: `${path} is not a GraphMind credential file` };
  }
}

/**
 * Open the viewer with its token when this user can: through the running
 * server's redirect file if there is one (and it is private), else the plain
 * URL (the viewer then connects without a credential: it can watch and
 * continue, but not edit inputs).
 */
export function openViewerFor(env: EnvLike, port: number, url: string): void {
  const opener = openerPathFor(env, port);
  try {
    const stat = lstatSync(opener);
    if (stat.isFile() && (!isPosix || (ownedByMe(stat.uid) && (stat.mode & 0o077) === 0))) {
      openBrowser(opener);
      return;
    }
  } catch {
    // no redirect file: fall through to the plain URL
  }
  openBrowser(url);
}
