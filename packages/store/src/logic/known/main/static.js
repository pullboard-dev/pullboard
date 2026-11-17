import { mainRedFact } from "../../../../../items/index.js";
import { appendFact } from "../../../io/board/fact.js";

/**
 * Record a static run's known main findings on the item: one measurement fact per rule and file, each worded by the Main red fact writer.
 * Why: a static finding main also has is not the item's, and the fact keeps that on the item's thread for the reviewer [C7,#10451].
 * @param {object} board The open board.
 * @param {number} id The submitting item.
 * @param {{ agentId: string, findings: { rule: string, file: string }[], main: string }} record The submitter, the knownMain findings, and main's commit.
 * @returns {object[]} The facts written, none for an empty list.
 */
export function recordKnownMainStatic(board, id, { agentId, findings, main }) {
  return findings.map(finding => appendFact(board, id, { agentId, kind: 'measurement',
    text: mainRedFact([{ file: finding.file, name: finding.rule }], `static finding, also red on main ${main.slice(0, 12)}`) }));
}
