/** Submit runs the move registry guard and refuses a missing credential by name, driven through the real CLI [C7,V4,V16]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { commit } from '../../tests/fixtures/guards.js';
import { e2e } from '../../tests/fixtures/guards.js';
import { put } from '../../tests/fixtures/guards.js';
import { registryBox } from '../../tests/fixtures/guards.js';

after(e2e.cleanup);

test('cli.journeys-submit-guards.submit-runs-the-move-registry-guard: submit runs the move registry guard for an item that adds a move and refuses it by name when the credential is missing [C7,V4,V16]', async () => {
  const box = (await registryBox());
  put(box.web, 'src/moves/newMove.js', 'export const operation = "newMove";\n');
  // An unrelated source change makes the normal import selection exceed its submit budget.
  put(box.web, 'src/other.js', 'export const other = 1;\n');
  for (const number of [1, 2]) put(box.web, `web/other${number}.test.js`,
    "import { other } from '../src/other.js';\nimport { test } from 'node:test';\ntest('other works [G1]', () => {});\n");
  commit(box, box.web, 'feat(core): add fixture move [G1]');
  // A pulled submit queues its gate and returns; the fixture command returns once the local runner settled it, so show reads the verdict [C7].
  const submitted = (await box.runLocal(box.web, 'submit', String(box.id)));
  assert.equal(submitted.code, 0, submitted.err + submitted.out);
  const red = JSON.parse((await box.runLocal(box.web, 'show', String(box.id), '--json', '--no-next')).out).gateJob;
  assert.equal(red?.gate?.green, false, 'a green item check cannot defer a touched registry guard: ' + JSON.stringify(red));
  assert.match(JSON.stringify(red), /apps\/cli\/journeys\/relay\/credential\.test\.js/u, 'the red gate names the guard');
  assert.match(JSON.stringify(red), /missing actor credential for newMove\.js/u, 'the red gate retains the missing entry');
  const state = (await box.runLocal(box.web, 'show', String(box.id), '--json'));
  assert.equal(state.code, 0, state.err);
  assert.equal(JSON.parse(state.out).item_status, 'claimed', 'the rejected proof records no submission');

  // A real repair passes, and its native submission retains the guard among the files actually proved.
  const guard = join(box.web, 'apps/cli/journeys/relay/credential.test.js');
  writeFileSync(guard, readFileSync(guard, 'utf8').replace("['known.js']", "['known.js', 'newMove.js']"));
  commit(box, box.web, 'fix(core): map the fixture actor [G1]');
  // --wait ends at the gate verdict, so the submit event is recorded before the export reads it [C7].
  const repaired = (await box.runLocal(box.web, 'submit', String(box.id), '--wait'));
  assert.equal(repaired.code, 0, repaired.err + repaired.out);
  const exported = (await box.runLocal(box.web, 'export', '--json'));
  assert.equal(exported.code, 0, exported.err);
  const event = JSON.parse(exported.out).tables.event.findLast(row => row.event_kind === 'submit');
  assert.ok(event, 'the repaired submit recorded its event: ' + repaired.out + JSON.parse(exported.out).tables.event.map(row => row.event_kind).join(','));
  assert.ok(JSON.parse(event.event_detail).submissionProof.files.includes('apps/cli/journeys/relay/credential.test.js'));
});
