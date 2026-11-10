import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import { json } from '../../../tests/fixtures/land/board.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject, submitItem, acceptItem } = makeLandProjectFixtures(e2e);

/** Add, join and claim one item whose check is the fixture's own single-file runner. */
function item(box, number) {
  const file = `web/land-${number}.test.js`;
  const path = join(box.dir, `land-${number}`);
  box.git(box.repo, 'worktree', 'add', '-q', '-b', `web/land-${number}`, path, 'main');
  assert.equal(fixtureJoin(box.run, path, 'web', '--model', 'Fixture Model', '--route', 'strong').code, 0);
  const added = fixtureAdd(box.run, box.repo, 'web', `Land fixture ${number}`, '--specs', 'G1', '--criterion', `land fixture ${number} remains valid`, '--route', 'strong',
    '--check', `${box.affected} ${file}`, '--json');
  assert.equal(added.code, 0, added.out + added.err);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal(box.run(path, 'claim', String(id)).code, 0);
  return { path, item: id, file };
}

/** Commit accepted trunk policy naming the items the lander takes first. */
function landFirst(box, ids) {
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(box.git(box.repo, 'show', 'HEAD:pullboard.json'));
  config.landing.first = ids;
  config.landing.perItem = true; // one item per run, so the order shows across two runs
  writeFileSync(path, JSON.stringify(config, null, 2));
  box.git(box.repo, 'commit', '-q', '-am', 'chore: land the named items first');
}

/** Point the repository at hooks whose commit-msg refuses every commit, as a strict project hook would on a merge. */
function refuseEveryCommit(box) {
  const hooks = join(box.dir, 'refusing-hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'commit-msg'), '#!/bin/sh\necho "commit-msg refuses every commit" >&2\nexit 1\n');
  chmodSync(join(hooks, 'commit-msg'), 0o755);
  box.git(box.repo, 'config', 'core.hooksPath', hooks);
}

test('landing.first in accepted trunk policy lands the named item ahead of the accept order, then the order resumes [C7]', { timeout: 300_000 }, // budget: two real submits, accepts and two landings; hang ceiling only.
() => {
  const box = landProject();
  const first = item(box, 1), second = item(box, 2);
  submitItem(box, first);
  submitItem(box, second);
  acceptItem(box, second); // accepted first: the accept order alone would land it first
  acceptItem(box, first);
  landFirst(box, [first.item, 999999]); // an unknown id is ignored
  refuseEveryCommit(box);

  const one = box.run(box.repo, 'land', '--json');
  assert.equal(one.code, 0, one.out + one.err);
  assert.deepEqual(JSON.parse(one.out).landed, [first.item], 'the named item lands ahead of the earlier-accepted one');
  assert.equal(json(box, box.repo, 'show', String(second.item)).item_merged_commit, null);

  const two = box.run(box.repo, 'land', '--json');
  assert.equal(two.code, 0, two.out + two.err);
  assert.deepEqual(JSON.parse(two.out).landed, [second.item], 'the accept order resumes after the named items');
});
