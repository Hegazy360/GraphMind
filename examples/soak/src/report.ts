/**
 * Console + JSON reporting. Every scenario returns a Section; main prints
 * them and (with --json=<path>) writes the raw numbers so a future run can be
 * diffed against the baseline in README.md.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Row {
  label: string;
  value: string;
  note?: string;
}

export interface Section {
  name: string;
  rows: Row[];
  checks: { name: string; ok: boolean; detail?: string }[];
  findings: string[];
  data: Record<string, unknown>;
  skipped?: string;
}

export function section(name: string): Section {
  return { name, rows: [], checks: [], findings: [], data: {} };
}

export function row(sec: Section, label: string, value: string, note?: string): void {
  sec.rows.push(note === undefined ? { label, value } : { label, value, note });
}

export function check(sec: Section, name: string, ok: boolean, detail?: string): void {
  sec.checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
}

export function finding(sec: Section, text: string): void {
  sec.findings.push(text);
}

const ESC = '\u001B';
const GREY = `${ESC}[90m`;
const RESET = `${ESC}[0m`;
const GREEN = `${ESC}[32m`;
const RED = `${ESC}[31m`;
const YELLOW = `${ESC}[33m`;
const BOLD = `${ESC}[1m`;

const colored = process.stdout.isTTY === true;
const c = (code: string, text: string): string => (colored ? `${code}${text}${RESET}` : text);

export function printSection(sec: Section): void {
  console.log('');
  console.log(c(BOLD, `-- ${sec.name} ${'-'.repeat(Math.max(0, 62 - sec.name.length))}`));
  if (sec.skipped !== undefined) {
    console.log(`   ${c(GREY, `skipped: ${sec.skipped}`)}`);
    return;
  }
  const width = sec.rows.reduce((max, r) => Math.max(max, r.label.length), 0);
  for (const r of sec.rows) {
    const note = r.note === undefined ? '' : `  ${c(GREY, r.note)}`;
    console.log(`   ${r.label.padEnd(width)}  ${r.value}${note}`);
  }
  if (sec.checks.length > 0) console.log('');
  for (const chk of sec.checks) {
    const mark = chk.ok ? c(GREEN, 'PASS') : c(RED, 'FAIL');
    console.log(`   ${mark}  ${chk.name}${chk.detail === undefined ? '' : `  ${c(GREY, chk.detail)}`}`);
  }
  for (const f of sec.findings) console.log(`   ${c(YELLOW, '!')}  ${f}`);
}

export function summarize(sections: readonly Section[]): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  for (const sec of sections) {
    for (const chk of sec.checks) {
      if (chk.ok) passed += 1;
      else failed += 1;
    }
  }
  return { passed, failed };
}

export function writeJson(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}
