/** Temporary driver for the pilot study; removed before submit (#8058). */
import { test } from 'node:test';
import { runLeg } from './pilot.js';

test('pilot baseline: unmutated runtimes, three runs of each version [C7]', { timeout: 900_000 }, () => {
  const runs = { real: [], inprocess: [], contract: [], parity: [] };
  for (let round = 0; round < 3; round++) for (const leg of Object.keys(runs)) {
    const ran = runLeg(leg);
    runs[leg].push(ran.ms);
    if (!ran.passed) throw new Error(`unmutated ${leg} failed on round ${round}`);
  }
  console.log(`PILOT_RESULT ${JSON.stringify({ baseline: runs })}`);
});
