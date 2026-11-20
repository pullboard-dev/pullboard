/** Several seats asking next on one board with queue.contention on: the items handed out are the largest set whose predicted files are disjoint [C7,#1440]. */
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { cli } from '../../tests/fixtures/next/take.js';
import { fixture } from '../../tests/fixtures/next/take.js';
import { joinFixtureSeat } from '../../../../packages/gate/tests/fixtures/testkit.js';

const SEATS = 3;

/** A board with queue.contention on and four ready items: A{x}, B{x,y}, C{y}, D{z}, so the largest disjoint wave is A, C and D and B waits. */
async function waveBoard(t) {
  const box = await fixture(t, { projectConfig: { queue: { contention: true } } });
  const seats = [];
  for (let index = 0; index < SEATS; index++) {
    const path = join(dirname(box.root), `wave-${index}`);
    box.git(box.root, 'worktree', 'add', '-q', '-b', `web/wave-${index}`, path);
    const joined = await joinFixtureSeat(box, path, 'web', { run: (cwd, ...args) => cli(box, cwd, args.filter(arg => arg !== '--json')) });
    assert.equal(joined.code, 0, joined.out + joined.err);
    seats.push({ id: store.agentAt(box.board, path).agent_id, path });
  }
  for (const seat of Object.values(box.seats)) store.heartbeatSeat(box.board, seat.id);
  const make = (title, files) => box.add(title, { brief: `Files: ${files.join(', ')}\nTest: one seat claims it.` });
  const ids = { a: make('Wave A', ['web/x.js']), b: make('Wave B', ['web/x.js', 'web/y.js']), c: make('Wave C', ['web/y.js']), d: make('Wave D', ['web/z.js']) };
  return { box, seats, ids };
}

/** Each seat in turn runs the real `pullboard next`, which claims what it hands out; the answers come back in order. */
async function askInTurn(box, seats) {
  const answers = [];
  for (const seat of seats) {
    const run = await cli(box, seat.path, ['next']);
    assert.equal(run.code, 0, run.out + run.err);
    answers.push(run.document);
  }
  return answers;
}

test('cli.journeys-next-wave.largest-disjoint-set: clause 1: with queue.contention on and overlapping ready items, three seats running next are handed the largest set whose predicted files are disjoint [C7,#1440]', { timeout: 240_000 }, async t => {
  const { box, seats, ids } = await waveBoard(t);
  const answers = await askInTurn(box, seats);
  const handed = answers.map(answer => answer?.item?.item_id);
  assert.deepEqual(handed.toSorted((a, b) => a - b), [ids.a, ids.c, ids.d].toSorted((a, b) => a - b), JSON.stringify(answers.map(answer => answer?.reasons)));
});

test('cli.journeys-next-wave.overlap-waits-naming-the-file: clause 2: no two items handed out in one wave share a predicted file, and the item that overlaps a handed one waits with a reason naming the shared file [C7,#1440]', { timeout: 240_000 }, async t => {
  const { box, seats, ids } = await waveBoard(t);
  const answers = await askInTurn(box, seats);
  const handed = answers.map(answer => answer?.item?.item_id);
  assert.equal(handed.includes(ids.b), false, 'the item that overlaps two others is not handed out');
  const filesOf = id => store.getItem(box.board, id).item_brief.match(/^Files: (.*)$/mu)[1].split(', ');
  const claimedFiles = handed.flatMap(filesOf);
  assert.equal(new Set(claimedFiles).size, claimedFiles.length, `two handed items share a file: ${claimedFiles.join(' ')}`);
  const reasons = answers.flatMap(answer => answer?.reasons ?? []);
  assert.ok(reasons.some(line => line.startsWith(`#${ids.b} waits for `) && /on web\/[xy]\.js$/u.test(line)), `no reason names the file #${ids.b} waits on:\n${reasons.join('\n')}`);
});
