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
import { main } from '../../fixtures/native.js';
import { captureCommandInProcess } from '../../fixtures/process.js';

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
const NO_WAIT_IDLE_LINE = '[IDLE_TIMEOUT] nothing for this seat right now, and next did not wait; the board is not finished. Stop, or call next again.';
const DEFAULT_IDLE_MS = 90_000;
const DEFAULT_IDLE_STEP_MS = 30_000;

/** Every number and word the answer printed, whichever stream or JSON field carried it. */
const printed = ran => ran.out + ran.err;

/** Drive a plain next through the production dispatcher without sleeping for its real idle deadline. */
function drivenNext(box, cwd, clock, ...args) {
  return captureCommandInProcess((argv, io) => main(argv, { ...io, nextWaitClock: clock }), ['next', ...args], { cwd, env: box.env });
}

test('cli.io-commands-next.no-wait-idle-exit-4: clause 1: next --no-wait on a board with nothing for the seat prints the IDLE_TIMEOUT line first and exits 4 at once; a held review still refuses REVIEW_HELD at once, and plain next without the flag is unchanged [C7,#12779]', async t => {
  const box = await fixture(t);
  let fake = 1_000_000;
  const began = fake, seen = [];
  let sleeps = 0;
  const clock = {
    now: () => { seen.push(fake); return fake; },
    sleep: async (wake, { deadline }) => { sleeps += 1; fake = Math.min(fake + DEFAULT_IDLE_STEP_MS, Number.isFinite(deadline) ? Math.max(deadline, fake) : Infinity); },
  };
  const plain = await drivenNext(box, box.seats.actor.path, clock);
  assert.equal(plain.code, 4, printed(plain));
  assert.ok(printed(plain).includes(IDLE_LINE), 'plain next on a lane with no items reports the idle timeout');
  assert.equal(fake - began, DEFAULT_IDLE_MS, `plain next returned after ${fake - began} ms of simulated time instead of the 90 second default`);
  assert.ok(seen.some(at => at > began && at < began + DEFAULT_IDLE_MS), 'plain next did not read the clock while waiting through its default deadline');
  assert.ok(sleeps >= DEFAULT_IDLE_MS / DEFAULT_IDLE_STEP_MS, `plain next traversed only ${sleeps} fake-clock sleeps before its 90 second deadline`);
  const plainEvents = box.board.db.prepare("SELECT event_kind k FROM event WHERE event_kind IN ('next-idle-timeout','next-finished')").all().map(row => row.k);
  assert.deepEqual(plainEvents, ['next-idle-timeout'], 'plain next records one timeout and no finished event');
  const ran = await cli(box, box.seats.actor.path, ['next', '--no-wait']);
  assert.equal(ran.code, 4, printed(ran));
  assert.ok(printed(ran).includes(NO_WAIT_IDLE_LINE), printed(ran));
  const events = box.board.db.prepare("SELECT event_kind k FROM event WHERE event_kind IN ('next-idle-timeout','next-finished')").all().map(row => row.k);
  assert.deepEqual(events, ['next-idle-timeout', 'next-idle-timeout'], 'explicit --no-wait adds one timeout and no finished event');
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
  assert.equal(done.code, 3, 'finished is judged per board, so a lane with no items of its own sees a landed board as finished: ' + printed(done));
  assert.match(printed(done), /next: board finished: every item in the board is verified\. Stop\./u, printed(done));
  const finished = await cli(box, box.seats.actor.path, ['next', '--no-wait']);
  assert.equal(finished.code, 3, printed(finished));
  assert.ok(printed(finished).includes('next: board finished: every item in web is verified. Stop.'), printed(finished));
  const events = box.board.db.prepare("SELECT event_kind k FROM event WHERE event_kind='next-finished'").all();
  assert.equal(events.length, 2, 'each finished answer recorded its observation');

  let fake = 1_000_000, sleeps = 0;
  const began = fake;
  const clock = {
    now: () => fake,
    sleep: async (wake, { deadline }) => { sleeps += 1; fake = Math.min(fake + DEFAULT_IDLE_STEP_MS, Number.isFinite(deadline) ? Math.max(deadline, fake) : Infinity); },
  };
  const plainFinished = await drivenNext(box, box.seats.actor.path, clock);
  assert.equal(plainFinished.code, 3, printed(plainFinished));
  assert.match(printed(plainFinished), /next: board finished: every item in web is verified\. Stop\./u, printed(plainFinished));
  assert.equal(fake - began, DEFAULT_IDLE_MS, `plain next returned the finished line after ${fake - began} ms of simulated time instead of its default deadline`);
  assert.ok(sleeps >= DEFAULT_IDLE_MS / DEFAULT_IDLE_STEP_MS, `plain next traversed only ${sleeps} fake-clock sleeps before finishing`);
});

test('cli.io-commands-next.recheck-cadence: clause 2: plain next rechecks after 1, 2, 4, 8, 16 then 30 seconds, caps its default at 90 seconds, and honors a two minute override [C7,#12807]', async t => {
  for (const [minutes, args, intervals] of [
    [10, [], [1000, 2000, 4000, 8000, 16000, 30000, 29000]],
    [1, [], [1000, 2000, 4000, 8000, 16000, 29000]],
    [10, ['--wait', '2'], [1000, 2000, 4000, 8000, 16000, 30000, 30000, 29000]],
  ]) {
    const box = await fixture(t, { projectConfig: { next: { idleMinutes: minutes } } });
    let fake = 1_000_000;
    const slept = [];
    const clock = { now: () => fake, sleep: async (wake, { deadline }) => { slept.push(deadline - fake); fake = deadline; } };
    const result = await drivenNext(box, box.seats.actor.path, clock, ...args);
    assert.equal(result.code, 4, printed(result));
    assert.deepEqual(slept, intervals);
    assert.doesNotMatch(printed(result), /board finished/u);
    assert.match(printed(result), /next waiting for .+; no item selected/u);
  }
});

