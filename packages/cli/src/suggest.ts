/**
 * "Did you mean" for mistyped subcommands. The command table is a dozen short
 * words, so nothing clever is needed — only that the two typos people
 * actually make (`sevre`, `rnus`) land on the right name instead of a dead
 * end. Distance is Damerau–Levenshtein (optimal string alignment) so a
 * transposition costs 1, not 2: transposing letters IS the common typo.
 */

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  // Three rolling rows: current, previous, and the one before (transpositions).
  let beforePrev: number[] = [];
  let prev = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i += 1) {
    const current = [i];
    for (let j = 1; j < cols; j += 1) {
      const substitution = (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      let best = Math.min((prev[j] as number) + 1, (current[j - 1] as number) + 1, substitution);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, (beforePrev[j - 2] as number) + 1);
      }
      current.push(best);
    }
    beforePrev = prev;
    prev = current;
  }
  return prev[cols - 1] as number;
}

/**
 * The commands worth offering for `input`, best first. An unambiguous prefix
 * (`rec` → record) counts; otherwise one typo for short names, two for longer
 * ones. Empty when nothing is close enough to say with a straight face.
 */
export function suggestCommands(input: string, commands: readonly string[]): string[] {
  const needle = input.toLowerCase();
  if (needle.length >= 2) {
    const prefixed = commands.filter((name) => name.startsWith(needle));
    if (prefixed.length > 0) return [...prefixed].sort();
  }
  const threshold = needle.length <= 4 ? 1 : 2;
  return commands
    .map((name) => ({ name, distance: editDistance(needle, name) }))
    .filter(({ distance }) => distance <= threshold)
    .sort((x, y) => x.distance - y.distance || x.name.localeCompare(y.name))
    .map(({ name }) => name);
}

/** The full stderr message for an unrecognized command, one line per entry. */
export function unknownCommandLines(input: string, commands: readonly string[]): string[] {
  const lines = [`graphmind: unknown command "${input}"`];
  const close = suggestCommands(input, commands);
  if (close.length === 1) lines.push(`  did you mean "${close[0]}"?`);
  else if (close.length > 1)
    lines.push(`  did you mean one of: ${close.map((name) => `"${name}"`).join(', ')}?`);
  lines.push('Run "graphmind help" for the list of commands.');
  return lines;
}
