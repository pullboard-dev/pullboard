/** The init notes that name each detected language's JUnit-writing gate command and report path, and a single language's per-file test command [C7]. */
import { affectedRow } from '../../../../../packages/gate/index.js';
import { junitCommand } from '../../../../../packages/gate/index.js';
import { languageToolchains } from '../../../../../packages/gate/heavy.js';

/**
 * One note line per detected language that has a report form: the command that writes JUnit, the report path, the setting line
 * that records it, and any extra package it needs. Languages with no report form (make) and unknown names give no line.
 * A repo with exactly one language that has an affected-test row also gets one line naming its affectedTests command and gate.selectionUnit.
 * Beyond the per-language lines, a repo whose languages need a toolchain other than node, and a report form above, gets one line naming them and the
 * runners.requiredToolchains setting that keeps its jobs off a runner without them; a node-only repo gets none.
 * Why: init sets a plain test command, so landing names no failure of a non-Node repo until a person finds each tool's report flag,
 * and without affectedTests a non-Node submit runs the whole gate every time.
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
  const names = [...new Set((entries ?? []).map(entry => entry.language))];
  const affected = names.length === 1 ? affectedRow(names[0]) : null;
  if (affected?.affectedTests) {
    lines.push(`${names[0]}: to test only what a change touches, record the command with pullboard settings affectedTests ${affected.affectedTests} and the unit with pullboard settings gate.selectionUnit ${affected.selectionUnit}`);
  }
  const needed = languageToolchains((entries ?? []).filter(entry => seen.has(entry.language))).toolchains.filter(name => name !== 'node');
  if (needed.length) {
    lines.push(`runners need ${needed.join(' and ')} for this repo: record it with pullboard settings runners.requiredToolchains ${needed.join(',')} so a job waits for a runner that has them`);
  }
  return lines;
}
