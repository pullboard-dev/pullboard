/** Per-item landing, the default: one batch takes every clean verified item; a red batch bisects [C7,#2901,#5815]. */
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
import {
  events,
  json,
} from '../../../tests/fixtures/land/board.js';
import {
  fileFixtureItem,
  joinFixtureSeat,
} from '../../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject, submitItem, acceptItem, moveMainPastSubmit } = makeLandProjectFixtures(e2e);

/** A landing project with landing.perItem unset, so the default applies. */
function perItemProject() {
  const box = landProject();
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(box.git(box.repo, 'show', 'HEAD:pullboard.json'));
  delete config.landing.perItem;
  writeFileSync(path, JSON.stringify(config, null, 2));
  box.git(box.repo, 'commit', '-q', '-am', 'chore: per-item landing by default');
  return box;
}

/** Put a passing copy of the red item's file on main, so the landing's base-main comparison can run it [C7,#3065]. */
function establishBaseFile(box, number) {
  box.env.LAND_SUPPRESS_RED = '1';
  try { assert.equal(e2e.commitFile(box, box.repo, `web/land-${number}.test.js`, '// PASS\n', 'test(web): establish passing base case [G1]').status, 0); }
  finally { delete box.env.LAND_SUPPRESS_RED; }
}

/** Add, join and claim one item whose check is the fixture's own single-file runner. */
function item(box, number) {
  const file = `web/land-${number}.test.js`;
  const path = join(box.dir, `land-${number}`);
  box.git(box.repo, 'worktree', 'add', '-q', '-b', `web/land-${number}`, path, 'main');
  assert.equal(joinFixtureSeat(box, path, 'web').code, 0);
  const id = fileFixtureItem(box, box.repo, { lane: 'web', title: `Land fixture ${number}`,
    criterion: `land fixture ${number} remains valid`, check: `${box.affected} ${file}`, args: ['--specs', 'G1'] }).item_id;
  assert.equal(box.run(path, 'claim', String(id)).code, 0);
  return { path, item: id, file };
}

/** Point the repository at hooks whose commit-msg refuses every commit, as a strict project hook would on a merge. */
function refuseEveryCommit(box) {
  const hooks = join(box.dir, 'refusing-hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'commit-msg'), '#!/bin/sh\necho "commit-msg refuses every commit" >&2\nexit 1\n');
  chmodSync(join(hooks, 'commit-msg'), 0o755);
  box.git(box.repo, 'config', 'core.hooksPath', hooks);
}

/** Run one plain land and return its JSON result; `code` is 1 when nothing landed and a culprit came back [C7,#4265]. */
function land(box, code = 0) {
  const result = box.run(box.repo, 'land', '--json');
  assert.equal(result.code, code, result.out + result.err);
  return JSON.parse(result.out);
}

test('clause 1: one landing batch lands all three verified items that merge cleanly, hooks off, each recorded merged [C7,#2901,#5815]', { timeout: 300_000 }, // budget: three real submits, accepts and one landing; hang ceiling only.
() => {
  const box = perItemProject();
  const first = item(box, 1), second = item(box, 2), third = item(box, 3);
  for (const entry of [first, second, third]) submitItem(box, entry);
  acceptItem(box, second); // accepted first, so it merges first
  acceptItem(box, first);
  acceptItem(box, third);
  refuseEveryCommit(box);
  const start = box.git(box.repo, 'rev-parse', 'main');

  const one = land(box);
  assert.deepEqual(one.landed, [second.item, first.item, third.item], 'one run lands every clean item in accept order');
  assert.equal(one.batch.items.length, 3, 'all three ride one batch');
  const tip = box.git(box.repo, 'rev-parse', 'main');
  assert.notEqual(tip, start, 'main fast-forwarded to the batch');
  for (const entry of [first, second, third]) {
    const merged = json(box, box.repo, 'show', String(entry.item)).item_merged_commit;
    assert.ok(merged, `#${entry.item} is recorded merged`);
    assert.equal(box.git(box.repo, 'merge-base', '--is-ancestor', entry.commit, tip), '', `#${entry.item}'s reviewed commit is on main`);
  }
  assert.equal(box.git(box.repo, 'ls-remote', 'origin', 'main').split(/\s+/u)[0], tip, 'the published main is the landed tip');
});

test('clause 2: a red batch isolates its culprit and lands the rest in the same run [C7,#2901,#5815]', { timeout: 300_000 }, // budget: two real submits, accepts and one bisected landing; hang ceiling only.
() => {
  const box = perItemProject();
  establishBaseFile(box, 1);
  const red = item(box, 1), green = item(box, 2);
  box.env.LAND_SUPPRESS_RED = '1';
  try { submitItem(box, red, 'RED\n'); submitItem(box, green); } finally { delete box.env.LAND_SUPPRESS_RED; }
  acceptItem(box, red);
  acceptItem(box, green);
  moveMainPastSubmit(box); // the red submit was recorded green with its red suppressed; main moves so landing runs its own gate [C7]
  const start = box.git(box.repo, 'rev-parse', 'main');

  const one = land(box);
  assert.deepEqual(one.landed, [green.item], 'the green item lands in the same run');
  assert.deepEqual(one.culprits.map(entry => entry.id), [red.item], 'the bisection names the red item');
  const tip = box.git(box.repo, 'rev-parse', 'main');
  assert.notEqual(tip, start);
  assert.ok(json(box, box.repo, 'show', String(green.item)).item_merged_commit, 'the green item is recorded merged');
  assert.equal(json(box, box.repo, 'show', String(red.item)).item_merged_commit, null, 'nothing red reaches main');
  assert.match(JSON.stringify(json(box, box.repo, 'show', String(red.item))), /land-1\.test\.js/u, 'the red item carries evidence naming the failing file');
});

test('two land runs on an unchanged board never record the same stop twice [C7,#2901]', { timeout: 300_000 }, // budget: one real submit, accept and three landings; hang ceiling only.
() => {
  const box = perItemProject();
  establishBaseFile(box, 1);
  const red = item(box, 1);
  box.env.LAND_SUPPRESS_RED = '1';
  try { submitItem(box, red, 'RED\n'); } finally { delete box.env.LAND_SUPPRESS_RED; }
  acceptItem(box, red);
  moveMainPastSubmit(box);

  land(box, 1);
  const recorded = events(box);
  const reopens = rows => rows.filter(row => row.item_id === red.item && row.event_kind === 'reopen').length;
  assert.equal(reopens(recorded), 1, 'the stop is recorded once');
  land(box);
  land(box);
  const later = events(box);
  assert.equal(reopens(later), 1, 'no second reopen');
  assert.deepEqual(later.slice(recorded.length).map(row => row.event_kind), [], 'the later runs record nothing');
});
