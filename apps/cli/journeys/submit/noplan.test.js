/** A private generic Git project can submit without provisioning a cells inventory [C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

test('submit skips cells inventory for an accepted private tree without a cells plan [C7]', async t => {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const added = (await fixtureAdd(box.runLocal, box.repo, 'web', 'Generic private project change', '--specs', 'G1', '--json'));
  assert.equal(added.code, 0, added.out + added.err);
  const id = JSON.parse(added.out).item.item_id;
  const claimed = (await box.runLocal(box.web, 'claim', String(id)));
  assert.equal(claimed.code, 0, claimed.out + claimed.err);

  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/page.js'), "export const page = 'generic';\n");
  box.git(box.web, 'add', 'web/page.js');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): update generic project [G1]');
  const acceptedMain = box.git(box.repo, 'rev-parse', 'main');
  assert.equal(box.git(box.repo, 'ls-tree', '--name-only', acceptedMain, '--', 'packages/codemap/data/plan/cells.json'), '',
    'the accepted private Git tree has no cells plan');

  const submitted = (await box.runLocal(box.web, 'submit', String(id), '--wait', '--no-next'));
  assert.equal(submitted.code, 0, `${submitted.out}\n${submitted.err}`);
  assert.doesNotMatch(`${submitted.out}\n${submitted.err}`, /CELLS_INVENTORY_PENDING/u);
  assert.equal(existsSync(join(box.env.PULLBOARD_MACHINE_HOME, 'cells-cache', 'accepted')), false,
    'submit neither built nor queued accepted-tree inventory provisioning');
});
