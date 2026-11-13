/** A pulled red main fails too names its one open owner, records main's receipt once, and leads only within its tier [V1,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { FAILING_TEST } from '../../tests/fixtures/red/main-red.js';
import { RED_SPEC } from '../../tests/fixtures/red/main-red.js';
import { addItems } from '../../tests/fixtures/red/main-red.js';
import { builder } from '../../tests/fixtures/red/main-red.js';
import { cli } from '../../tests/fixtures/red/main-red.js';
import { commit } from '../../tests/fixtures/red/main-red.js';
import { fixture } from '../../tests/fixtures/red/main-red.js';
import { gateFacts } from '../../tests/fixtures/red/main-red.js';
import { put } from '../../tests/fixtures/red/main-red.js';
import { runCount } from '../../tests/fixtures/red/main-red.js';
import { settledRed } from '../../tests/fixtures/red/main-red.js';

test('one inherited row names its open owner, records main once, and leads only within its tier [V1,C7]', async t => {
  const box = fixture(t, { spec: RED_SPEC, source: FAILING_TEST });
  const [rework, submitItem, earlier, middle] = addItems(box, [
    { title: 'Repair inherited gate', specId: 'G1' },
    { title: 'Unrelated submit', specId: 'G2' },
    { title: 'Earlier light work', specId: 'G3', route: 'light' },
    { title: 'Middle milestone work', specId: 'G4' },
  ]);
  assert.ok(rework && submitItem && earlier && middle);
  assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Early', '--reason', 'Arrange fixture release', '--items', String(earlier)).code, 0);
  assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Middle', '--reason', 'Arrange fixture release', '--items', String(middle)).code, 0);
  assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Later', '--reason', 'Arrange fixture release', '--items', String(rework)).code, 0);

  const withoutEvidence = builder(box);
  const ordinary = withoutEvidence.run('next', '--json');
  assert.equal(ordinary.code, 0, ordinary.err);
  assert.equal(JSON.parse(ordinary.out).item.item_id, earlier, 'without current-main evidence, original milestone order remains unchanged');
  const normalMid = builder(box);
  const normalOffer = normalMid.run('next', '--json');
  assert.equal(normalOffer.code, 0, normalOffer.err);
  assert.equal(JSON.parse(normalOffer.out).item.item_id, middle, 'without evidence, same-tier milestone order remains unchanged');
  // OTHER only frees the claim: BLOCKED twice escalates the item past this mid seat (#3219), and BLOCKED or ROUTED_ELSEWHERE hide it from next for this lane and route (#3014).
  assert.equal(normalMid.run('release', String(middle), '--reason', 'OTHER', '--note', 'fixture frees the claim', '--no-next').code, 0);
  assert.equal(JSON.parse(cli(box.root, box.env, 'show', String(rework), '--json').out).item_status, 'open', 'the controlled release leaves the rework open for inherited-red attribution');

  const submitter = builder(box);
  assert.equal(submitter.run('claim', String(submitItem)).code, 0);
  put(submitter.root, 'test/inherited.test.js', `${FAILING_TEST}// candidate-only comment\n`);
  commit(submitter.root, box.env, 'test(core): select inherited red [G1]');
  const before = runCount(box);
  // The first result names main's missing receipt; once its main-test job records, the red is main's and is accepted.
  const { shown, job } = await settledRed(t, box, submitter, submitItem, { args: ['--infra', 'append a candidate-only test marker to exercise inherited red ownership'], until: doc => doc?.item_status === 'submitted' });
  const accepted = gateFacts(shown, job.id).find(text => text.includes("(not this item's; accepted)"));
  assert.ok(accepted, gateFacts(shown, job.id).join('\n---\n'));
  assert.match(accepted, new RegExp(`^inherited main red for approved row G1 \\(test/inherited\\.test\\.js\\); open rework #${rework} owns it$`, 'mu'));
  const main = runFixtureGit(['rev-parse', 'main'], { cwd: box.root, env: box.env }).trim();
  const common = runFixtureGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: submitter.root, env: box.env }).trim();
  const cachePath = join(common, 'pullboard/main-red.json');
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  assert.equal(cache.entries[main]['test/inherited.test.js'].result, 'red');
  assert.equal(statSync(cachePath).mode & 0o077, 0, 'the result cache is private to this machine account');
  assert.equal(runCount(box), before + 2, 'one selected candidate run and one exact-main run occurred');

  // The accepted submission is now a review a fresh seat is offered first; the build order is what is under test.
  const afterEvidence = builder(box);
  const offered = afterEvidence.run('next', '--build', '--json');
  assert.equal(offered.code, 0, offered.err);
  assert.equal(JSON.parse(offered.out).item.item_id, rework, 'the unique main-red rework leads an earlier-milestone item within the same tier');
  const middleHolder = builder(box);
  assert.equal(middleHolder.run('claim', String(middle)).code, 0, 'a different builder can claim the non-priority same-tier item');
  assert.equal(afterEvidence.run('release', String(rework), '--reason', 'OTHER', '--note', 'fixture frees the claim', '--no-next').code, 0, 'release the selected rework before asking for another claim');
  const sole = afterEvidence.run('next', '--build', '--json');
  assert.equal(sole.code, 0, sole.err);
  assert.equal(JSON.parse(sole.out).item.item_id, rework, 'the only eligible same-tier item is never removed by prioritization');
  assert.equal(afterEvidence.run('release', String(rework), '--reason', 'OTHER', '--note', 'fixture frees the claim', '--no-next').code, 0);
  assert.equal(middleHolder.run('release', String(middle), '--reason', 'OTHER', '--note', 'fixture frees the claim', '--no-next').code, 0);
  put(box.root, 'README.md', 'A new main commit has no cached comparison yet.\n');
  const newMain = commit(box.root, box.env, 'chore: advance main fixture');
  assert.notEqual(newMain, main);
  const afterMainChange = builder(box).run('next', '--build', '--json');
  assert.equal(afterMainChange.code, 0, afterMainChange.err);
  assert.equal(JSON.parse(afterMainChange.out).item.item_id, middle, 'a cache for the former main cannot reorder the current main');
});
