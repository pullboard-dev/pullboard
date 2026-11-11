/** A coordinator lands named items at named proven commits as one batch on the product train, bisecting a static red [C7,#5559]. */
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
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import {
  calls,
  events,
  json,
} from '../../tests/fixtures/land/board.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { commitFile } = e2e;
const { landProject, itemWorktree } = makeLandProjectFixtures(e2e);

/** A project whose static check is red for any web file holding STATIC_RED, naming the file and line like the product's checks. */
function staticProject() {
  const box = landProject();
  const script = join(box.dir, 'static-check.cjs');
  writeFileSync(script, [
    "const fs = require('node:fs'); const path = require('node:path'); const web = path.join(process.cwd(), 'web'); let red = 0;",
    "for (const name of fs.existsSync(web) ? fs.readdirSync(web) : []) if (fs.readFileSync(path.join(web, name), 'utf8').includes('STATIC_RED')) { console.log('web/' + name + ':1: static fixture is red'); red = 1; }",
    'process.exitCode = red;',
  ].join('\n'));
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.staticChecks = `node ${JSON.stringify(script)}`;
  config.landing = { perItem: false, manualOverride: true, publish: 'separate' };
  writeFileSync(path, JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure a static fixture check');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  return box;
}

/** Build one unsubmitted item commit, the shape of work proven elsewhere. */
function provenItem(box, number, contents) {
  const entry = itemWorktree(box, number);
  const committed = commitFile(box, entry.path, entry.file, contents, `feat(web): build land fixture ${entry.item} [G1]`);
  assert.equal(committed.status, 0, committed.stderr);
  entry.commit = box.git(entry.path, 'rev-parse', 'HEAD');
  return entry;
}

test('land --items lands two named proven items as one batch without a test gate [C7,#5559]', () => {
  const box = staticProject();
  const [first, second] = [provenItem(box, 1, 'PASS\n'), provenItem(box, 2, 'PASS\n')];
  const base = box.git(box.repo, 'rev-parse', 'main');
  const beforeCalls = calls(box).length;
  const result = json(box, box.repo, 'land', '--items', `${first.item},${second.item}`, '--commit', `${first.commit},${second.commit}`);
  assert.deepEqual(result.landed, [first.item, second.item]);
  assert.equal(result.batch.items.length, 2, 'both items are one batch');
  assert.equal(result.batch.external, true);
  assert.equal(calls(box).length, beforeCalls, 'the proven commits run no test gate');
  const tip = box.git(box.repo, 'rev-parse', 'main');
  assert.notEqual(tip, base);
  assert.equal(tip, result.batch.tip, 'main moved once, to the batch tip');
  for (const entry of [first, second]) {
    assert.equal(box.tryGit(box.repo, 'merge-base', '--is-ancestor', entry.commit, 'main').status, 0, `#${entry.item}'s commit is on main`);
    assert.ok(json(box, box.repo, 'show', String(entry.item)).item_merged_commit, `#${entry.item} has a landing receipt`);
  }
  assert.ok(events(box).some(event => event.event_kind === 'main-moved'));
});

test('land --items bisects a static red out of the batch and lands the good items [C7,#5559]', () => {
  const box = staticProject();
  const good = provenItem(box, 1, 'PASS\n');
  const bad = provenItem(box, 2, 'STATIC_RED\n');
  const other = provenItem(box, 3, 'PASS\n');
  const result = json(box, box.repo, 'land', '--items', `${good.item},${bad.item},${other.item}`, '--commit', `${good.commit},${bad.commit},${other.commit}`);
  assert.deepEqual(result.landed, [good.item, other.item]);
  assert.deepEqual(result.culprits.map(entry => entry.id), [bad.item]);
  assert.equal(json(box, box.repo, 'show', String(bad.item)).item_merged_commit, null, 'the bad item is not recorded as landed');
  assert.ok(json(box, box.repo, 'show', String(good.item)).item_merged_commit);
  assert.ok(json(box, box.repo, 'show', String(other.item)).item_merged_commit);
  assert.ok(!box.git(box.repo, 'ls-tree', '-r', '--name-only', 'main').split('\n').includes(bad.file), 'the bad item left nothing on main');
});

test('land --items refuses a non-coordinator, a missing id and a commit count that does not match [C7,#5559]', () => {
  const box = staticProject();
  const entry = provenItem(box, 1, 'PASS\n');
  assert.notEqual(box.run(entry.path, 'land', '--items', String(entry.item), '--commit', entry.commit).code, 0, 'a worker seat cannot land');
  const mismatch = box.run(box.repo, 'land', '--items', `${entry.item},9999`, '--commit', entry.commit);
  assert.match(mismatch.err, /USAGE/u);
  const missing = box.run(box.repo, 'land', '--items', '9999', '--commit', entry.commit);
  assert.match(missing.err, /NO_ITEM/u);
});
