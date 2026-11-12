/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  PAIRED_RERUN_FIXTURE,
  runPairedRerun,
  test,
} from '../../../tests/fixtures/scenarios/runners.js';

test('a red on a registered runner gets its paired rerun and ledger entry, or stays unclassified without the host load [C7]', { timeout: 300_000 }, async t => {
  for (const mode of ['remote-load', 'no-load', 'paired-no-load']) {
    await t.test(mode, child => runPairedRerun(child, mode, PAIRED_RERUN_FIXTURE));
  }
});
