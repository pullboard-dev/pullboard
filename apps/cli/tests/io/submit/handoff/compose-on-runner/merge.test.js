/** With submit.composeOnRunner on, the submit command merges neither main nor trunk and sends the unmerged head to the gate job; off, it merges as before [C7,#10756]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { jobsOf } from '../../../../../../../packages/jobs/index.js';
import { runSubmit } from '../../../../fixtures/submit/compose-on-runner.js';

const RUNS = new Map();
const CLEANUPS = [];
const runKey = ({ on, declared = false }) => `${on}:${declared}`;

after(async () => { for (const cleanup of CLEANUPS.reverse()) await cleanup(); });

/**
 * The two merge scenarios of this file, started side by side by the first test that asks and cached for the rest: one real
 * submit takes 30 to 60 s on a loaded runner, and two in a row passed the per-file budget [C7,#10757]. Their fixtures are
 * removed once, after the last test of the file, so a later test still reads the folder an earlier one started.
 */
async function submitted(_t, wanted) {
  if (!RUNS.size) {
    const shared = { after: (cleanup) => CLEANUPS.push(cleanup) };
    for (const scenario of [{ on: true }, { on: false }]) RUNS.set(runKey(scenario), runSubmit(shared, scenario, { jobsOf }));
    await Promise.allSettled([...RUNS.values()]);
  }
  return RUNS.get(runKey(wanted));
}

test('cli.io-submit-handoff-compose-on-runner.with-the-setting-on-submit-merges: clause 1: with submit.composeOnRunner on, submit runs no main merge, compose or trunk merge and queues the unmerged head [C7,#10756]', async t => {
  const { folder, git, head, main, id, result, row } = await submitted(t, { on: true });
  assert.equal(row.candidate, head, 'the gate job carries the head, not a composition');
  assert.equal(git(folder, 'rev-parse', 'HEAD'), head, 'HEAD did not move');
  assert.equal(git(folder, 'rev-list', '--merges', head), '', 'the branch got no merge commit');
  assert.equal(git(folder, 'for-each-ref', 'refs/pullboard/compose'), '', 'no compose ref was written');
  assert.doesNotMatch(result.out, /Composed main|Merged main/u, 'the command printed no merge line');
  assert.notEqual(main, head);
  assert.ok(id);
});

test('cli.io-submit-handoff-compose-on-runner.with-the-setting-off-submit-merges-as: clause 2: with submit.composeOnRunner off, submit still merges main into the builder source as before [C7,#10756]', async t => {
  const { git, folder, head, main, result, row } = await submitted(t, { on: false });
  assert.notEqual(row.candidate, head, 'the gate job carries the merged commit');
  assert.equal(git(folder, 'show', '-s', '--format=%P', row.candidate), `${head} ${main}`, 'parents are head then main');
  assert.match(result.out, /Merged main .* into the builder source/u);
});
