/** Lander v2 L1: judge each red file of a composition, so a red never holds the trunk [C7,#5862]. */
import * as store from '../../../../store/index.js';
import { completeGate } from '../completion.js';
import { judgeReds } from '../../logic/judge.js';
import { openQuarantines } from '../../logic/judge.js';
import { quarantineRecords } from '../../logic/judge.js';
import { testHash } from './selection.js';
import { save } from './merge.js';

/**
 * Judge a complete red gate: cases base main fails the same way are charged to main (the #5838 split), the rest rerun
 * once, and a file green the second time is quarantined with a repair item. Returns `{ gate, red }`: `gate` is a
 * known-main proof when nothing is left red, else null, and `red` the cases that failed twice, which their item carries
 * back. Null when the gate cannot be judged (green, incomplete, or a failure without a file).
 * The caller passes `split`, `rerun` and `repair` (diagnose.js's splitBaseRed, diagnose and fileRepairItems), so this
 * file never reaches the CLI through diagnose.js.
 * Why: LAND_TEST_DEFECT and LAND_FLAKE held the whole trunk for reds no item caused (11 Nov 8:19 pm CT batch) [C7,#5862].
 */
export async function judgeRed(state, gate, { split, rerun, repair, batches = () => store.landingBatches(state.board) } = {}) {
  if (gate.isGreen || gate.requiresGreen || gate.knownMainProof || !gate.failures?.length) return null;
  if (gate.failures.some(failure => !failure.file) || !completeGate(gate, { allowCancelled: true })) return null;
  const account = await split(state, gate.failures);
  const known = account?.known ?? [];
  const charged = new Set(known.map(failure => JSON.stringify([failure.file, failure.name])));
  const rest = gate.failures.filter(failure => !charged.has(JSON.stringify([failure.file, failure.name])));
  const rerunGreen = rest.length ? await rerun(state, rest, gate) : [];
  const now = state.board.clock.now();
  const judged = judgeReds(gate.failures, known, rerunGreen, openQuarantines(batches(), now));
  const knownMain = judged.main.map(({ file, name }) => ({ file, name }));
  if (judged.red.length) {
    if (knownMain.length) await save(state, { knownMain: [...(state.batch.knownMain ?? []), ...knownMain] });
    return { gate: null, red: judged.red, main: knownMain };
  }
  const repairs = judged.flaky.length ? await repair(state, judged.flaky) : [];
  const quarantine = quarantineRecords(judged.flaky, { now, inputKey: file => testHash(state.batch.root, file),
    repair: file => repairs.find(defect => defect.test === file)?.item ?? null });
  await save(state, { knownMain: [...(state.batch.knownMain ?? []), ...knownMain], quarantine: [...(state.batch.quarantine ?? []), ...quarantine] });
  state.say(`reds judged: ${knownMain.length} case(s) charged to main, ${quarantine.length} file(s) quarantined after a green rerun${quarantine.length ? ` (${quarantine.map(record => record.file).join(', ')})` : ''}; this composition adds no red`);
  return { gate: { ...gate, knownMainProof: { tree: gate.tree, failures: [], knownMain, quarantine, logPath: gate.logPath } }, red: [], main: knownMain };
}
