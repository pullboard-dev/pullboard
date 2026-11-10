/** Builder-recorded companion patches attach at submit and their owner can reopen the item [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  fixtureAdd,
  fixtureJoin,
} from '../../tests/fixtures/testkit.js';

/** Require a successful real CLI result and decode its native JSON document. */
function document(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** Set up one builder and a distinct owner seat for the API lane. */
function companionFixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const id = document(fixtureAdd(box.run, box.repo, 'web', 'Use an API companion', '--specs', 'G1',
    '--criterion', 'the companion file is present', '--check', 'test -f api/companion.txt', '--json')).item.item_id;
  document(box.run(box.web, 'claim', String(id), '--json'));
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/page.txt'), 'builder\n');
  box.git(box.web, 'add', 'web/page.txt');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): add page [G1]');
  const owner = join(box.dir, 'api-owner');
  box.git(box.repo, 'worktree', 'add', '-q', owner, '-b', 'api/owner', 'main');
  const ownerSeat = document(fixtureJoin(box.run, owner, 'api', '--json')).agent;
  mkdirSync(join(owner, 'api'), { recursive: true });
  writeFileSync(join(owner, 'api/companion.txt'), 'required\n');
  box.git(owner, 'add', 'api/companion.txt');
  box.git(owner, 'commit', '-q', '-m', 'feat(api): add companion [G2]');
  const patchFile = join(box.dir, 'api-companion.patch');
  writeFileSync(patchFile, `${box.git(owner, 'diff', 'main...HEAD')}\n`);
  return { box, id, owner, ownerSeat, patchFile };
}

test('clause 1: submit automatically attaches the builder recorded companion and its owner objection reopens the item [C7]', t => {
  const { box, id, owner, ownerSeat, patchFile } = companionFixture(t);
  const submitted = document(box.run(box.web, 'submit', String(id), '--companion', patchFile, '--key', 'api-view', '--author', ownerSeat, '--wait', '--json'));
  assert.equal(submitted.id, id);
  assert.equal(document(box.run(box.repo, 'show', String(id), '--json')).item_status, 'submitted');
  const patches = document(box.run(box.web, 'patch', 'list', String(id), '--json')).patches;
  assert.equal(patches.length, 1, 'the builder attached the companion during submit without a coordinator command');
  assert.equal(patches[0].author.agentId, ownerSeat);
  const builderObjection = box.run(box.web, 'patch', 'object', String(id), 'api-view', '--note', 'builder cannot object', '--json');
  assert.equal(builderObjection.code, 1);
  assert.equal(JSON.parse(builderObjection.out).error.code, 'ITEM_PATCH_WINDOW');
  const objection = document(box.run(owner, 'patch', 'object', String(id), 'api-view', '--note', 'the API owner needs a different interface', '--json'));
  assert.equal(objection.reopened, true);
  assert.equal(document(box.run(box.repo, 'show', String(id), '--json')).item_status, 'open');
  assert.equal(document(box.run(box.repo, 'patch', 'list', String(id), '--json')).patches.length, 0);
});

test('a submit without a recorded companion does not open an objection window [C7]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const id = document(fixtureAdd(box.run, box.repo, 'web', 'Web only', '--specs', 'G1', '--criterion', 'the web file exists',
    '--check', 'test -f web/page.txt', '--json')).item.item_id;
  document(box.run(box.web, 'claim', String(id), '--json'));
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/page.txt'), 'web\n');
  box.git(box.web, 'add', 'web/page.txt');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): add page [G1]');
  document(box.run(box.web, 'submit', String(id), '--wait', '--json'));
  assert.equal(document(box.run(box.web, 'patch', 'list', String(id), '--json')).patches.length, 0);
  const noPatch = box.run(box.web, 'patch', 'object', String(id), 'missing', '--note', 'nothing to object', '--json');
  assert.equal(noPatch.code, 1);
  assert.equal(JSON.parse(noPatch.out).error.code, 'ITEM_PATCH_WINDOW');
});
