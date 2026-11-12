/** Real installed commit hooks scope item custody and name safe stale-claim recovery [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  openBoard,
  closeBoard,
} from '../../../../lib/index.js';
import * as store from '../../../../../packages/store/index.js';
import { submitFixture } from '../../../tests/fixtures/board/submit.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';

/** Use real CLI claims and installed hooks, with synthetic submission state only in this private board. */
function fixture(t) {
  const helpers = createE2eHelpers();
  const box = helpers.project('true');
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { gitRoot: box.repo });
  t.after(() => { closeBoard(board); helpers.cleanup(); });
  /** Require native command success before using its response. */
  const json = result => {
    assert.equal(result.code, 0, result.out + result.err);
    return JSON.parse(result.out);
  };
  /** Keep fixture route explicit rather than relying on diagnosis-sensitive defaults. */
  const add = title => json(fixtureAdd(box.run, box.repo, 'web', title, '--criterion', 'The fixture preserves commit custody.',
    '--specs', 'G1', '--route', 'strong', '--json')).item.item_id;
  /** Open the native item folder under this seat's existing identity. */
  const claim = id => json(box.run(box.web, 'claim', String(id), '--json'));
  /** Stage actual lane-owned bytes for the installed Git hook. */
  function stage(root, name) {
    mkdirSync(join(root, 'web'), { recursive: true });
    writeFileSync(join(root, 'web', name), 'export const value = 1;\n');
    box.git(root, 'add', `web/${name}`);
  }
  return { box, board, json, add, claim, stage };
}

test('clause 1: an item-folder commit ignores submitted and released claims and preserves another live claim [C7]', t => {
  const { box, board, json, add, claim, stage } = fixture(t);
  const submitted = add('Previously submitted work');
  const released = add('Previously released work');
  const other = add('Other live work');
  const active = add('Current item-folder work');
  const old = claim(submitted);
  const head = box.git(old.itemFolder, 'rev-parse', 'HEAD');
  submitFixture(board, submitted, { agentId: store.getItem(board, submitted).item_owner,
    commit: head, tree: box.git(old.itemFolder, 'rev-parse', 'HEAD^{tree}') });
  claim(released);
  json(box.run(box.web, 'release', String(released), '--reason', 'OTHER', '--note', 'No longer working this claim', '--no-next', '--json'));
  claim(other);
  const current = claim(active);
  stage(current.itemFolder, 'current.js');
  const committed = box.tryGit(current.itemFolder, 'commit', '-q', '-m', 'feat(web): preserve item custody [G1]');
  assert.equal(committed.status, 0, committed.failure || committed.stderr || committed.stdout);
  const message = box.git(current.itemFolder, 'log', '-1', '--format=%B');
  assert.match(message, new RegExp(`Pullboard-Item: #${active}\\b`, 'u'));
  for (const id of [submitted, released, other]) assert.doesNotMatch(message, new RegExp(`Pullboard-Item: #${id}\\b`, 'u'));
  assert.equal(store.getItem(board, submitted).item_status, 'submitted');
  assert.equal(store.getItem(board, released).item_status, 'open');
  assert.equal(store.getItem(board, other).item_status, 'claimed', 'a commit never releases unrelated work');
});

test('clause 2: an ambiguous seat-root commit names one exact release command and succeeds after that claim is cleared [C7]', t => {
  const { box, board, json, add, claim, stage } = fixture(t);
  const old = add('Work the seat no longer pursues');
  const active = add('Current seat-root work');
  claim(old);
  claim(active);
  stage(box.web, 'retained.js');
  const before = box.git(box.web, 'rev-parse', 'HEAD');
  const refused = box.tryGit(box.web, 'commit', '-q', '-m', 'feat(web): retain current work [G1]');
  assert.notEqual(refused.status, 0, 'multiple live claims still cannot select their own commit metadata');
  const command = `pullboard release ${old} --reason OTHER --note "no longer working this claim" --no-next`;
  assert.ok(refused.stderr.includes(`#${old}`), refused.stderr);
  assert.ok(refused.stderr.includes(command), refused.stderr);
  assert.equal(box.git(box.web, 'rev-parse', 'HEAD'), before);
  assert.equal(readFileSync(join(box.web, 'web/retained.js'), 'utf8'), 'export const value = 1;\n');
  json(box.run(box.web, 'release', String(old), '--reason', 'OTHER', '--note', 'no longer working this claim', '--no-next', '--json'));
  assert.equal(store.getItem(board, old).item_status, 'open');
  assert.equal(store.getItem(board, active).item_status, 'claimed');
  const committed = box.tryGit(box.web, 'commit', '-q', '-m', 'feat(web): retain current work [G1]');
  assert.equal(committed.status, 0, committed.failure || committed.stderr || committed.stdout);
  assert.match(box.git(box.web, 'log', '-1', '--format=%B'), new RegExp(`Pullboard-Item: #${active}\\b`, 'u'));
});
