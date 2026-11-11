/** Claim builds the item folder from the project's configured trunk branch, not a hard-coded main [C7,#3759]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Initialise a project whose trunk is `trunk`, claim an item from a seat, and return the claim result and the box. */
function claimOn(trunk) {
  const box = e2e.sandbox();
  const root = join(box.dir, `trunk-${trunk}`);
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', trunk);
  writeFileSync(join(root, 'package.json'), '{"scripts":{"test":"true"}}\n');
  const initialized = box.run(root, 'init');
  assert.equal(initialized.code, 0, initialized.err || initialized.out);
  const lane = box.run(root, 'lane', 'add', 'app', '--owns', 'app/');
  assert.equal(lane.code, 0, lane.err || lane.out);
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', `chore: set up the ${trunk} board`);
  const added = fixtureAdd(box.run, root, 'app', 'Trunk named item', '--criterion', 'the file exists', '--check', 'test -f app/x.txt', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const id = String(JSON.parse(added.out).item.item_id);
  const seat = join(box.dir, `seat-${trunk}`);
  box.git(root, 'worktree', 'add', '-q', '-b', 'app/one', seat);
  joinFixtureSeat(box, seat, 'app');
  const claimed = box.run(seat, 'claim', id, '--json');
  return { box, root, claimed };
}

/** Claim on a project with this trunk, then check the item folder exists and contains the trunk's tip. */
function assertFolderOnTrunk(trunk) {
  const { box, root, claimed } = claimOn(trunk);
  assert.equal(claimed.code, 0, claimed.err || claimed.out);
  const folder = JSON.parse(claimed.out).itemFolder;
  assert.ok(folder && existsSync(folder), `claim opened an item folder: ${claimed.out}`);
  box.git(folder, 'merge-base', '--is-ancestor', box.git(root, 'rev-parse', trunk).trim(), 'HEAD');
}

test('clause 1: claim succeeds and builds the item folder on a project whose trunk is master [C7,#3759]', () => assertFolderOnTrunk('master'));

test('clause 1: claim succeeds and builds the item folder on a project whose trunk is trunk [C7,#3759]', () => assertFolderOnTrunk('trunk'));

test('clause 2: a project whose trunk is main still builds its item folder from main [C7,#3759]', () => assertFolderOnTrunk('main'));
