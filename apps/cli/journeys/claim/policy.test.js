/** A new claim refreshes a frozen policy to current main unless a file its bar names changed lanes; a held renewal keeps it [C7]. */
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

/** Claim item 1 in the web lane (its brief names web/page.html and web/legacy/old.html), commit that file, and return the box. */
function claimedWithWork(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  success(box, box.repo, 'add', 'web', 'Lane refresh', '--specs', 'G1', '--criterion', 'The page renders.', '--brief', 'Files: web/page.html, web/legacy/old.html.');
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

test('a re-claim after gate inputs and another folder\'s lane change re-freezes the item automatically [C7]', t => {
  const box = claimedWithWork(t);
  const first = pinned(box);
  success(box, box.web, 'release', '1', '--reason', 'OTHER', '--note', 'policy moves on', '--no-next');
  const head = changeLanes(box, config => {
    config.lanes.web.owns = [...config.lanes.web.owns, 'docs/'];
    config.lanes.ops = { owns: ['ops/'], specs: [] };
    config.affectedTests = 'node -e "process.exit(0)"';
    config.submitInvariants = ['web/page.test.js'];
  });
  success(box, box.web, 'claim', '1');
  assert.notEqual(head, first);
  assert.equal(pinned(box), head, 'the claim re-pins the policy in its own write');
  assert.match(success(box, box.repo, 'show', '1').out, /policy re-frozen automatically/);
});

test('a re-claim whose lane\'s owns shrank away from a named file is refused, naming the coordinator\'s refreeze, and keeps the old policy [C7,L2]', t => {
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
  assert.match(refused.err + refused.out, /web\/page\.html moved lanes \(web -> ui\)/, 'the named path it moved refuses, not the shrunk list itself (#3793)');
  assert.match(refused.err + refused.out, /next: nothing for the builder; take other work .*the coordinator refreezes #1/);
  assert.equal(pinned(box), first);
});

test('a re-claim whose named file another lane now owns is refused, naming that file, and keeps the old policy [C7]', t => {
  const box = claimedWithWork(t);
  const first = pinned(box);
  success(box, box.web, 'release', '1', '--reason', 'OTHER', '--note', 'file changed lanes', '--no-next');
  changeLanes(box, config => { config.lanes.ui = { owns: ['web/legacy/'], specs: [] }; });
  const refused = box.run(box.web, 'claim', '1');
  assert.notEqual(refused.code, 0, refused.out);
  assert.match(refused.err + refused.out, /NO_POLICY.*web\/legacy\/old\.html moved lanes \(web -> ui\)/);
  assert.equal(pinned(box), first);
});
