/** A landing reopen that left the accept and green gate intact lands again with no new build or review [C7,#2997]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import * as store from '../../../../packages/store/index.js';
import {
  events,
  json,
  onBoard,
} from '../../tests/fixtures/land/board.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { FILES, landProject, submitItem, acceptItem } = makeLandProjectFixtures({ ...e2e,
  sandbox(...args) { const box = e2e.sandbox(...args); box.env.PULLBOARD_MODEL = 'reland-fixture'; return box; } });

/** Add and claim one strong-routed item in its own worktree; a checked item otherwise routes light and needs a brief. */
async function itemWorktree(box, number) {
  const path = join(box.dir, `land-${number}`), file = FILES[number - 1];
  box.git(box.repo, 'worktree', 'add', '-q', '-b', `web/land-${number}`, path, 'main');
  assert.equal(fixtureJoin(box.run, path, 'web', '--route', 'strong').code, 0);
  const added = json(box, box.repo, 'add', 'web', `Land fixture ${number}`, '--specs', 'G1', '--route', 'strong',
    '--criterion', `land fixture ${number} remains valid`, '--check', `node ${JSON.stringify(box.checks)} ${JSON.stringify(file)}`);
  const item = added.item.item_id;
  const claimed = (await box.runLocal(path, 'claim', String(item)));
  assert.equal(claimed.code, 0, claimed.err + claimed.out);
  return { path, item, file };
}

/** Accept one real fixture item, then reopen it from main for a batch-wide landing red that names another test. */
async function reopenedAccepted() {
  const box = landProject();
  // The landing then gates the whole merged tree; this bar is about the return, not affected-test selection.
  const config = join(box.repo, 'pullboard.json');
  const { affectedTests, ...policy } = JSON.parse(readFileSync(config, 'utf8'));
  assert.ok(affectedTests);
  writeFileSync(config, JSON.stringify(policy, null, 2));
  box.git(box.repo, 'commit', '-q', '-m', 'chore: gate whole landings', 'pullboard.json');
  const entry = (await itemWorktree(box, 1));
  submitItem(box, entry);
  acceptItem(box, entry);
  const reopened = (await box.runLocal(box.repo, 'reopen', String(entry.item), '--note', `web/land-9.test.js: batch runner red; merge commit ${'a'.repeat(40)}`));
  assert.equal(reopened.code, 0, reopened.err);
  assert.equal(json(box, box.repo, 'show', String(entry.item)).item_status, 'open');
  const since = events(box).at(-1).event_id;
  return { box, entry, since };
}

test('an open landing return with its accept and green gate at its head returns to verified and lands [C7,#2997]', async () => {
  const { box, entry, since } = (await reopenedAccepted());
  const result = json(box, box.repo, 'land');
  assert.deepEqual(result.landed, [entry.item], JSON.stringify(result));
  const item = json(box, box.repo, 'show', String(entry.item));
  assert.equal(item.item_status, 'verified');
  assert.ok(item.item_merged_commit, 'the item landed on main');
  const later = events(box).filter(event => event.event_id > since && event.item_id === entry.item);
  assert.deepEqual(later.filter(event => ['claim', 'submit', 'accept', 'reject'].includes(event.event_kind)), [], 'no new build or review');
  const reland = later.find(event => event.event_kind === 'reland');
  assert.ok(reland, 'the return is its own event');
  const accept = onBoard(box, board => store.verdictsFor(board, entry.item).findLast(verdict => verdict.verdict_decision === 'ACCEPT'));
  assert.equal(JSON.parse(reland.event_detail).commit, entry.commit);
  assert.equal(JSON.parse(reland.event_detail).accept, accept.verdict_id, 'the event names the accept it relies on');
});

test('an open landing return that conflicts with main stays open with its conflicting files named [C7,#2997]', async () => {
  const { box, entry, since } = (await reopenedAccepted());
  assert.equal(e2e.commitFile(box, box.repo, entry.file, 'MAIN CHANGED\n', 'test(web): change the same file on main [G1]').status, 0);
  json(box, box.repo, 'land');
  json(box, box.repo, 'land');
  assert.equal(json(box, box.repo, 'show', String(entry.item)).item_status, 'open');
  const later = events(box).filter(event => event.event_id > since && event.item_id === entry.item);
  assert.equal(later.filter(event => event.event_kind === 'reland').length, 0);
  const facts = later.filter(event => event.event_kind === 'fact').map(event => JSON.parse(event.event_detail).text);
  assert.equal(facts.filter(text => text.includes(entry.file) && text.includes('conflicts with main')).length, 1, `one fact names ${entry.file}: ${facts.join('\n')}`);
});
