/** Turn the static check's failure output into findings that name a rule and a file [C7,#3854]. */

/** One finding row: `path:line: text`, with the `STATIC_RED ` prefix the gate prints optional. */
const ROW = /^(?:STATIC_RED\s+)?(\S+?):\d+: (.+)$/u;

/**
 * The rule a finding text belongs to: its numbers and trailing spec ids dropped, so the same rule reads the same
 * on main and on an item even when a count or a line moves.
 * @param {string} text The text after `path:line: `.
 * @returns {string} The rule.
 */
export function ruleOf(text) {
  return text.replace(/\s*\[[^\]]*\]\s*$/u, '').replace(/\d+/gu, '#').trim();
}

/**
 * Parse the static check's output into findings, sorted by rule then file, one per rule and file. Lines that are not rows
 * (the green line, progress, blanks) are skipped, so green output gives an empty list.
 * Why: a static red that main also has at the same rule and file is main's own, and comparing the two runs needs the parts [#3854].
 * @param {string} output The static guard's output.
 * @returns {{ rule: string, file: string }[]} The findings.
 */
export function staticFindings(output) {
  const seen = new Map();
  for (const row of String(output ?? '').split('\n')) {
    const match = ROW.exec(row.trim());
    if (!match) continue;
    const finding = { rule: ruleOf(match[2]), file: match[1] };
    seen.set(`${finding.rule}\u0000${finding.file}`, finding);
  }
  return [...seen.values()].sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file));
}

/**
 * The item's findings that main does not also have at the same rule and file, in the parser's order.
 * Why: a static red main already holds is main's own, so only the remainder may refuse an item's gate [#3854,#10448].
 * @param {{ rule: string, file: string }[]} item The findings of the item's run.
 * @param {{ rule: string, file: string }[]} main The findings of main's run.
 * @returns {{ rule: string, file: string }[]} The item's findings main does not hold.
 */
export function remainingFindings(item, main) {
  const held = new Set(main.map(finding => `${finding.rule}\u0000${finding.file}`));
  return item.filter(finding => !held.has(`${finding.rule}\u0000${finding.file}`));
}

/**
 * Split a red static output by main's findings: every finding the item has, those main also has, and the output rows of the rest.
 * Why: with gate.knownMainStatic on, only the rows main does not hold may refuse the item, and the refusal names just those [C7,#10450].
 * @param {string} output The static guard's output on the item.
 * @param {{ rule: string, file: string }[]} main The findings of main's run.
 * @returns {{ item: { rule: string, file: string }[], known: { rule: string, file: string }[], rows: string[] }} `rows` are the item's output rows main does not hold.
 */
export function splitByMain(output, main) {
  const item = staticFindings(output);
  const rest = new Set(remainingFindings(item, main).map(finding => `${finding.rule}\u0000${finding.file}`));
  const rows = String(output ?? '').split('\n').filter(row => staticFindings(row).some(finding => rest.has(`${finding.rule}\u0000${finding.file}`)));
  return { item, known: item.filter(finding => !rest.has(`${finding.rule}\u0000${finding.file}`)), rows };
}
