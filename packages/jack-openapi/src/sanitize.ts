/**
 * Text that reaches a model through a tool definition is an attack surface
 * (tool poisoning, plan §3.6): a customer's spec — or a dependency's spec
 * they import — can carry invisible instructions. Everything we copy from
 * the document into a manifest goes through here.
 */

/**
 * Invisible or direction-changing characters: Unicode format characters
 * (zero-width joiners, bidi overrides, BOM, the U+E0000 TAG block that can
 * spell out hidden ASCII) and C0/C1 controls other than tab and newline.
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\p{Cf}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

export interface Sanitized {
  text: string;
  /** How many characters were removed. */
  stripped: number;
}

export function sanitizeText(raw: string): Sanitized {
  const text = raw.replace(INVISIBLE, '');
  return { text, stripped: [...raw].length - [...text].length };
}

/**
 * Phrases that address the model rather than describe the API. Not a
 * filter (a legitimate description can say "you must pass an id") — a lint
 * so a human looks at it before it ships.
 */
const INSTRUCTION_LIKE = [
  /ignore (all |any )?(previous|prior|above|earlier) (instructions|messages|context)/i,
  /disregard (all |any )?(previous|prior|above|the) /i,
  /<\/?(system|instructions?|important|admin)>/i,
  /do not (tell|inform|mention (this )?to) the user/i,
  /without (telling|asking|informing) the user/i,
  /\b(always|first) (call|invoke|use) (the )?tool\b/i,
  /exfiltrat|send (the |all )?(conversation|chat history|secrets?|credentials|api keys?)/i,
];

export function looksLikeInstructions(text: string): string | null {
  for (const re of INSTRUCTION_LIKE) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

/** Collapse runs of blank lines and trim; keeps Markdown paragraphs readable. */
export const tidy = (text: string): string => text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
