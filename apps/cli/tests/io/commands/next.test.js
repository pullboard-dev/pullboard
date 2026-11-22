/** @pullboard-test-input source-cell apps/cli */
/** @pullboard-world-pin the landing-at-call-time case reads next.js source text and writes nothing [C7,#12392]. */
/** pullboard next --stuck "<why>" releases the one held claim as BLOCKED through the release move and answers as next does [C7,#11700]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { submitFixture } from '../../fixtures/board/submit.js';
import { readFileSync } from 'node:fs';
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

test('cli.io-commands-next.landing-loads-at-call-time: clause 1: next.js has no static import of packages/landing, and each landing helper is a sync wrapper over one call-time requireModule of the landing front door [C7,#12392]', () => {
  const source = readFileSync(new URL('../../../src/io/commands/next.js', import.meta.url), 'utf8');
  const imports = source.split(/\r?\n/u).filter((line) => /^\s*import\b/u.test(line) || /^\s*\}\s*from\s/u.test(line));
  assert.deepEqual(imports.filter((line) => line.includes('packages/landing')), [], 'no static import reaches packages/landing');
  for (const name of ['mainRedReviewItems', 'mainRedReworkItems', 'passingMainRedItems', 'computedReturnArgs']) {
    const wrapper = `const ${name} = (...args) => requireModule('../../../../../packages/landing/index.js').${name}(...args);`;
    assert.ok(source.includes(wrapper), `${name} forwards its arguments to the landing front door at call time`);
  }
  assert.ok(source.includes('mainRedReviewItems, mainRedReworkItems, passingMainRedItems, computedReturnArgs'), 'the wrappers are still passed to takeServices');
});

const IDLE_LINE = '[IDLE_TIMEOUT] nothing for this seat in 90 seconds; the board is not finished. Stop, or call next again.';

/** Every number and word the answer printed, whichever stream or JSON field carried it. */
const printed = ran => ran.out + ran.err;

test('cli.io-commands-next.no-wait-idle-exit-4: clause 1: next --no-wait on a board with nothing for the seat prints the IDLE_TIMEOUT line first and exits 4 at once; a held review still refuses REVIEW_HELD at once, and plain next without the flag is unchanged [C7,#12779]', async t => {
  const box = await fixture(t);
  const plain = await cli(box, box.seats.actor.path, ['next']);
  assert.ok(printed(plain).includes(IDLE_LINE), 'plain next on a lane with no items reports the idle timeout');
  const ran = await cli(box, box.seats.actor.path, ['next', '--no-wait']);
  assert.equal(ran.code, 4, printed(ran));
  assert.ok(printed(ran).includes(IDLE_LINE), printed(ran));
  const events = box.board.db.prepare("SELECT event_kind k FROM event WHERE event_kind IN ('next-idle-timeout','next-finished')").all().map(row => row.k);
  assert.deepEqual(events, ['next-idle-timeout'], 'the timeout observation was recorded once');
  // A held review refuses at once, with no idle line and no exit 4.
  const reviewed = box.add('A submission whose review another seat holds');
  box.claim(reviewed);
  mkdirSync(join(box.seats.builder.path, 'web'), { recursive: true });
  writeFileSync(join(box.seats.builder.path, 'web/dispatch.js'), 'export const side = "builder";\n');
  box.git(box.seats.builder.path, 'add', 'web/dispatch.js');
  box.git(box.seats.builder.path, 'commit', '-q', '-m', 'feat(web): build dispatch fixture [G1]');
  const head = box.git(box.seats.builder.path, 'rev-parse', 'HEAD');
  submitFixture(box.board, reviewed, { agentId: box.seats.builder.id, commit: head, tree: box.git(box.root, 'rev-parse', `${head}^{tree}`) });
  const first = await cli(box, box.seats.outside.path, ['next', '--verify', String(reviewed)]);
  assert.equal(first.code, 0, printed(first));
  const held = await cli(box, box.seats.sibling.path, ['next', '--verify', String(reviewed), '--no-wait']);
  assert.notEqual(held.code, 0, printed(held));
  assert.notEqual(held.code, 4, printed(held));
  assert.match(printed(held), /REVIEW_HELD/u);
  assert.doesNotMatch(printed(held), /IDLE_TIMEOUT/u);
});

test('cli.io-commands-next.no-wait-finished-exit-3: clause 2: next --no-wait returns the board-finished line with exit 3 when every item in the seat lane is verified, and never when an item is still open or nothing was ever filed [C7,#12779]', async t => {
  const box = await fixture(t);
  const never = await cli(box, box.seats.actor.path, ['next', '--no-wait']);
  assert.equal(never.code, 4, 'a board where nothing was ever filed is never finished: ' + printed(never));
  const first = box.add('The first item');
  const second = box.add('The second item', { brief: 'Files: web/second.js\nTest: the real board selects the eligible item.' });
  // The board lets a status change only inside a move; the fixture opens that window around its one direct write.
  const verify = id => {
    const head = box.git(box.root, 'rev-parse', 'HEAD'), digest = 'd'.repeat(64), stamp = '2026-10-25T10:00:00.000Z';
    box.board.db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_at)
      VALUES (?, ?, 'ACCEPT', 'CRITERION_MET', 'fixture', ?, ?, ?, ?)`).run(id, box.seats.sibling.id, head, digest, head, stamp);
    box.board.db.exec('INSERT INTO temp.moving VALUES (1)');
    box.board.db.prepare("UPDATE item SET item_status='verified', item_commit=?, item_frozen_digest=?, item_built_by=?, item_verified_by=?, item_verdict='ACCEPT' WHERE item_id=?")
      .run(head, digest, box.seats.builder.id, box.seats.sibling.id, id);
    box.board.db.exec('DELETE FROM temp.moving');
  };
  verify(first);
  const open = await cli(box, box.seats.actor.path, ['next', '--no-wait']);
  assert.notEqual(open.code, 3, 'an open item keeps the board unfinished: ' + printed(open));
  verify(second);
  const done = await cli(box, box.seats.sibling.path, ['next', '--no-wait']);
  assert.equal(done.code, 4, 'a lane with no items of its own is not finished: ' + printed(done));
  const finished = await cli(box, box.seats.actor.path, ['next', '--no-wait']);
  assert.equal(finished.code, 3, printed(finished));
  assert.ok(printed(finished).includes('next: board finished: every item in web is verified. Stop.'), printed(finished));
  const events = box.board.db.prepare("SELECT event_kind k FROM event WHERE event_kind='next-finished'").all();
  assert.equal(events.length, 1, 'the finished observation was recorded');
});
