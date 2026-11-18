/** The loopback runner's receipt names the job's kept folder and the timing profiles in it, and the stand-in gate writes them [C7,#7301]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PROFILED_CHECK } from './pull.js';
import { loopbackRunner } from './pull.js';
import { pullProject } from './pull.js';
import { submitOne } from './pull.js';

/** One item submitted under pull with the profiled check, taken and run by the loopback runner. */
async function ranJob(t) {
  const box = await pullProject(t, 1, { check: () => PROFILED_CHECK });
  const [id] = box.ids;
  submitOne(box, id);
  const runner = await loopbackRunner(t, box);
  return runner.run(await runner.take('runner-profiles'));
}

test('cli.pull-profiles.receipt-names-folder-and-profiles: clause 1: the loopback runner posts a receipt whose output.folder is the job checkout and whose check and proof rows carry profileKept [C7,#7301]', async t => {
  const result = await ranJob(t);
  assert.equal(result.receipt.output.folder, result.folder);
  assert.equal(result.receipt.output.runner, 'runner-profiles');
  const kept = Object.fromEntries(result.receipt.gate.phases.map(phase => [phase.role, phase.profileKept]));
  assert.deepEqual(kept, { check: 'check.log.profile.json', proof: 'proof.log.profile.json' });
});

test('cli.pull-profiles.stand-in-writes-beside-log: clause 2: the stand-in gate writes a check timing profile and an ACCEPT timing profile beside each sanitized log [C7,#7301]', async t => {
  const result = await ranJob(t);
  for (const role of ['check', 'proof']) {
    assert.ok(existsSync(join(result.folder, `${role}.log`)), `${role}.log is kept in the job folder`);
    const profile = JSON.parse(readFileSync(join(result.folder, `${role}.log.profile.json`), 'utf8'));
    assert.equal(profile.phase, role);
  }
});
