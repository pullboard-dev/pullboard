/** add and claim refuse a bar naming a path missing from main; next and next --take pass over it, and over a check green on main, reporting once [C7,B7]. */
import assert from 'node:assert/strict';
import {
  test,
  after,
} from 'node:test';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../../tests/fixtures/testkit.js';
import { withFixtureBoard } from '../../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Require one fixture command to succeed. */
async function success(box, cwd, ...args) {
  const result = (await box.runLocal(cwd, ...args));
  assert.equal(result.code, 0, `${result.out}\n${result.err}`);
  return result;
}

/** #1 names tools/old.js, which main then deletes; #2 is buildable. */
function retiredPathBoard() {
  const box = e2e.project('true');
  e2e.commitFile(box, box.repo, 'tools/old.js', 'export {};\n', 'chore: add a tool');
  fileFixtureItem(box, box.repo, { lane: 'web', title: 'Fix the old tool', criterion: 'The fix in tools/old.js keeps the page rendering.', args: ['--specs', 'G1'] });
  box.git(box.repo, 'rm', '-q', 'tools/old.js');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: retire the old tool');
  fileFixtureItem(box, box.repo, { lane: 'web', title: 'Fresh item', args: ['--specs', 'G1'] });
  return box;
}

test('clause 1: add and edit refuse a criterion naming a path missing from main, naming the path [C7]', async () => {
  const box = e2e.project('true');
  assert.throws(() => fileFixtureItem(box, box.repo, { lane: 'web', title: 'Retired path', criterion: 'The fix in retired/old.js holds.', args: ['--specs', 'G1'] }),
    /BAR_PATH_MISSING[^]*the bar names retired\/old\.js, missing from main/u);
  const item = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Fine item', args: ['--specs', 'G1'] });
  const edited = (await box.runLocal(box.repo, 'edit', String(item.item_id), '--criterion', 'The fix in retired/old.js holds.'));
  assert.notEqual(edited.code, 0, edited.out);
  assert.match(`${edited.out}\n${edited.err}`, /BAR_PATH_MISSING[^]*retired\/old\.js/u);
});

test('clause 1: claim refuses an item whose bar names a path main has since removed [C7]', async () => {
  const box = retiredPathBoard();
  const claimed = (await box.runLocal(box.web, 'claim', '1'));
  assert.notEqual(claimed.code, 0, claimed.out);
  assert.match(`${claimed.out}\n${claimed.err}`, /BAR_PATH_MISSING[^]*tools\/old\.js/u);
});

test('clause 2: next skips the item naming a missing path, claims the next and tells the coordinator once [C7,B7]', async () => {
  const box = retiredPathBoard();
  const first = await success(box, box.web, 'next');
  assert.match(first.out, /skipped #1: \[BAR_PATH_MISSING\]/u, first.out);
  assert.match(first.out, /claimed #2: Fresh item/u, first.out);
  await success(box, box.web, 'release', '2', '--reason', 'OTHER', '--note', 'fixture');
  await success(box, box.web, 'next');
  const inbox = (await success(box, box.repo, 'inbox')).out;
  assert.equal(inbox.split('next passes over #1 (BAR_PATH_MISSING)').length - 1, 1, inbox);
});

test('clause 1: next --take skips the item naming a missing path, takes the next and tells the coordinator once [C7,B7]', async () => {
  const box = retiredPathBoard();
  const first = await success(box, box.web, 'next', '--take');
  assert.match(first.out, /skipped #1: \[BAR_PATH_MISSING\]/u, first.out);
  assert.match(first.out, /claimed #2: Fresh item/u, first.out);
  await success(box, box.web, 'release', '2', '--reason', 'OTHER', '--note', 'fixture');
  await success(box, box.web, 'next', '--take');
  const inbox = (await success(box, box.repo, 'inbox')).out;
  assert.equal(inbox.split('next passes over #1 (BAR_PATH_MISSING)').length - 1, 1, inbox);
});

test('clause 3: with checks.provesNothing hold, next passes over an item whose check passes on main and reports it once [C7,B7]', async () => {
  const box = e2e.project('true');
  const file = join(box.repo, 'pullboard.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), checks: { provesNothing: 'hold' } }, null, 2));
  box.git(box.repo, 'commit', '-q', '-am', 'chore: hold checks that pass on main');
  const green = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Already done', args: ['--specs', 'G1'] });
  fileFixtureItem(box, box.repo, { lane: 'web', title: 'Fresh item', args: ['--specs', 'G1'] });
  const main = box.git(box.repo, 'rev-parse', 'main');
  withFixtureBoard(join(box.repo, '.git/pullboard/board.sqlite'), board => {
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
      .run(`item_check_baseline_${green.item_id}`, JSON.stringify({ command: green.item_check, main, result: 'green' }));
  });
  const next = await success(box, box.web, 'next');
  assert.match(next.out, new RegExp(`skipped #${green.item_id}: \\[CRITERION_PROVES_NOTHING\\]`, 'u'), next.out);
  assert.match(next.out, /claimed #2: Fresh item/u, next.out);
  const inbox = (await success(box, box.repo, 'inbox')).out;
  assert.equal(inbox.split(`next passes over #${green.item_id} (CRITERION_PROVES_NOTHING)`).length - 1, 1, inbox);
});
