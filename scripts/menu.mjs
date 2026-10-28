/**
 * `pnpm start` — the interactive front door to the repo, for anyone who does
 * not want to memorize the script names (and the place new dev commands get
 * added: one entry in ITEMS below, nothing else).
 *
 * Arrow keys / j k move, 1–9 jump, Enter runs, q quits. Every entry shows the
 * direct command it stands for, so using the menu teaches the shortcut — the
 * menu is a map of DEVELOPMENT.md, not a replacement for it.
 *
 * Deliberately dependency-free (raw-mode readline + ANSI), like every other
 * script in this directory: a prompt library would be the only runtime
 * dependency of the whole monorepo root.
 */
import { spawn } from 'node:child_process';
import { emitKeypressEvents } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const node = process.execPath;

/**
 * The whole menu. `hint` is the direct command the entry stands for (shown
 * dimmed, and printed before running); `steps` is what actually runs, in
 * order — `pnpm` entries go through a shell on Windows, node scripts run
 * with the current Node.
 */
const ITEMS = [
  { header: 'Run' },
  {
    label: 'Dev loop — server with demo data + viewer hot reload',
    hint: 'pnpm dev',
    steps: [[node, join(repoRoot, 'scripts', 'dev.mjs')]],
  },
  {
    label: 'Dev loop — empty server, attach your own agent',
    hint: 'pnpm dev --serve',
    steps: [[node, join(repoRoot, 'scripts', 'dev.mjs'), '--serve']],
  },
  {
    label: 'Viewer only (no server; ?fixture=1 for canned data)',
    hint: 'pnpm dev:viewer',
    steps: [[node, join(repoRoot, 'scripts', 'dev.mjs'), '--viewer-only']],
  },
  {
    label: 'Docs site with hot reload',
    hint: 'pnpm dev:docs',
    steps: [['pnpm', '--filter', 'docs', 'dev']],
  },
  {
    label: 'The shipped demo (graphmind demo from this checkout)',
    hint: 'pnpm demo',
    steps: [[node, join(repoRoot, 'scripts', 'cli.mjs'), 'demo']],
  },
  { header: 'Check' },
  { label: 'Typecheck everything', hint: 'pnpm typecheck', steps: [['pnpm', 'typecheck']] },
  { label: 'Unit tests (packages + viewer)', hint: 'pnpm test', steps: [['pnpm', 'test']] },
  { label: "Viewer end-to-end tests (Playwright)", hint: 'pnpm test:e2e', steps: [['pnpm', 'test:e2e']] },
  {
    label: 'Security regression suite',
    hint: 'pnpm build:viewer && pnpm test:security',
    steps: [
      ['pnpm', 'build:viewer'],
      ['pnpm', 'test:security'],
    ],
  },
  { header: 'Build' },
  {
    label: 'Rebuild packages/* (after editing them)',
    hint: 'pnpm build:packages',
    steps: [['pnpm', 'build:packages']],
  },
  {
    label: 'Build the viewer into the CLI (what npx users get)',
    hint: 'pnpm build:viewer',
    steps: [['pnpm', 'build:viewer']],
  },
  { label: 'Build everything', hint: 'pnpm build', steps: [['pnpm', 'build']] },
  { header: 'More' },
  {
    label: "The graphmind CLI's own command list",
    hint: 'pnpm cli help',
    steps: [[node, join(repoRoot, 'scripts', 'cli.mjs'), 'help']],
  },
];

const selectable = ITEMS.map((item, index) => ({ item, index })).filter(({ item }) => !item.header);

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const hintColumn = Math.max(...selectable.map(({ item }) => item.label.length)) + 4;

function renderLines(cursor) {
  const lines = [
    `${paint(1, 'GraphMind')} — what do you want to do?  ${paint(2, '↑/↓ move · 1-9 jump · Enter run · q quit')}`,
  ];
  let ordinal = 0;
  for (const item of ITEMS) {
    if (item.header !== undefined) {
      lines.push(paint(2, ` ${item.header}`));
      continue;
    }
    ordinal += 1;
    const number = ordinal <= 9 ? `${ordinal}.` : '  ';
    const row = ` ${number} ${item.label.padEnd(hintColumn)}${paint(2, item.hint)}`;
    lines.push(ordinal - 1 === cursor ? paint(36, `❯${row}`) : ` ${row}`);
  }
  return lines;
}

/** Run the selected entry's steps in order; the first failure stops the rest. */
async function runSelection(item) {
  console.log(`\n${paint(2, '→')} ${paint(1, item.hint)}\n`);
  for (const [command, ...args] of item.steps) {
    const code = await new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: repoRoot,
        stdio: 'inherit',
        shell: command === 'pnpm' && process.platform === 'win32',
      });
      child.on('error', (error) => {
        console.error(`menu: failed to run ${command} (${error.message})`);
        resolve(1);
      });
      child.on('exit', (exitCode, signal) => resolve(signal !== null ? 1 : (exitCode ?? 1)));
    });
    if (code !== 0) return code;
  }
  return 0;
}

// Not a terminal (piped, CI): the menu cannot be driven, so be the map instead.
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  for (const line of renderLines(-1)) console.log(line);
  console.log('\nNot a terminal, so nothing to select — run one of the commands above directly.');
  console.log('The full reference is DEVELOPMENT.md.');
  process.exit(0);
}

let cursor = 0;
let printedLines = 0;

function draw() {
  if (printedLines > 0) process.stdout.write(`\x1b[${printedLines}A\x1b[0J`);
  const lines = renderLines(cursor);
  process.stdout.write(`${lines.join('\n')}\n`);
  printedLines = lines.length;
}

function cleanup() {
  process.stdout.write('\x1b[?25h'); // show the cursor again
  process.stdin.setRawMode(false);
  process.stdin.pause();
}

process.stdout.write('\x1b[?25l'); // hide the cursor while the menu owns the screen
emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.resume();
draw();

process.stdin.on('keypress', (char, key) => {
  const name = key?.name;
  if (name === 'down' || name === 'j' || (name === 'tab' && key?.shift !== true)) {
    cursor = (cursor + 1) % selectable.length;
    draw();
  } else if (name === 'up' || name === 'k' || (name === 'tab' && key?.shift === true)) {
    cursor = (cursor - 1 + selectable.length) % selectable.length;
    draw();
  } else if (char >= '1' && char <= '9' && Number(char) <= selectable.length) {
    cursor = Number(char) - 1;
    draw();
  } else if (name === 'return') {
    cleanup();
    const { item } = selectable[cursor];
    void runSelection(item).then((code) => {
      process.exitCode = code;
    });
  } else if (name === 'q' || name === 'escape' || (name === 'c' && key?.ctrl === true)) {
    cleanup();
    process.exitCode = 0;
  }
});
