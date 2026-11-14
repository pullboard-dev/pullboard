/** A one-item landing batch times its merge, static checks and CLI smoke as landing phases [C7,B3]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { settleLand } from '../../tests/fixtures/land/settle.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject, itemWorktreeLocal, commitItemLocal, submitItemLocal, acceptItemLocal } = makeLandProjectFixtures(e2e);

test('clause 1, clause 2: a one-item batch lands with merge, static checks and CLI smoke each said and recorded as a landing phase [C7,B3]', { timeout: 300_000 }, // budget: one real submit, accept and landing; hang ceiling only, no speed threshold.
async () => {
  const box = landProject();
  // The project's own landing publishes to the trunk; that is the path that runs the static checks beside the gate.
  const config = join(box.repo, 'pullboard.json');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), landing: { perItem: false, manualOverride: true, publish: 'separate' }, staticChecks: 'node -e 0' }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: land on the trunk');
  const entry = await itemWorktreeLocal(box, 1, 'web/land-1.test.js');
  await commitItemLocal(box, entry, 'PASS\n');
  await submitItemLocal(box, entry);
  await acceptItemLocal(box, entry);
  // The acceptance proof is for the old main; a real later change makes the batch run its landing guards.
  writeFileSync(join(box.repo, 'main-advance.txt'), 'main changed after acceptance\n');
  box.git(box.repo, 'add', 'main-advance.txt');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: advance main before landing');
  const landed = await box.runLocal(box.repo, 'land', '--json');
  assert.equal(landed.code, 0, `${landed.err}\n${landed.out}`);
  // Under pull the land job is the landing: its receipt records each timed phase in the order it ran [P7,C7].
  const { receipt } = (await settleLand(box, JSON.parse(landed.out))).landJob;
  assert.equal(receipt.outcome, 'landed', JSON.stringify(receipt));
  const recorded = new Map((receipt.phases ?? []).map(row => [row.phase, row.ms]));
  const all = (receipt.phases ?? []).map(row => `${row.phase}:${row.ms}`).join(', ');
  console.log(`# landing phases: ${all}`);
  for (const name of ['merge', 'static checks', 'cli smoke']) {
    assert.ok(recorded.has(name), `the land receipt recorded no "${name}" phase; recorded: ${all}`);
    assert.ok(Number.isSafeInteger(recorded.get(name)) && recorded.get(name) >= 0, `phase ${name} has no millisecond time: ${recorded.get(name)}`);
  }
});
