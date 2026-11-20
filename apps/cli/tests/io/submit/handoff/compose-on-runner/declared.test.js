/** With submit.composeOnRunner on and a stale declared generated file, submit regenerates nothing; off, it regenerates as before [C7,#10757]. */
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
 * The two declared-file scenarios of this file, started side by side by the first test that asks and cached for the rest: one real
 * submit takes 30 to 60 s on a loaded runner, and two in a row passed the per-file budget [C7,#10757]. Their fixtures are
 * removed once, after the last test of the file, so a later test still reads the folder an earlier one started.
 */
async function submitted(_t, wanted) {
  if (!RUNS.size) {
    const shared = { after: (cleanup) => CLEANUPS.push(cleanup) };
    for (const scenario of [{ on: true, declared: true }, { on: false, declared: true }]) RUNS.set(runKey(scenario), runSubmit(shared, scenario, { jobsOf }));
    await Promise.allSettled([...RUNS.values()]);
  }
  return RUNS.get(runKey(wanted));
}

test('cli.io-submit-handoff-compose-on-runner.on-a-stale-declared-file-no-regeneration: clause 1: with submit.composeOnRunner on and submit.regenerateDeclared on, a submit whose declared generated file is stale does not regenerate it and sends the builder head unchanged [C7,#10757]', async t => {
  const { folder, git, head, result, row } = await submitted(t, { on: true, declared: true });
  assert.equal(row.candidate, head, 'the gate job carries the builder head');
  assert.equal(git(folder, 'rev-parse', 'HEAD'), head, 'HEAD did not move');
  assert.equal(git(folder, 'show', `${head}:gen/out.txt`), 'one', 'the stale output is left for the runner');
  assert.doesNotMatch(result.out, /Regenerated gen\/out\.txt/u, 'the command printed no regeneration line');
});

test('cli.io-submit-handoff-compose-on-runner.off-a-stale-declared-file-regenerates: clause 2: with submit.composeOnRunner off on the same fixture, submit still regenerates the declared file and sends the regenerated head [C7,#10757]', async t => {
  const { git, folder, head, result, row } = await submitted(t, { on: false, declared: true });
  assert.notEqual(row.candidate, head, 'the gate job carries a new head');
  assert.equal(git(folder, 'show', `${row.candidate}:gen/out.txt`), 'two', 'the regenerated output is committed');
  assert.match(result.out, /Regenerated gen\/out\.txt from its declared generator/u);
});
