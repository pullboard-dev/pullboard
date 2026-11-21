/** Many seats on one board: next started at once on every seat hands each a distinct item, one review reserved once, no BOARD_BUSY [C7,#11026]. */
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../../packages/store/index.js';
import { cli } from '../../../fixtures/next/take.js';
import { fixture } from '../../../fixtures/next/take.js';
import { joinFixtureSeat } from '../../../../../../packages/gate/tests/fixtures/testkit.js';

const SEATS = 12;
/** The bar's bound on one herd: a call still running after it counts as stalled. */
const HERD_BOUND_MS = 90_000;

/** A board at the real time, with `count` web seats beside the fixture's own, each a real linked worktree. */
async function herdBoard(t, count) {
  const box = await fixture(t, { perSeat: 1 });
  const seats = [];
  for (let index = 0; index < count; index++) {
    const path = join(dirname(box.root), `herd-${index}`);
    box.git(box.root, 'worktree', 'add', '-q', '-b', `web/herd-${index}`, path);
    // Each seat joins through the real command, as a builder seat does.
    const joined = await joinFixtureSeat(box, path, 'web', { run: (cwd, ...args) => cli(box, cwd, args.filter(arg => arg !== '--json')) });
    assert.equal(joined.code, 0, joined.out + joined.err);
    seats.push({ id: store.agentAt(box.board, path).agent_id, path });
  }
  for (const seat of Object.values(box.seats)) store.heartbeatSeat(box.board, seat.id);
  return { box, seats };
}

/** Run `pullboard next --json` in a seat through the in-process cli helper; resolve with its exit, output and wall time, or as stalled at the bound. */
async function nextCall(box, seat) {
  const started = Date.now();
  let timer;
  const stalled = new Promise(resolve => { timer = setTimeout(() => resolve({ code: null, signal: 'STALLED', out: '', err: '', document: null }), HERD_BOUND_MS); });
  try {
    const run = await Promise.race([cli(box, seat.path, ['next']).catch(error => ({ code: 1, signal: null, out: '', err: String(error?.message ?? error), document: null })), stalled]);
    return { seat: seat.id, signal: null, ...run, ms: Date.now() - started };
  } finally { clearTimeout(timer); }
}

test('cli.journeys-next-herd.twelve-seats-distinct: clause 1: 12 next calls started together with one submitted review and 12 open builds each end with a distinct item, one of them the review, and none BOARD_BUSY or NEXT_TIMEOUT [C7,#11026]', { timeout: 240_000 }, async t => {
  const { box, seats } = await herdBoard(t, SEATS);
  const builds = Array.from({ length: SEATS }, (_, index) => box.add(`Herd build ${index}`, { brief: `Files: web/herd-${index}.js\nTest: one seat claims it.` }));
  const review = box.add('Herd review', { brief: 'Files: web/herd-review.js\nTest: one seat reviews it.' });
  box.submit(review);
  const started = Date.now();
  const runs = await Promise.all(seats.map(seat => nextCall(box, seat)));
  const wall = Date.now() - started;
  const report = runs.map(run => `${run.seat} exit ${run.code} ${run.ms} ms item ${run.document?.item?.item_id ?? '-'}${run.document?.review ? ' (review)' : ''} ${run.code || run.signal ? (run.err || run.out).split('\n').filter(Boolean).slice(-2).join(' | ') : ''}`).join('\n');
  t.diagnostic(`herd wall ${wall} ms\n${report}`);
  for (const run of runs) {
    assert.doesNotMatch(run.out + run.err, /BOARD_BUSY|NEXT_TIMEOUT/u, `${run.seat} hit the herd:\n${report}`);
    assert.equal(run.signal, null, `${run.seat} was still running at the bound and was stopped:\n${report}`);
    assert.equal(run.code, 0, `${run.seat} failed:\n${report}`);
  }
  const handed = runs.map(run => run.document?.item?.item_id).filter(Number.isSafeInteger);
  assert.equal(new Set(handed).size, handed.length, `two seats were handed one item:\n${report}`);
  assert.equal(runs.filter(run => run.document?.review === true).length, 1, `the one review goes to exactly one seat:\n${report}`);
  assert.equal(store.getItem(box.board, review).item_review_by !== null, true, 'the review is reserved');
  for (const id of handed.filter(id => id !== review)) assert.ok(builds.includes(id), `#${id} is one of the open builds`);
});
