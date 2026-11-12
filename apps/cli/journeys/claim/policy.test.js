/** A claim freezes the bar alone, never pullboard.json; a bar frozen by the previous release still reads unchanged [B4,R2]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { criterionFreezer } from '../../../../packages/moves/index.js';
import { replayArgs } from '../../../../packages/state/src/logic/engine/move/verify.js';
import { openKitBoard } from '../../tests/fixtures/testkit.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

/** Require each actual native fixture command to finish successfully. */
async function success(box, cwd, ...args) {
  const result = await box.runLocal(cwd, ...args);
  assert.equal(result.code, 0, result.err || result.out);
  return result;
}

/** Claim item 1 in the web lane (its brief names web/page.html and web/legacy/old.html), commit that file, and return the box. */
async function claimedWithWork(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  await success(box, box.repo, 'add', 'web', 'Lane refresh', '--specs', 'G1', '--criterion', 'The page renders.', '--brief', 'Files: web/page.html, web/legacy/old.html.');
  await success(box, box.web, 'claim', '1');
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/page.html'), '<h1>Page</h1>\n');
  box.git(box.web, 'add', 'web/page.html');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): render page [G1]');
  return box;
}

/** Commit a policy change to main's pullboard.json, as the coordinator does. */
function changePolicy(box, change) {
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  change(config);
  writeFileSync(file, JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: change policy');
  return box.git(box.repo, 'rev-parse', 'HEAD');
}

/** Item 1's frozen record and digest. */
async function frozenOf(box) {
  const item = JSON.parse((await success(box, box.repo, 'show', '1', '--json')).out);
  return { frozen: JSON.parse(item.item_frozen), digest: item.item_frozen_digest };
}

test('a new claim freezes title, criterion and cited rows and no pullboard.json content [B4,R2]', async t => {
  const box = await claimedWithWork(t);
  const { frozen, digest } = await frozenOf(box);
  assert.deepEqual(Object.keys(frozen).sort(), ['criterion', 'rows', 'title']);
  assert.equal(frozen.title, 'Lane refresh');
  assert.equal(frozen.criterion, 'The page renders.');
  assert.deepEqual(frozen.rows.map(row => row.id), ['G1']);
  assert.equal(frozen.policy, undefined, 'no policy pin in the frozen bar');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  const text = JSON.stringify(frozen);
  for (const lane of Object.keys(config.lanes)) assert.ok(!text.includes(`"${lane}":`), `no lane table for ${lane}`);
  assert.equal(digest, createHash('sha256').update(text).digest('hex'), 'the digest covers exactly the frozen bar');
});

test('the digest stays put across policy commits and re-claims, and moves only when the bar does [B4,R2]', async t => {
  const box = await claimedWithWork(t);
  const { digest } = await frozenOf(box);
  changePolicy(box, config => {
    config.lanes.web.owns = [...config.lanes.web.owns, 'docs/'];
    config.lanes.ops = { owns: ['ops/'], specs: [] };
    config.affectedTests = 'node -e "process.exit(0)"';
    config.lease = '3h';
  });
  assert.match((await success(box, box.web, 'claim', '1')).out, /renewed #1/);
  assert.equal((await frozenOf(box)).digest, digest, 'a renewal after a policy commit keeps the digest');
  await success(box, box.web, 'release', '1', '--reason', 'OTHER', '--note', 'policy moved on', '--no-next');
  changePolicy(box, config => { config.lanes.web.owns = ['web/', 'site/']; config.lanes.ui = { owns: ['web/legacy/'], specs: [] }; });
  await success(box, box.web, 'claim', '1');
  assert.equal((await frozenOf(box)).digest, digest, 'a re-claim after lane changes keeps the digest');
  await success(box, box.web, 'release', '1', '--reason', 'OTHER', '--note', 'bar edit', '--no-next');
  await success(box, box.repo, 'edit', '1', '--criterion', 'The page renders twice.', '--reason', 'bar edit');
  await box.runLocal(box.repo, 'hold', '1', '--off');
  await success(box, box.web, 'claim', '1');
  const edited = await frozenOf(box);
  assert.notEqual(edited.digest, digest, 'a bar edit changes the digest');
  assert.equal(edited.frozen.criterion, 'The page renders twice.');
});

test('a bar frozen by the previous release, with its pinned policy, still re-freezes to the same digest and verifies under its policy [B4,R2]', async t => {
  const box = await claimedWithWork(t);
  const commit = box.git(box.repo, 'rev-parse', 'HEAD');
  const board = openKitBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { gitRoot: box.repo });
  try {
    const item = store.getItem(board, 1);
    const legacyText = JSON.stringify({ ...JSON.parse(item.item_frozen), policy: { version: 1, commit, verify: { policy: 'coordinator', family: 'require' } } });
    const legacyDigest = createHash('sha256').update(legacyText).digest('hex');
    store.refreeze(board, 1, { agentId: 'coordinator', freeze: () => ({ text: legacyText, digest: legacyDigest }) });
    changePolicy(box, config => { config.lanes.ops = { owns: ['ops/'], specs: [] }; config.verify = { ...config.verify, policy: 'any', family: 'off' }; });
    const legacy = store.getItem(board, 1);
    const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
    const again = criterionFreezer({ root: box.repo, isMain: true, config }, { board })(legacy);
    assert.equal(again.text, legacyText, 'the legacy bar reproduces its pinned policy text');
    assert.equal(again.digest, legacyDigest, 'so submit and verify see an unchanged digest');
    const args = [1, { agentId: 'reviewer', decision: 'ACCEPT', policy: 'any', familyPolicy: 'off' }];
    replayArgs(board, args, { move: { id: 'move-1' }, store });
    assert.equal(args[1].policy, 'coordinator', 'replay keeps the legacy frozen verify policy');
    assert.equal(args[1].familyPolicy, 'require');
  } finally { store.closeBoard(board); }
});

test('a bar-only item verifies under the verify policy its move sealed [B4,R2]', async t => {
  const box = await claimedWithWork(t);
  const board = openKitBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { gitRoot: box.repo });
  try {
    const args = [1, { agentId: 'reviewer', decision: 'ACCEPT', policy: 'any', familyPolicy: 'prefer' }];
    replayArgs(board, args, { move: { id: 'move-2' }, store });
    assert.equal(args[1].policy, 'any');
    assert.equal(args[1].familyPolicy, 'prefer');
    assert.throws(() => replayArgs(board, [1, { decision: 'ACCEPT', policy: 'bogus', familyPolicy: 'off' }], { move: { id: 'move-3' }, store }), /NO_POLICY/);
  } finally { store.closeBoard(board); }
});
