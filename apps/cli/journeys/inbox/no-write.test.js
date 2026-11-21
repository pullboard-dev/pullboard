/** @pullboard-test-input source-cell apps/cli */
/** With inbox.batchedMarks on, pullboard inbox opens no write board: its delivery and shout marks go to the spool and the worker records them [C7,#8943]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runMarksWorker } from '../../src/io/inbox-marks-worker.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { fixtureProjectPolicy } from '../../tests/fixtures/testkit.js';

/** One CLI call answered in this process with the box's environment. */
async function cli(box, cwd, ...args) {
  const result = await runCliInProcess(args, { cwd, env: box.env });
  return { code: result.code, out: result.out, err: result.err };
}

/** A project with inbox.batchedMarks on and a lease inside the claim-lapsing window, one claim held by the web seat, and two shouts waiting for it. */
async function batchedProject(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  fixtureProjectPolicy(box.repo, { config: { ...config, lease: '4m', inbox: { batchedMarks: true } } });
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: batch inbox marks');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  fileFixtureItem(box, box.repo, { lane: 'web', title: 'Lapsing claim', criterion: 'the installed check passes', check: 'true', args: ['--specs', 'G1'] });
  const claimed = await cli(box, box.web, 'claim', '1');
  assert.equal(claimed.code, 0, `${claimed.out}${claimed.err}`);
  for (const text of ['first waiting shout', 'second waiting shout']) {
    const sent = await cli(box, box.repo, 'shout', 'web-1', text);
    assert.equal(sent.code, 0, `${sent.out}${sent.err}`);
  }
  return box;
}

/** The rows of the machine's board-writes.jsonl, one object per write. */
function writeRows(box) {
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'board-writes.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}

test('cli.journeys-inbox-no-write.read-writes-nothing: clause 1: with inbox.batchedMarks on, one fresh interrupt and two unread shouts, pullboard inbox prints the interrupt and both shouts while board-writes.jsonl gains no row with command inbox [C7,#8943]', async t => {
  const box = await batchedProject(t);
  const before = writeRows(box);
  assert.ok(before.some(row => row.command === 'claim'), 'the log records the setup writes, so an empty answer is not a log that never writes');
  const read = await cli(box, box.web, 'inbox');
  assert.equal(read.code, 0, `${read.out}${read.err}`);
  assert.match(read.out, /interrupt claim:1:\S+: #1 claim is lapsing/u, 'the interrupt is printed');
  assert.match(read.out, /first waiting shout/u);
  assert.match(read.out, /second waiting shout/u);
  const inboxRows = writeRows(box).filter(row => row.command === 'inbox');
  assert.deepEqual(inboxRows, [], 'the read wrote nothing as the inbox command');
});

test('cli.journeys-inbox-no-write.worker-records: clause 2: after runMarksWorker drains the spool, a second pullboard inbox names the interrupt only as pending by id and shows neither shout again [C7,#8943]', async t => {
  const box = await batchedProject(t);
  const boardFile = join(box.repo, '.git/pullboard/board.sqlite');
  const first = await cli(box, box.web, 'inbox');
  assert.equal(first.code, 0, `${first.out}${first.err}`);
  assert.match(first.out, /interrupt claim:1:/u, 'the first read prints the interrupt');
  await runMarksWorker(boardFile);
  // A worker the first read started may hold the spool already; its work file stays until it records, and this drain reads that file too, so nothing is left unrecorded.
  const second = await cli(box, box.web, 'inbox');
  assert.equal(second.code, 0, `${second.out}${second.err}`);
  assert.match(second.out, /1 delivered interrupt still unacted: claim:1:[^;\s]+;/u, 'the interrupt is named by id as pending');
  assert.doesNotMatch(second.out, /interrupt claim:1:\S+: #1/u, 'its text is not printed again');
  assert.doesNotMatch(second.out, /waiting shout/u, 'neither shout is shown again');
});
