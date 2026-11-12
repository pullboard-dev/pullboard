/** A check baseline reads committed main and survives a later main commit [V2,H3,H16]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import {
  checkBaseline,
  prepareCheckBaseline,
} from '../../../../packages/gate/index.js';
import {
  project,
  fileCheck,
  addChecked,
  showItem,
  heldCheck,
  cleanupFixtures,
} from '../../tests/fixtures/check-baseline.js';

after(cleanupFixtures);

test('[V2,H16] --wait keeps the check blocking and the captured base survives a later main commit', (t) => {
  const box = project({ content: 'original' });
  const held = heldCheck(box, 'wait-background');
  t.after(() => writeFileSync(held.release, 'release'));
  const waited = box.run(box.repo, ['add', 'web', 'Wait for check', '--check', held.command, '--wait', '--json']);
  assert.equal(waited.status, 0, `${waited.stdout}${waited.stderr}`);
  assert.equal(existsSync(held.finished), true, '--wait returns only after the held check finishes');
  assert.equal(JSON.parse(waited.stdout).item.item_check_baseline.result, 'green');
  const command = fileCheck('original', 'captured-base-marker.txt');
  const captured = prepareCheckBaseline(box.repo, command);
  writeFileSync(join(box.repo, 'web/result.txt'), 'new main\n');
  box.git(box.repo, 'add', 'web/result.txt');
  box.git(box.repo, 'commit', '-q', '-m', 'test: change captured main fixture');
  const completed = checkBaseline(box.repo, command, { main: captured.main });
  assert.notEqual(captured.main, box.git(box.repo, 'rev-parse', 'main'));
  assert.equal(completed.main, captured.main);
  assert.equal(completed.result, 'green', 'a later main cannot change the queued observation');
  assert.equal(existsSync(join(box.repo, 'captured-base-marker.txt')), false);
});

test('[V2,H3,H16] baseline comes from committed main while manual check uses the branch', async function baselineUsesMain() {
  const box = project({ content: 'red', worktrees: true });
  const main = box.git(box.repo, 'rev-parse', 'refs/heads/main');
  writeFileSync(join(box.repo, 'web', 'result.txt'), 'green\n');
  writeFileSync(join(box.web, 'web', 'result.txt'), 'green\n');
  const before = box.git(box.repo, 'status', '--porcelain');
  const marker = 'baseline-command-ran.txt';
  const observations = join(box.dir, 'baseline-executions.txt');
  const check = fileCheck('green', marker, observations);
  const { item } = addChecked(box, 'Main baseline is red', check);
  assert.equal(item.item_check_baseline.command, check);
  assert.equal(item.item_check_baseline.main, main);
  assert.equal(item.item_check_baseline.result, 'red', 'the stored result describes committed main, not the dirty green worktree');
  assert.ok(Number.isFinite(item.item_check_baseline.seconds), 'the baseline includes its measured run time');
  assert.equal(item.item_check_baseline.warning, undefined, 'a red baseline does not say the criterion already passes');
  assert.equal(existsSync(join(box.repo, marker)), false, 'baseline execution never writes into the live main checkout');
  assert.equal(existsSync(join(box.web, marker)), false, 'baseline execution never writes into the live agent checkout');
  assert.equal(box.git(box.repo, 'status', '--porcelain'), before, 'baseline capture preserves the dirty live main checkout');
  const locations = readFileSync(observations, 'utf8').trim().split('\n');
  assert.equal(locations.length, 1, 'the newly supplied check runs exactly once');
  assert.ok(locations[0] !== box.repo && locations[0] !== box.web, 'it runs in neither live checkout');
  assert.equal(existsSync(locations[0]), false, 'the temporary checkout is removed after recording the result');

  const manual = box.run(box.web, ['check', String(item.item_id), '--yes', '--json']);
  assert.equal(manual.status, 0, `${manual.stdout}${manual.stderr}`);
  assert.equal(JSON.parse(manual.stdout).green, true, 'manual check runs against the green branch');
  assert.equal(readFileSync(join(box.web, marker), 'utf8'), 'ran');
  const after = showItem(box, item.item_id, box.web).item;
  assert.deepEqual(after.item_check_baseline, item.item_check_baseline, 'manual branch success does not rewrite the main baseline');
});
