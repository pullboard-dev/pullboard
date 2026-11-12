/** A fresh board's check baseline finishes on the local runner, so a check that already passes holds the item [V2,H16,C7,#6560]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { join } from 'node:path';
import { getItem } from '../../../../packages/store/index.js';
import { HOST } from '../../tests/fixtures/runner/ssh.js';
import { BOARD_FILE } from '../../tests/fixtures/check-baseline.js';
import { cleanupFixtures } from '../../tests/fixtures/check-baseline.js';
import { fileCheck } from '../../tests/fixtures/check-baseline.js';
import { project } from '../../tests/fixtures/check-baseline.js';
import { withBoard } from '../../tests/fixtures/check-baseline.js';

after(cleanupFixtures);

test('clauses 1 and 2: with the local runner live the baseline records within 60 s and next refuses CRITERION_PROVES_NOTHING [V2,H16,#6560]', { timeout: 150_000 }, async t => {
  const box = project({ content: 'committed', hold: true, worktrees: true });
  // Process-level: a real local runner process pulls the job over loopback; with no registered runner it is the baseline's only host.
  assert.equal((await box.runLocal(box.repo, ['runner', 'remove', HOST, '--json'])).status, 0, 'the fixture runner is removed');
  t.after(() => box.runLocal(box.repo, ['runner', 'local', '--off']));
  const added = await box.runLocal(box.repo, ['add', 'web', 'Fresh board baseline', '--specs', 'G1', '--criterion', 'the check is measured on main',
    '--check', fileCheck('committed'), '--wait', '--json']);
  assert.equal(added.status, 0, `${added.stdout}${added.stderr}`);
  const item = JSON.parse(added.stdout).item;
  const recorded = withBoard(join(box.repo, BOARD_FILE), board => getItem(board, item.item_id).item_check_baseline);
  assert.equal(recorded.result, 'green');
  assert.equal(recorded.warning, 'CRITERION_PROVES_NOTHING');
  const next = await box.runLocal(box.web, ['next', '--json']);
  assert.equal(next.status, 1, `${next.stdout}${next.stderr}`);
  assert.equal(JSON.parse(next.stdout).error.code, 'CRITERION_PROVES_NOTHING', 'next refuses an item whose check already passes on main');
});
