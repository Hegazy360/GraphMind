/**
 * Result collection and printing. One `Report` per process; suites push
 * checks into it, `main` prints the summary and the token bill GraphMind
 * itself observed.
 */

export interface CheckResult {
  suite: string;
  scenario: string;
  name: string;
  ok: boolean;
  detail: string;
}

export interface UsageRow {
  suite: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const DIM = '\u001b[2m';
const YELLOW = '\u001b[33m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

export class Report {
  readonly checks: CheckResult[] = [];
  readonly usage: UsageRow[] = [];
  readonly notes: string[] = [];
  readonly skipped: string[] = [];
  private suite = '-';
  private scenario = '-';

  suiteStart(name: string): void {
    this.suite = name;
    console.log(`\n${BOLD}== ${name}${RESET}`);
  }

  scenarioStart(name: string): void {
    this.scenario = name;
    console.log(`${DIM}-- ${name}${RESET}`);
  }

  check(name: string, ok: boolean, detail = ''): boolean {
    this.checks.push({ suite: this.suite, scenario: this.scenario, name, ok, detail });
    const mark = ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    console.log(`  ${mark}  ${name}${detail ? ` ${DIM}— ${detail}${RESET}` : ''}`);
    return ok;
  }

  /** A reality-gap observation worth reporting even when nothing failed. */
  note(text: string): void {
    this.notes.push(`[${this.suite}] ${text}`);
    console.log(`  ${YELLOW}NOTE${RESET}  ${text}`);
  }

  skip(name: string, why: string): void {
    this.skipped.push(`${name}: ${why}`);
    console.log(`  ${YELLOW}SKIP${RESET}  ${name} ${DIM}— ${why}${RESET}`);
  }

  recordUsage(model: string, inputTokens: number, outputTokens: number): void {
    this.usage.push({ suite: this.suite, model, inputTokens, outputTokens });
  }

  get failures(): CheckResult[] {
    return this.checks.filter((c) => !c.ok);
  }

  print(): void {
    const failures = this.failures;
    console.log(`\n${BOLD}== summary${RESET}`);
    console.log(`  checks   ${this.checks.length - failures.length}/${this.checks.length} passed`);
    if (this.skipped.length > 0) {
      console.log(`  skipped  ${this.skipped.length}`);
      for (const s of this.skipped) console.log(`    - ${s}`);
    }
    if (failures.length > 0) {
      console.log(`\n${RED}  failures:${RESET}`);
      for (const f of failures) {
        console.log(`    - [${f.suite} / ${f.scenario}] ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
      }
    }
    if (this.notes.length > 0) {
      console.log(`\n${YELLOW}  notes (reality gaps / observations):${RESET}`);
      for (const n of this.notes) console.log(`    - ${n}`);
    }

    console.log(`\n${BOLD}== token usage recorded by GraphMind${RESET}`);
    console.log(`  ${DIM}(summed from the usage field of every node.finished envelope the`);
    console.log(`   debugger received — GraphMind's own books, not the SDKs')${RESET}`);
    const byModel = new Map<string, { input: number; output: number; steps: number }>();
    for (const row of this.usage) {
      const key = `${row.suite} / ${row.model}`;
      const acc = byModel.get(key) ?? { input: 0, output: 0, steps: 0 };
      acc.input += row.inputTokens;
      acc.output += row.outputTokens;
      acc.steps += 1;
      byModel.set(key, acc);
    }
    let totalIn = 0;
    let totalOut = 0;
    const width = Math.max(20, ...[...byModel.keys()].map((k) => k.length));
    for (const [key, acc] of byModel) {
      totalIn += acc.input;
      totalOut += acc.output;
      console.log(
        `  ${key.padEnd(width)}  in ${String(acc.input).padStart(7)}  out ${String(
          acc.output,
        ).padStart(6)}  (${acc.steps} llm steps)`,
      );
    }
    console.log(
      `  ${'TOTAL'.padEnd(width)}  in ${String(totalIn).padStart(7)}  out ${String(
        totalOut,
      ).padStart(6)}`,
    );
  }
}
