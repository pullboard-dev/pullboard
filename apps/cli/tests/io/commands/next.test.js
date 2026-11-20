/** pullboard next --stuck "<why>" releases the one held claim as BLOCKED through the release move and answers as next does [C7,#11700]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { cli } from '../../fixtures/next/take.js';
import { fixture } from '../../fixtures/next/take.js';

/** The release events an item recorded, with their detail parsed. */
const releases = (box, id) => box.board.db.prepare("SELECT event_detail d FROM event WHERE item_id=? AND event_kind='release'").all(id).map(row => JSON.parse(row.d));

test('cli.io-commands-next.stuck-releases-and-continues: clause 1: a seat holding one claim runs next --stuck "waits on the schema"; the item is open again with a BLOCKED release carrying that note, and the same call claims another item [C7,#11700]', async t => {
  const box = await fixture(t);
  const held = box.add('The item the seat is stuck on');
  const other = box.add('Another item for the same seat');
  const claimed = await cli(box, box.seats.actor.path, ['claim', String(held)]);
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  const ran = await cli(box, box.seats.actor.path, ['next', '--stuck', 'waits on the schema']);
  assert.equal(ran.code, 0, ran.out + ran.err);
  assert.equal(store.getItem(box.board, held).item_owner, null, 'the stuck item is free');
  const [release] = releases(box, held);
  assert.equal(release.reasonCode, 'BLOCKED');
  assert.equal(release.reason, 'waits on the schema');
  assert.equal(store.getItem(box.board, other).item_owner, box.seats.actor.id, 'the same call claimed another item');
});

test('cli.io-commands-next.stuck-needs-a-claim-and-a-reason: clause 2: next --stuck with no held claim, or with an empty reason, is refused USAGE naming pullboard next, and the board is unchanged [C7,#11700]', async t => {
  const box = await fixture(t);
  const held = box.add('A held item');
  const noClaim = await cli(box, box.seats.actor.path, ['next', '--stuck', 'waits on the schema']);
  assert.notEqual(noClaim.code, 0, noClaim.out);
  assert.equal(noClaim.document.error.code, 'USAGE');
  assert.match(noClaim.document.error.message, /pullboard next/u);
  assert.equal(store.getItem(box.board, held).item_owner, null, 'nothing was claimed');
  const claimed = await cli(box, box.seats.actor.path, ['claim', String(held)]);
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  const empty = await cli(box, box.seats.actor.path, ['next', '--stuck', ' ']);
  assert.notEqual(empty.code, 0, empty.out);
  assert.equal(empty.document.error.code, 'USAGE');
  assert.match(empty.document.error.message, /pullboard next/u);
  assert.equal(store.getItem(box.board, held).item_owner, box.seats.actor.id, 'the claim is still held');
  assert.deepEqual(releases(box, held), []);
});

test('cli.io-commands-next.done-submits-and-continues: clause 1: a seat holding one committed claim runs next --done; the item is submitted at the seat head as pullboard submit records it, and the same call claims another item [C7,#11701]', async t => {
  const box = await fixture(t);
  const held = box.add('The item the seat has built');
  const other = box.add('Another item for the same seat');
  const cwd = box.seats.actor.path;
  const claimed = await cli(box, cwd, ['claim', String(held)]);
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  mkdirSync(join(cwd, 'web'), { recursive: true });
  writeFileSync(join(cwd, 'web/done.js'), 'export const done = 1;\n');
  box.git(cwd, 'add', '-A');
  box.git(cwd, 'commit', '-q', '-m', 'feat(web): the built item [G1]', '-m', `Pullboard-Item: #${held}`);
  const ran = await cli(box, cwd, ['next', '--done']);
  assert.equal(ran.code, 0, ran.out + ran.err);
  // The submit hands the item to a gate job; the board records the submit event only when a runner's receipt returns, so the job is the handoff [C7].
  const gateJobs = box.board.db.prepare("SELECT job_id FROM job WHERE job_item=? AND job_kind='gate'").all(held);
  assert.ok(gateJobs.length > 0, `a gate job is queued for the held item: ${ran.out}${ran.err}`);
  assert.equal(store.getItem(box.board, other).item_owner, box.seats.actor.id, 'the same call claimed another item');
});

test('cli.io-commands-next.done-refusal-stops: clause 2: when submit refuses, next --done prints submit refusal, hands out no new item, and exits 1 [C7,#11701]', async t => {
  const box = await fixture(t);
  const held = box.add('The item with an uncommitted change');
  const other = box.add('An item that must stay unclaimed');
  const cwd = box.seats.actor.path;
  const claimed = await cli(box, cwd, ['claim', String(held)]);
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  writeFileSync(join(cwd, 'uncommitted.js'), 'export const x = 1;\n');
  box.git(cwd, 'add', '-A');
  const dirty = await cli(box, cwd, ['next', '--done']);
  assert.equal(dirty.code, 1, dirty.out + dirty.err);
  assert.equal(dirty.document.error.code, 'DIRTY');
  assert.match(dirty.document.error.message, /commit your changes/u);
  assert.equal(store.getItem(box.board, held).item_owner, box.seats.actor.id, 'the claim is still held');
  assert.equal(store.getItem(box.board, other).item_owner, null, 'no new item was handed out');
  const none = await cli(box, box.seats.sibling.path, ['next', '--done']);
  assert.equal(none.code, 1, none.out + none.err);
  assert.equal(none.document.error.code, 'USAGE');
  assert.equal(store.getItem(box.board, other).item_owner, null, 'no new item was handed out without a claim');
});
