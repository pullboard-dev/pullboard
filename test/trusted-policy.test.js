/** A later reclaim cannot turn unchanged coordinator history into an item edit [L3,V4]. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { submissionPaths } from '../src/trusted-policy.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('reclaim at newer main submits only the item edits, without reverting coordinator policy [L3,V4]', () => {
  const box = e2e.project('true');
  const added = box.run(box.repo, 'add', 'web', 'Reclaimed work', '--specs', 'G1',
    '--criterion', 'the owned file exists', '--check', 'test -f web/reclaimed.txt', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  const initial = JSON.parse(box.run(box.web, 'show', '1', '--json').out);
  mkdirSync(join(box.web, 'web'));
  const committed = e2e.commitFile(box, box.web, 'web/reclaimed.txt', 'owned work\n', 'feat(web): reclaimed fixture [G1]');
  assert.equal(committed.status, 0, committed.context);
  const candidate = box.git(box.web, 'rev-parse', 'HEAD');
  assert.equal(box.run(box.web, 'release', '1', '--reason', 'BLOCKED').code, 0);

  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.lease = '3h';
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore(config): coordinator changes claim lease');
  const newerMain = box.git(box.repo, 'rev-parse', 'HEAD');
  assert.notEqual(initial.item_claim_head, newerMain);
  box.git(box.web, 'checkout', '-q', '--detach', newerMain);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  box.git(box.web, 'checkout', '-q', 'web/one');
  const reclaimed = JSON.parse(box.run(box.web, 'show', '1', '--json').out);
  assert.equal(reclaimed.item_claim_head, newerMain, 'the new claim is bounded by newer main');
  assert.equal(box.git(box.web, 'rev-parse', 'HEAD'), candidate, 'the item still has its older main parent');
  const submitted = box.run(box.web, 'submit', '1', '--json');
  assert.equal(submitted.code, 0, submitted.out + '\n' + submitted.err);
  const record = JSON.parse(box.run(box.web, 'show', '1', '--json').out);
  assert.equal(record.item_status, 'submitted');
  assert.equal(record.item_commit, candidate);
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), newerMain, 'submit does not rewrite the coordinator checkout');
  assert.deepEqual(submissionPaths(box.web, reclaimed, candidate, { mainCommit: newerMain }), ['web/reclaimed.txt']);
});