test('cli.io-commands-next.native-offer-wake: clause 2: an item filed through the CLI eight seconds into plain or explicit waiting is selected on that wake without another sleep [C7,#12807]', async t => {
  for (const args of [[], ['--wait', '2']]) {
    const box = await fixture(t);
    let fake = 1_000_000, filed = null;
    const began = fake;
    const clock = {
      now: () => fake,
      sleep: async (wake, { after, deadline }) => {
        assert.equal(filed, null, 'newly filed work must be inspected before another sleep');
        fake = Math.min(deadline, began + 8000);
        if (fake < began + 8000) return;
        const added = await cli(box, box.root, ['add', 'web', 'Native offer at eight seconds', '--specs', 'G1', '--criterion', 'The real fixture succeeds.', '--check', 'true', '--brief', 'Files: web/dispatch.js\nTest: native next selects this item.']);
        assert.equal(added.code, 0, printed(added));
        filed = added.document.item.item_id;
        await wake.wait({ after });
      },
    };
    const result = await drivenNext(box, box.seats.actor.path, clock, ...args);
    assert.equal(result.code, 0, printed(result));
    assert.equal(fake - began, 8000);
    assert.match(printed(result), new RegExp(`claimed #${filed}\\b`, 'u'));
    const events = box.board.db.prepare("SELECT event_kind FROM event WHERE item_id=? ORDER BY event_id").all(filed).map(row => row.event_kind);
    assert.ok(events.includes('add'), JSON.stringify(events));
    assert.ok(events.includes('claim'), JSON.stringify(events));
  }
});

test('cli.io-commands-next.plain-review: clause 1: plain next returns the next-to-verify line with exit 0 when a submission is reviewable [C7,#12807]', async t => {
  const box = await fixture(t);
  const id = box.add('An item ready for independent review');
  box.submit(id);
  const result = await drivenNext(box, box.seats.outside.path, { now: () => 0, sleep: async () => assert.fail('reviewable work must return before waiting') });
  assert.equal(result.code, 0, printed(result));
  assert.match(printed(result), new RegExp(`next to verify: #${id}\\b`, 'u'));
});

test('cli.io-commands-next.lag-keeps-waiting: clause 2: the current behind-main instruction does not end a plain next wait [C7,U159,#12807]', async t => {
  const box = await fixture(t);
  writeFileSync(join(box.root, 'main-only.txt'), 'A new main commit.\n');
  box.git(box.root, 'add', 'main-only.txt');
  box.git(box.root, 'commit', '-q', '-m', 'chore: advance fixture main [G1]');
  for (const [args, expected] of [[[], DEFAULT_IDLE_MS], [['--wait', '2'], 120_000]]) {
    let fake = 0, observed = '', sleeps = 0;
    const clock = { now: () => fake, sleep: async (wake, { deadline }) => {
      assert.match(observed, /this checkout is 1 commit behind main/u, 'the lag line arrives before sleeping');
      assert.match(observed, /submit composes current main/u);
      assert.doesNotMatch(observed, /IDLE_TIMEOUT/u, 'the lag line does not end the wait');
      sleeps += 1;
      fake = deadline;
    } };
    const result = await captureCommandInProcess((argv, io) => main(argv, { ...io, nextWaitClock: clock,
      stdout: { ...io.stdout, write: text => { observed += text; return io.stdout.write(text); } },
    }), ['next', ...args], { cwd: box.seats.actor.path, env: box.env });
    assert.equal(result.code, 4, printed(result));
    assert.equal(fake, expected);
    assert.ok(sleeps > 0, 'the behind-main seat continues waiting');
    assert.equal((observed.match(/this checkout is 1 commit behind main/gu) ?? []).length, 1);
    assert.match(printed(result), /next waiting for/u);
  }
  const advancing = await fixture(t);
  let fake = 0, observed = '', advanced = false;
  const clock = { now: () => fake, sleep: async (wake, { deadline }) => {
    if (!advanced) {
      assert.doesNotMatch(observed, /behind main/u, 'a level seat has no lag notice');
      writeFileSync(join(advancing.root, 'main-later.txt'), 'Main advances during the wait.\n');
      advancing.git(advancing.root, 'add', 'main-later.txt');
      advancing.git(advancing.root, 'commit', '-q', '-m', 'chore: advance main during wait [G1]');
      advanced = true;
    } else {
      assert.match(observed, /this checkout is 1 commit behind main/u, 'new lag is reported while the same wait continues');
      assert.match(observed, /submit composes current main/u);
      assert.doesNotMatch(observed, /IDLE_TIMEOUT/u);
    }
    fake = deadline;
  } };
  const result = await captureCommandInProcess((argv, io) => main(argv, { ...io, nextWaitClock: clock,
    stdout: { ...io.stdout, write: text => { observed += text; return io.stdout.write(text); } },
  }), ['next'], { cwd: advancing.seats.actor.path, env: advancing.env });
  assert.equal(result.code, 4, printed(result));
  assert.equal(fake, DEFAULT_IDLE_MS);
  assert.equal((observed.match(/this checkout is 1 commit behind main/gu) ?? []).length, 1);
});
