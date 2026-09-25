/**
 * Text that reaches a terminal or a shell from somewhere we do not control.
 *
 * Run ids, pause ids, node ids and names, the app name, a smart hold's detail:
 * all of it is written by whatever connected to `/ingest`, which needs no
 * credential. Printed raw, an escape sequence in it drives the terminal (OSC 52
 * writes the clipboard, CSI 2J clears the screen, a bidi override reorders what
 * the human reads); pasted raw into a suggested command, a `;` in it runs as a
 * second command.
 */

/**
 * C0/C1 controls (line feeds included — a value never spans lines), the bidi
 * marks, embeddings, overrides and isolates, and the line/paragraph
 * separators. Same set as the client's `sanitizeShortText`, plus U+2028/9.
 */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const UNPRINTABLE_ALL = new RegExp(UNPRINTABLE.source, 'g');

/** Does `text` carry anything `printable` would rewrite? */
export function hasUnprintable(text: string): boolean {
  return UNPRINTABLE.test(text);
}

/**
 * `text` with every unprintable character shown as a visible `\uXXXX` escape:
 * nothing reaches the terminal as a control, and nothing is silently dropped
 * (an id that differs only by a control character still reads differently).
 */
export function printable(text: string): string {
  return text.replace(UNPRINTABLE_ALL, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Characters a POSIX shell (and PowerShell/cmd) passes through as one plain word. */
const SHELL_SAFE = /^[A-Za-z0-9._:@%+=,/-]+$/;

/**
 * One shell word for `value`: as is when it is plain, otherwise single-quoted
 * (a `'` inside becomes `'\''`). Only for values without unprintable
 * characters (`hasUnprintable`): a control character inside quotes is still a
 * control character on screen.
 */
export function shellQuote(value: string): string {
  if (SHELL_SAFE.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
