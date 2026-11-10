/** Claim-time spec freshness on real linked Git worktrees [B6,V1]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
const { project } = e2e;

/** Add and commit rows on the coordinator branch. */
function addMainRows(box, ids = ['G3']) {
  const spec = join(box.repo, 'SPEC.md');
  const additions = ids.map((id) => `- ${id} [approved, must] The new row is in force. | gate: test`).join('\n');
  writeFileSync(spec, `${readSpec(box)}\n${additions}\n`);
  box.git(box.repo, 'add', 'SPEC.md');
  box.git(box.repo, 'commit', '-q', '-m', 'docs: add a spec row [G1]');
}

/** Read the fixture's spec file from its coordinator checkout. */
function readSpec(box) {
  return box.git(box.repo, 'show', 'HEAD:SPEC.md');
}

/** Create a board item whose row is already committed on main. */
function addRowItem(box, ids = 'G3', lane = 'web') {
  const added = fixtureAdd(box.run, box.repo, lane, 'Main-only row', '--specs', ids, '--json');
  assert.equal(added.code, 0, added.err || added.out);
  return String(JSON.parse(added.out).item.item_id);
}

/** Commit a local file through the lane's normal hooks. */
function commitLocalWork(box, id = 'G1') {
  const file = join(box.web, 'web', 'local.txt');
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(file, 'local work\n');
  box.git(box.web, 'add', 'web/local.txt');
  box.git(box.web, 'commit', '-q', '-m', `docs: local work [${id}]`);
}

/** Main-only cited rows need a merge; a row unknown to Main still needs its historical meaning. */
test('spec check names merge main when a cited row exists on main [S8,B6]', () => {
  for (const [id, onMain] of [['G3', true], ['X9', false]]) {
    const box = project();
    if (onMain) addMainRows(box, [id]);
    const path = join(box.web, 'SPEC.md');
    const previous = readFileSync(path, 'utf8');
    // Cite a working-copy row through the real hook without committing that row, as in E4.
    writeFileSync(path, `${previous}\n- ${id} [approved, must] The new row is in force. | gate: test\n`);
    commitLocalWork(box, id);
    writeFileSync(path, previous);
    const head = box.git(box.web, 'rev-parse', 'HEAD');
    const checked = box.run(box.web, 'spec', 'check');
    assert.equal(checked.code, 1, checked.err || checked.out);
    if (onMain) {
      assert.match(checked.out, /G3 error:.*git merge main/u, 'main-only cited row must name git merge main');
      assert.doesNotMatch(checked.out, /G3 error:.*add it as a retired row/u);
      box.git(box.web, 'merge', '--no-edit', 'main');
      const repaired = box.run(box.web, 'spec', 'check');
      assert.equal(repaired.code, 0, repaired.err || repaired.out);
    } else {
      assert.match(checked.out, /X9 error:.*never committed.*add it as a retired row/u);
      assert.doesNotMatch(checked.out, /git merge main/u);
      assert.equal(box.git(box.web, 'rev-parse', 'HEAD'), head, 'checking never mutates the worktree');
    }
  }
});

test('claims freeze main-only rows without changing stale, dirty or divergent worktrees [B6,V1]', () => {
  for (const state of ['clean', 'diverged', 'untracked', 'dirty']) {
    const box = project();
    addMainRows(box, ['G3', 'G4']);
    const id = addRowItem(box, 'G3,G4');
    if (state === 'diverged') commitLocalWork(box);
    if (state === 'untracked') writeFileSync(join(box.web, 'scratch.txt'), 'unfinished\n');
    if (state === 'dirty') writeFileSync(join(box.web, 'AGENTS.md'), 'unfinished instructions\n');
    const head = box.git(box.web, 'rev-parse', 'HEAD');
    const spec = readFileSync(join(box.web, 'SPEC.md'), 'utf8');
    const status = box.git(box.web, 'status', '--porcelain');
    const claimed = box.run(box.web, 'claim', id);
    assert.equal(claimed.code, 0, claimed.err || claimed.out);
    assert.match(claimed.out, new RegExp(`claimed #${id}`));
    assert.doesNotMatch(claimed.out, /merged main/u);
    assert.equal(box.git(box.web, 'rev-parse', 'HEAD'), head);
    assert.equal(box.git(box.web, 'status', '--porcelain'), status);
    assert.equal(readFileSync(join(box.web, 'SPEC.md'), 'utf8'), spec);
    const item = JSON.parse(box.run(box.web, 'show', id, '--json').out);
    assert.equal(item.item_claim_head, head);
    assert.deepEqual(JSON.parse(item.item_frozen).rows.map(row => row.id), ['G3', 'G4']);
  }
  const wrongLane = project();
  addMainRows(wrongLane);
  const wrongItem = addRowItem(wrongLane, 'G3', 'api');
  const head = wrongLane.git(wrongLane.web, 'rev-parse', 'HEAD');
  const wrong = wrongLane.run(wrongLane.web, 'claim', wrongItem);
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /\[WRONG_LANE\]/u);
  assert.equal(wrongLane.git(wrongLane.web, 'rev-parse', 'HEAD'), head);
});

test.after(e2e.cleanup);
