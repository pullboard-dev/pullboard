/** A new claim refreshes a frozen lane policy to current main; a held renewal keeps it [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

/** Require each actual native fixture command to finish successfully. */
function success(box, cwd, ...args) {
  const result = box.run(cwd, ...args);
  assert.equal(result.code, 0, result.err || result.out);
  return result;
}

/** Claim item 1 in the web lane, commit one file under web/, and return the box. */
function claimedWithWork(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  success(box, box.repo, 'add', 'web', 'Lane refresh', '--specs', 'G1', '--criterion', 'The page renders.');
  success(box, box.web, 'claim', '1');
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/page.html'), '<h1>Page</h1>\n');
  box.git(box.web, 'add', 'web/page.html');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): render page [G1]');
  return box;
}

/** Commit a lane change to main's pullboard.json, as the coordinator does. */
function changeLanes(box, change) {
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  change(config);
  writeFileSync(file, JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: change lanes');
  return box.git(box.repo, 'rev-parse', 'HEAD');
}

/** The commit the item's frozen policy pins. */
function pinned(box) {
  return JSON.parse(JSON.parse(success(box, box.repo, 'show', '1', '--json').out).item_frozen).policy.commit;
}

test('a held renewal after a lane change keeps the frozen policy; a re-claim after release refreshes it to current main [C7]', t => {
  const box = claimedWithWork(t);
  const first = pinned(box);
  const digest = JSON.parse(success(box, box.repo, 'show', '1', '--json').out).item_frozen_digest;
  const head = changeLanes(box, config => { config.lanes.ops = { owns: ['ops/'], specs: [] }; });
  assert.notEqual(head, first);
  assert.match(success(box, box.web, 'claim', '1').out, /renewed #1/);
  assert.equal(pinned(box), first, 'a held renewal never re-pins the policy');
  assert.equal(JSON.parse(success(box, box.repo, 'show', '1', '--json').out).item_frozen_digest, digest);
  success(box, box.web, 'release', '1', '--reason', 'OTHER', '--note', 'take the new lanes', '--no-next');
  success(box, box.web, 'claim', '1');
  assert.equal(pinned(box), head, 'the re-claimed policy now names current main');
  assert.notEqual(JSON.parse(success(box, box.repo, 'show', '1', '--json').out).item_frozen_digest, digest);
});

test('a renewal with no lane change keeps the frozen policy [C7]', t => {
  const box = claimedWithWork(t);
  const first = pinned(box);
  changeLanes(box, config => { config.lease = '3h'; });
  success(box, box.web, 'claim', '1');
  assert.equal(pinned(box), first);
});

test('a re-claim whose lane the accepted policy changed is refused and keeps the old policy [C7]', t => {
  const box = claimedWithWork(t);
  const first = pinned(box);
  changeLanes(box, config => {
    config.lanes.web.owns = ['site/'];
    config.lanes.ui = { owns: ['web/'], specs: [] };
  });
  assert.match(success(box, box.web, 'claim', '1').out, /renewed #1/);
  assert.equal(pinned(box), first, 'a held renewal keeps the old policy');
  success(box, box.web, 'release', '1', '--reason', 'OTHER', '--note', 'lane changed', '--no-next');
  const refused = box.run(box.web, 'claim', '1');
  assert.notEqual(refused.code, 0, refused.out);
  assert.match(refused.err + refused.out, /NO_POLICY/);
  assert.match(refused.err + refused.out, /lanes\.web/);
  assert.equal(pinned(box), first);
});
