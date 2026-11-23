/**
 * The resident client sends test --status to the resident process and frees a slot whose command is wedged past the
 * per-command ceiling [C7,#5470]. On 10 Nov all four slots held commands hung for 3-11 h, so every call ran cold.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import {
  NEXT_DEFAULT_WAIT_MS,
  RESIDENT_COMMAND_CEILING_MS,
  RESIDENT_WEDGED_GRACE_MS,
  residentBusy,
  residentBusyFile,
  residentCeilingFor,
  residentCommand,
  residentCommandCeiling,
  residentDeclaredWait,
  withinCommandCeiling,
} from '../../../src/io/resident/client.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import {
  cli,
  fixture,
} from '../../fixtures/next/take.js';

const dir = privateFixtureFiles('pb-ceiling-').root;
after(() => rmSync(dir, { recursive: true, force: true }));

test('cli.io-resident-board.test-status-is-a-resident-command-a: clause 2: test --status is a resident command; a test run, --wait and --test-run are not [C7,#5470]', () => {
  assert.equal(residentCommand(['test', '--status', 'abc']), true);
  assert.equal(residentCommand(['test', '--status=abc']), true);
  assert.equal(residentCommand(['test', 'a.test.js']), false);
  assert.equal(residentCommand(['test', '--test-run', 'abc', '--status', 'abc']), false);
  assert.equal(residentCommand(['test', '--status', 'abc', '--wait']), false);
  assert.equal(residentCommand(['test', '--status', 'abc', '--as', 'person']), false);
  assert.equal(residentCommand(['show', '1']), true);
});

test('cli.io-resident-board.the-ceiling-defaults-to-60-s-and: clause 1: the ceiling defaults to 60 s and PULLBOARD_RESIDENT_COMMAND_MS overrides it [C7,#5470]', () => {
  assert.equal(residentCommandCeiling({}), RESIDENT_COMMAND_CEILING_MS);
  assert.equal(RESIDENT_COMMAND_CEILING_MS, 60_000);
  assert.equal(residentCommandCeiling({ PULLBOARD_RESIDENT_COMMAND_MS: '1500' }), 1500);
  assert.equal(residentCommandCeiling({ PULLBOARD_RESIDENT_COMMAND_MS: 'x' }), RESIDENT_COMMAND_CEILING_MS);
});

test('cli.io-resident-board.a-slot-whose-command-ran-past-the: clause 1: a slot whose command ran past the ceiling is wedged: its process is ended and the slot reads free [C7,#5470]', async () => {
  const pidFile = join(dir, 'w.pid');
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const exited = new Promise(done => holder.on('exit', done));
  writeFileSync(pidFile, `${holder.pid}\n`);
  const busy = residentBusyFile(pidFile);
  const now = Date.now();
  try {
    writeFileSync(busy, `${holder.pid} ${now - 5_000}\n`);
    assert.equal(residentBusy(pidFile, now), true, 'a command inside the ceiling keeps its slot busy');
    writeFileSync(busy, `${holder.pid} ${now - RESIDENT_COMMAND_CEILING_MS - RESIDENT_WEDGED_GRACE_MS - 1}\n`);
    assert.equal(residentBusy(pidFile, now), false, 'a command past the ceiling frees the slot');
    await exited;
    assert.equal(existsSync(busy), false);
    assert.equal(existsSync(pidFile), false);
  } finally { holder.kill('SIGKILL'); }
});

test('cli.io-resident-board.a-busy-file-naming-a-process-the: clause 1: a busy file naming a process the pid file does not name is never signalled [C7,#5470]', async () => {
  const pidFile = join(dir, 'x.pid');
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  writeFileSync(pidFile, '999999\n');
  writeFileSync(residentBusyFile(pidFile), `${bystander.pid} ${Date.now() - 10 * 60_000}\n`);
  try {
    residentBusy(pidFile);
    assert.equal(bystander.exitCode, null);
    assert.doesNotThrow(() => process.kill(bystander.pid, 0));
  } finally { bystander.kill('SIGKILL'); }
});

const CEILING_LINE = '[RESIDENT_COMMAND_CEILING]';
const IDLE_LINE = '[IDLE_TIMEOUT] nothing for this seat in 90 seconds; the board is not finished. Stop, or call next again.';

/**
 * One fake clock for both the ceiling timer and next's wait: a sleep moves the time on by at most 30 s and fires
 * every timer then due, so a case crosses 60 and 90 s without waiting for them.
 */
function fakeClock(start = 1_000_000) {
  let now = start;
  const due = new Set();
  const advance = (to) => {
    now = Math.max(now, to);
    for (const timer of [...due]) if (timer.at <= now) { due.delete(timer); timer.fire(); }
  };
  return {
    start,
    now: () => now,
    advance,
    timers: { setTimeout: (fire, ms) => { const timer = { at: now + ms, fire }; due.add(timer); return timer; }, clearTimeout: timer => due.delete(timer) },
    waitClock: { now: () => now, sleep: async (_wake, { deadline }) => advance(Math.min(now + 30_000, deadline)) },
  };
}

