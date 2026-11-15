/** The pullboard rules command: replay the board's whole event log through the lifecycle rules and list every disagreement, read-only [C7]. */
import { Refused } from '../../../../../packages/kernel/index.js';
import { lifecycleFact } from '../../../../../packages/moves/index.js';
import { readLifecycleLog } from '../../../../../packages/moves/index.js';
import { trial } from '../../../../../packages/moves/index.js';
import { RULES_VERSION } from '../../../../../packages/moves/index.js';
import { context } from '../entry.js';
import { withBoardRead } from '../entry.js';

/** The percent with two decimals, so 99.996 never reads as a round 100. */
const percent = rate => `${(Math.floor(rate * 10000) / 100).toFixed(2)}%`;

/**
 * Run `pullboard rules [--limit <N>]` and return its exit code.
 * Why read-only: the trial only compares what the rules say with what the board recorded; a rule that is wrong must never change the board.
 * The summary prints first, then each disagreement with its event id; `--limit` prints only the first N of them.
 */
export function run(io, { first, values = {} }) {
  if (first !== undefined) throw new Refused('USAGE', 'rules takes no argument', 'pullboard rules [--limit <N>] [--json]');
  const limit = values.limit === undefined ? Infinity : Number(values.limit);
  if (!(limit >= 0)) throw new Refused('USAGE', 'the limit is a count of disagreements to print, 0 or more', 'pullboard rules --limit 20');
  const ctx = context(io);
  const report = withBoardRead(ctx, board => {
    const { rows, items } = readLifecycleLog(board);
    return trial(rows.map(lifecycleFact), items);
  });
  const shown = report.disagreements.slice(0, limit);
  io.result?.({ rulesVersion: RULES_VERSION, judged: report.judged, agreed: report.agreed, rate: report.rate, disagreements: shown,
    disagreementCount: report.disagreements.length, kinds: report.kinds.map(({ kind, count, first: firstEvent, last }) => ({ kind, count, first: firstEvent, last })), final: { compared: report.final.compared, agreed: report.final.agreed, rate: report.final.rate, mismatches: report.final.mismatches }, readiness: report.readiness });
  io.say(`lifecycle rules v${RULES_VERSION} agree with ${report.agreed} of ${report.judged} recorded moves (${percent(report.rate)}); ${report.disagreements.length} disagree`);
  io.say(`final state: ${report.final.agreed} of ${report.final.compared} items match the board (${percent(report.final.rate)})`);
  io.say(`ready by the rules: ${report.readiness.ready} of ${report.readiness.open} open items (${report.readiness.blocked} blocked, ${report.readiness.held} held)`);
  if (report.kinds.length) io.say('disagreements by kind:');
  for (const group of report.kinds) io.say(`  ${String(group.count).padStart(6)}  ${group.kind}  (events ${group.first} to ${group.last})`);
  if (report.final.mismatches.length) io.say('final-state mismatches:');
  for (const mismatch of report.final.mismatches.slice(0, limit)) io.say(`  #${mismatch.item}  ${mismatch.kind}  (last event ${mismatch.lastEvent ?? 'none'})`);
  if (shown.length) io.say('disagreements:');
  for (const entry of shown) io.say(`  event ${entry.event}  #${entry.item}  ${entry.by}  ${entry.kind}: ${entry.why}`);
  if (shown.length < report.disagreements.length) io.say(`  ... ${report.disagreements.length - shown.length} more; omit --limit to list them all`);
  return 0;
}
