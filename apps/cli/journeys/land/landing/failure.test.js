/** A parser failure in a composed landing blocks its batch and charges the implicated item, not the train [C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../../../../lib/index.js';
import {
  closeBoard,
  getItem,
  checkedLandingCommit,
} from '../../../../../packages/store/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { captureCommandInProcess } from '../../../tests/fixtures/process.js';
import { main } from '../../../tests/fixtures/native.js';
import { joinFixtureSeat } from '../../../tests/fixtures/testkit.js';

/** Run actual submit, review and landing against one private Git repository and persistent native board. */
async function fixture(t, { duplicate = false, unrelated = false } = {}) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox({ declareFamilies: true }));
  /** The public CLI retains normal authorization, composition, proof writing and hooks. */
  const cli = (cwd, ...args) => captureCommandInProcess(main, args, { cwd, env: box.env });
  const marker = join(box.dir, 'candidate-module-executed');
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(box.repo, 'web/value.js'), 'export const value = 1;\n');
  writeFileSync(join(box.repo, 'web/client.js'), "import { value } from './value.js';\nimport { writeFileSync } from 'node:fs';\n"
    + `writeFileSync(${JSON.stringify(marker)}, 'executed');\nexport const result = value;\n`);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: private healthy module graph');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const remote = join(box.dir, 'origin.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  /** Add, claim, commit, submit and independently accept one item from the given worktree; return its id. */
  const accepted = async (seat, name, file, bad, reviewerName) => {
  const added = await cli(box.repo, 'add', 'web', name, '--specs', 'G1',
    '--brief', `Files: ${file}\nChange: add the marker\nTest: the marker file exists`, '--criterion', 'The change marker exists.', '--check', `test -f ${file}`, '--wait', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const item = JSON.parse(added.out).item.item_id;
  const claim = await cli(seat, 'claim', String(item));
  assert.equal(claim.code, 0, claim.err);
  writeFileSync(join(seat, file), 'source change\n');
  if (bad) writeFileSync(join(seat, 'web/client.js'), "import { value } from './value.js';\nimport { value } from './value.js';\nexport const result = value;\n");
  box.git(seat, 'add', '-A');
  box.git(seat, 'commit', '-q', '-m', 'feat(web): private landing source [G1]');
  const submitted = await cli(seat, 'submit', String(item), '--wait', '--no-next', '--json');
  assert.equal(submitted.code, 0, submitted.err + submitted.out);
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { gitRoot: box.repo });
  t.after(() => closeBoard(board));
  const reviewer = join(box.dir, reviewerName);
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, getItem(board, item).item_commit);
  const joinedReviewer = await cli(reviewer, 'join', 'api', '--family', 'Fixture Review Vendor', '--model', 'fixture-reviewer', '--json');
  assert.equal(joinedReviewer.code, 0, joinedReviewer.err + joinedReviewer.out);
  const reserved = await cli(reviewer, 'next', '--verify', String(item), '--json');
  assert.equal(reserved.code, 0, reserved.err + reserved.out);
  const accepted = await cli(reviewer, 'verify', String(item), 'accept', '--no-next',
    '--note', 'The actual frozen change-marker command passed in the reserved composition.', '--json');
  assert.equal(accepted.code, 0, accepted.err + accepted.out);
  assert.equal(getItem(board, item).item_status, 'verified');
  return item;
  };
  const item = await accepted(box.web, 'Source with landing inputs', 'web/change.txt', duplicate, 'landing-reviewer');
  const source = box.git(box.web, 'rev-parse', 'HEAD');
  let other = null;
  if (unrelated) {
    const second = join(box.dir, 'web-2');
    box.git(box.repo, 'worktree', 'add', '-q', second, '-b', 'web/two', 'main');
    const joined = joinFixtureSeat(box, second, 'web', { model: 'Fixture' });
    assert.equal(joined.code, 0, joined.out + joined.err);
    other = await accepted(second, 'Independent change', 'web/other.txt', false, 'landing-reviewer-two');
  }
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { gitRoot: box.repo });
  t.after(() => closeBoard(board));
  return { ...box, board, item, other, source, marker, cli, before: box.git(box.repo, 'rev-parse', 'main') };
}

test('clause 1: a duplicate import in the composed landing blocks its batch and returns the implicated item, main unmoved [C7]', async t => {
  const box = await fixture(t, { duplicate: true });
  const landed = await box.cli(box.repo, 'land', '--json');
  assert.equal(landed.code, 1, landed.err + landed.out); // nothing landed and a culprit came back, so land fails [C7,#4265]
  const batch = JSON.parse(landed.out).batch;
  assert.equal(batch.state, 'blocked');
  assert.match(batch.refusal?.code ?? JSON.stringify(batch), /LAND_MODULE_PARSE/u);
  assert.match(landed.out, /web\/client\.js/u);
  assert.equal(getItem(box.board, box.item).item_status, 'open', 'the implicated item goes back to open');
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), box.before);
  assert.equal(existsSync(box.marker), false);
});

test('clause 1: the blocked batch keeps an unrelated accepted verdict while charging only the implicated item [C7]', async t => {
  const box = await fixture(t, { duplicate: true, unrelated: true });
  const landed = await box.cli(box.repo, 'land', '--json');
  assert.equal(landed.code, 1, landed.err + landed.out); // nothing landed and a culprit came back, so land fails [C7,#4265]
  assert.match(landed.out, /LAND_MODULE_PARSE/u);
  assert.equal(getItem(box.board, box.item).item_status, 'open', 'the implicated item goes back to open');
  assert.equal(getItem(box.board, box.other).item_status, 'verified', 'the unrelated accepted verdict is preserved');
});

test('clause 2: the next landing proceeds without adopting the same parser failure again [C7]', async t => {
  const box = await fixture(t, { duplicate: true });
  assert.equal((await box.cli(box.repo, 'land', '--json')).code, 1); // only culprits came back [C7,#4265]
  const next = await box.cli(box.repo, 'land', '--json');
  assert.equal(next.code, 0, next.err + next.out);
  assert.doesNotMatch(next.out + next.err, /LAND_ADOPT|LAND_MODULE_PARSE/u);
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), box.before);
});

test('clause 2: the next landing lands the other independently accepted item without adopting the parser failure [C7]', async t => {
  const box = await fixture(t, { duplicate: true, unrelated: true });
  assert.equal((await box.cli(box.repo, 'land', '--json')).code, 1); // only culprits came back [C7,#4265]
  let next;
  for (let attempt = 0; attempt < 2 && getItem(box.board, box.other).item_status !== 'landed' && !getItem(box.board, box.other).item_merged_commit; attempt++) {
    next = await box.cli(box.repo, 'land', '--json');
    assert.equal(next.code, 0, next.err + next.out);
    assert.doesNotMatch(next.out + next.err, /LAND_ADOPT|LAND_MODULE_PARSE/u);
  }
  assert.ok(getItem(box.board, box.other).item_merged_commit, 'the unrelated item reached main');
  assert.notEqual(box.git(box.repo, 'rev-parse', 'main'), box.before);
  assert.equal(box.git(box.repo, 'show', 'main:web/other.txt'), 'source change');
  assert.equal(getItem(box.board, box.item).item_status, 'open');
});