/** Serve one command as the resident board does: under the ceiling its arguments give, on the fake clock. */
function served(clock, argv, command) {
  let said = '';
  const status = withinCommandCeiling(command, { ceiling: residentCeilingFor(argv, {}), timers: clock.timers,
    onCeiling: () => { said += `pullboard: ${CEILING_LINE} the resident process ended this command\n`; return 1; } });
  return status.then(code => ({ code, said }));
}

test('cli.io-resident-board.waiting-next-outlives-the-ceiling: clause 1: a plain next served by the resident board that waits past 60 s on a fake clock returns its own exit 4 idle line, not RESIDENT_COMMAND_CEILING [N41,#13008]', async (t) => {
  const box = await fixture(t, { seats: ['actor'] });
  const clock = fakeClock();
  const argv = ['next', '--json'];
  assert.equal(residentCommand(argv), true, 'plain next is served by the resident board');
  const ran = cli(box, box.seats.actor.path, ['next'], { nextWaitClock: clock.waitClock });
  const answer = await served(clock, argv, ran.then(result => result.code));
  const result = await ran;
  assert.equal(clock.now() - clock.start, NEXT_DEFAULT_WAIT_MS, 'next waited its full 90 s on the fake clock');
  assert.ok(clock.now() - clock.start > RESIDENT_COMMAND_CEILING_MS, 'the wait ran past the 60 s ceiling');
  assert.equal(answer.code, 4, result.out + result.err);
  assert.equal(answer.said, '', 'the ceiling never ended the waiting next');
  assert.ok((result.out + result.err).includes(IDLE_LINE), result.out + result.err);
  assert.ok(!(result.out + result.err).includes(CEILING_LINE));
});

test('cli.io-resident-board.other-commands-keep-the-ceiling: clause 1: every command but a waiting next keeps the 60 s ceiling, which still ends a hung command at 60 s on a fake clock [C7,#13008]', async () => {
  assert.equal(residentDeclaredWait(['next']), NEXT_DEFAULT_WAIT_MS);
  assert.equal(residentDeclaredWait(['next', '--json']), NEXT_DEFAULT_WAIT_MS);
  assert.equal(residentDeclaredWait(['next', '--wait', '5']), 5 * 60_000);
  assert.equal(residentDeclaredWait(['next', '--wait=2']), 2 * 60_000);
  for (const argv of [['next', '--no-wait'], ['next', '--take'], ['next', '--build'], ['next', '--verify', '7'], ['next', '--wait', '0'],
    ['show', '1'], ['status'], ['claim', '1'], ['test', '--status', 'abc']]) {
    assert.equal(residentDeclaredWait(argv), 0, argv.join(' '));
    assert.equal(residentCeilingFor(argv, {}), RESIDENT_COMMAND_CEILING_MS, argv.join(' '));
  }
  assert.equal(residentCeilingFor(['next'], {}), RESIDENT_COMMAND_CEILING_MS + NEXT_DEFAULT_WAIT_MS);
  assert.equal(residentCeilingFor(['status'], { PULLBOARD_RESIDENT_COMMAND_MS: '1500' }), 1500, 'the override still sets the plain ceiling');
  const clock = fakeClock();
  const hung = served(clock, ['status'], new Promise(() => {}));
  let settled = false;
  hung.then(() => { settled = true; });
  clock.advance(clock.start + RESIDENT_COMMAND_CEILING_MS - 1);
  await Promise.resolve();
  assert.equal(settled, false, 'a command inside 60 s keeps running');
  clock.advance(clock.start + RESIDENT_COMMAND_CEILING_MS);
  const answer = await hung;
  assert.equal(answer.code, 1);
  assert.ok(answer.said.includes(CEILING_LINE), answer.said);
});

test('cli.io-resident-board.busy-file-carries-the-command-ceiling: clause 1: a busy file naming its command ceiling keeps a waiting next busy, not wedged, past the 60 s ceiling and its grace [C7,#13008]', () => {
  // This process stands in for the resident one: inside its own ceiling it is never signalled.
  const pidFile = join(dir, 'n.pid');
  writeFileSync(pidFile, `${process.pid}\n`);
  const busy = residentBusyFile(pidFile);
  const ceiling = residentCeilingFor(['next'], {});
  const now = Date.now();
  writeFileSync(busy, `${process.pid} ${now - RESIDENT_COMMAND_CEILING_MS - RESIDENT_WEDGED_GRACE_MS - 20_000} ${ceiling}\n`);
  assert.equal(residentBusy(pidFile, now, {}), true, 'a next 90 s into its wait is busy, not wedged');
  assert.equal(existsSync(pidFile), true, 'its pid file is kept');
  assert.equal(existsSync(busy), true, 'its busy file is kept');
});
