/** The init notes that name each detected language's JUnit-writing gate command and report path [C7]. */
import { junitCommand } from '../../../../../packages/gate/index.js';

/**
 * One note line per detected language that has a report form: the command that writes JUnit, the report path, the setting line
 * that records it, and any extra package it needs. Languages with no report form (make) and unknown names give no line.
 * Why: init sets a plain test command, so landing names no failure of a non-Node repo until a person finds each tool's report flag.
 *
 * @param {readonly { language: string }[]} entries what detectLanguages returned
 * @returns {string[]} the lines, in the order the entries came, one per language
 */
export function languageNotes(entries) {
  const lines = [];
  const seen = new Set();
  for (const { language } of entries ?? []) {
    const row = junitCommand(language);
    if (!row || seen.has(language)) continue;
    seen.add(language);
    const needs = row.needs ? `; it needs ${row.needs}` : '';
    lines.push(`${language}: for failures by name at landing, run \`${row.command}\` in the gate and record the report with pullboard settings gate.junitReport ${row.report}${needs}`);
  }
  return lines;
}
