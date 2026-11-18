/** A pulled gate runs its proof with pipefail, as the controller's gate does: a red early stage of a pipe stays red [V16,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loopbackRunner } from '../../tests/fixtures/pull.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';
import { TOOLING } from '../../tests/fixtures/pull.js';

test('cli.journeys-gate-piped-pull.a-pulled-gate-of-a-piped: a pulled gate of a piped command settles red on the runner when an early stage fails [V16,C7]', async t => {
  // The stand-in gate plan names the piped gate as its proof, so the runner's own entry runs it as the repo gate.
  const plan = TOOLING['packages/gate/index.js'].replace("proofCommand: 'node bin/proof.js ./web'", `proofCommand: ${JSON.stringify('sh -c "exit 7" | tail -1')}`);
  assert.notEqual(plan, TOOLING['packages/gate/index.js'], 'the stand-in plan names the piped proof');
  const box = await pullProject(t, 1, { tooling: { 'packages/gate/index.js': plan } });
  const [id] = box.ids;
  submitOne(box, id);
  const runner = await loopbackRunner(t, box);
  const result = await runner.run(await runner.take('runner-piped'));
  const proof = result.gate.phases.find(phase => phase.role === 'proof');
  assert.ok(proof, JSON.stringify(result.gate));
  assert.notEqual(proof.status, 0, 'the failing producer leaves the proof phase red');
  assert.equal(result.gate.green, false, 'a pulled piped gate never settles green');
});
