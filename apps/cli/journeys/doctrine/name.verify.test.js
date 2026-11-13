/** Verify in a detached checkout reads the trunk baseline for a doctrine frozen check [D4,A5]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';
import { settleSubmit } from '../../tests/fixtures/submit/settle.js';
import {
  BIN,
  DOCTRINE,
  renamedDoctrineFixture,
  sandbox,
  shellWord,
} from '../../tests/fixtures/doctrine-name.js';

test('[D4,A5] verify in a detached checkout reads the trunk baseline for a doctrine frozen check', async function verifyDoctrineFrozenCheck(t) {
  const box = sandbox();
  const source = renamedDoctrineFixture(box, 'verify-doctrine-source');
  const initialized = await box.inProcess(source, 'init');
  assert.equal(initialized.status, 0, `${initialized.stdout}${initialized.stderr}`);
  const configPath = join(source, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...config, gate: 'true', verify: 'coordinator', landing: { manualOverride: true },
    lanes: { web: { owns: ['web/'], specs: [] } }, shared: [] }, null, 2) + '\n');
  box.git(source, 'add', '-A');
  box.git(source, 'commit', '-q', '-m', 'chore: initialize doctrine verification fixture');
  const check = `out=$(${shellWord(process.execPath)} ${shellWord(BIN)} spec check 2>&1) && printf '%s\\n' "$out" | grep -Eq 'DOCTRINE[.]md: .*0 errors'`;
  const added = await fixtureAdd(box.inProcess, source, 'web', 'Doctrine review fixture', '--criterion', 'The frozen doctrine check passes in the verifier clone.', '--check', check, '--json');
  assert.equal(added.status, 0, `${added.stdout}${added.stderr}`);
  const id = JSON.parse(added.stdout).item.item_id;
  const builder = join(box.dir, 'verify-doctrine-builder');
  box.git(source, 'worktree', 'add', '-q', '-b', 'web/doctrine-review', builder);
  assert.equal((await fixtureJoin(box.inProcess, builder, 'web', '--route', 'strong')).status, 0);
  // This doctrine check already passes on main by design; the person accepts it so the new board's hold lifts.
  assert.equal((await box.inProcess(source, 'check', 'accept', String(id))).status, 0);
  assert.equal((await box.inProcess(builder, 'claim', String(id))).status, 0);
  mkdirSync(join(builder, 'web'));
  writeFileSync(join(builder, 'web/candidate.txt'), 'doctrine verification fixture\n');
  box.git(builder, 'add', 'web/candidate.txt');
  box.git(builder, 'commit', '-q', '-m', 'feat(web): build doctrine verification fixture [G1]');
  const submitted = await box.inProcess(builder, 'submit', String(id), '--json');
  assert.equal(submitted.status, 0, `${submitted.stdout}${submitted.stderr}`);
  // A pulled submit returns queued; wait for the local runner's gate receipt so the item is submitted before the verify [P7,C7].
  const run = async (cwd, ...args) => { const ran = await box.inProcess(cwd, ...args); return { code: ran.status, out: ran.stdout, err: ran.stderr }; };
  const settled = await settleSubmit(t, { repo: builder, env: box.env, run }, JSON.parse(submitted.stdout));
  const commit = settled.commit;
  box.git(source, 'switch', '-q', '--detach', commit);
  const accepted = await box.inProcess(source, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'The exact private frozen doctrine check passed.', '--json');
  assert.equal(accepted.status, 0, `${accepted.stdout}${accepted.stderr}`);
  const result = JSON.parse(accepted.stdout);
  assert.equal(result.decision, 'ACCEPT');
  assert.equal(result.check, 'green', 'the real verifier records that the frozen doctrine check ran and passed');
  const shown = await box.inProcess(source, 'show', String(id), '--json');
  assert.equal(shown.status, 0, `${shown.stdout}${shown.stderr}`);
  assert.equal(JSON.parse(shown.stdout).item_status, 'verified');
});
