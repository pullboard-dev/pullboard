/** A main audit's new failure is filed to the lane of the items that landed since the last green audit [C7]. */
import { join } from 'node:path';
import { itemsBetween } from './commits.js';
import { readMainAudit } from './state.js';

const COORDINATOR_LANE = 'coordinator';

/**
 * The deterministic title of the repair for one failing test at one audited tip.
 *
 * Why: the title is the dedupe key on the board, so a resumed or repeated audit never files twice.
 */
export function auditRegressionTitle(test, tip) {
  return `Main audit red: ${test} at ${tip.slice(0, 12)}`;
}

/**
 * Attribute each failing test that passed in the last green audit to the items landed between the two tips.
 *
 * Why: a test the last green audit ran and passed was broken by something in last-green..tip, and the
 * `Pullboard-Item: #N` trailers in that range name what landed, however main moved.
 * A test the last green audit never ran is not attributed: no green run proves it once passed.
 * @returns {{test: string, names: string[], greenTip: string, tip: string, items: {id: number, lane: string}[], lane: string}[]}
 */
export function attributeAuditFailures({ git, store }, root, board, directory, job, failures) {
  const last = readMainAudit(join(directory, 'last-green.json'));
  if (!last?.complete || !last.green || typeof last.tip !== 'string' || last.tip === job.tip) return [];
  try { git(root, ['merge-base', '--is-ancestor', last.tip, job.tip]); } catch { return []; }
  const passed = new Set(Object.keys(last.keys ?? {}));
  const items = itemsBetween(git, root, board, store, last.tip, job.tip);
  const lanes = [...new Set(items.map(item => item.lane))];
  // One lane owns the repair: the newest landed item's, or the coordinator's for a bare hotfix.
  const lane = lanes[0] ?? COORDINATOR_LANE;
  const tests = [...new Set(failures.map(failure => failure.file))].filter(test => passed.has(test));
  return tests.map(test => ({ test, greenTip: last.tip, tip: job.tip, items, lane,
    names: [...new Set(failures.filter(failure => failure.file === test).map(failure => failure.name))] }));
}

/**
 * One sentence naming an attributed failure's test, both audit tips and its suspects.
 *
 * Why: a landed batch's repair keeps its native defect bar, and this note puts the trailer attribution on it.
 */
export function auditRegressionNote({ test, greenTip, tip, items }) {
  const suspects = items.length ? items.map(item => `#${item.id} (${item.lane})`).join(', ') : 'none: no Pullboard-Item trailer';
  return `Main audit regression: ${test} passed in the last green audit at ${greenTip} and failed at ${tip}. Items landed between the two tips: ${suspects}.`;
}

/**
 * The new item for one attributed failure: three numbered clauses, thirty minutes.
 *
 * Why: the receiving lane needs the test, both tips and the suspects on the bar, with no other context.
 */
function regressionItem(regression) {
  const { test, names, greenTip, tip, items, lane } = regression;
  const suspects = items.length ? items.map(item => `#${item.id} (${item.lane})`).join(', ') : 'none: a bare commit with no Pullboard-Item trailer';
  return { by: 'coordinator', lane, title: auditRegressionTitle(test, tip), route: 'strong', specIds: [], parentId: null, after: [],
    expectedBuildMinutes: 30,
    criterion: `${test} failed in the main audit at ${tip} and passed in the last green audit at ${greenTip}. `
      + `Items landed between the two tips: ${suspects}. Failing cases: ${names.join('; ').slice(0, 1000)}. `
      + `1. ${test} passes at main. [test] 2. The change that broke it keeps its intent or is reverted with a note on its item. [reasoning] `
      + '3. No other case in that test file changes its result. [test]',
    brief: `Files: ${test}\nSource: main audit ${greenTip.slice(0, 12)}..${tip.slice(0, 12)}` };
}

/**
 * File one repair per attributed failure, skipping any test already filed for the same audited tip.
 *
 * Why: an audit resumes after a crash and reruns routing; the board, never a side file, says what was filed.
 * @param {{git: Function, store: object, read: Function, write: Function}} services `read(action)` opens the board
 *   for reading; `write(operation, args)` runs an ordered board move.
 * @returns {Promise<{test: string, item: number, filed: boolean, lane: string}[]>}
 */
export async function fileAuditRegressions({ git, store, read, write }, root, directory, job, failures) {
  const regressions = read(board => attributeAuditFailures({ git, store }, root, board, directory, job, failures));
  const results = [];
  for (const regression of regressions) {
    const title = auditRegressionTitle(regression.test, regression.tip);
    const existing = read(board => board.db.prepare('SELECT item_id FROM item WHERE item_title=? AND instr(item_criterion, ?) > 0 ORDER BY item_id LIMIT 1')
      .get(title, regression.tip));
    if (existing) { results.push({ test: regression.test, item: existing.item_id, filed: false, lane: regression.lane }); continue; }
    const item = await write('addItem', [regressionItem(regression)]);
    results.push({ test: regression.test, item, filed: true, lane: regression.lane });
  }
  return results;
}
