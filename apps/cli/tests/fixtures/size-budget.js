/** Shared real-size board for the command-budget journeys: one seeded board, five commands, one bar [C7,#3019]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import {
  fileFixtureItem,
  joinFixtureSeat,
} from './testkit.js';

/** The bars: a command is slow at a p50 of one second or more; 200 ms is the goal each run prints against [#3019]. */
export const MAX_P50_MS = 1000;
export const GOAL_MS = 200;
export const ROUNDS = 5;

/** Seed the real tables at roughly the production population, so scans and per-seat reads show up. */
function seed(file) {
  const db = new DatabaseSync(file);
  const at = '2026-10-23T00:00:00.000Z';
  db.exec('BEGIN');
  const agent = db.prepare('INSERT INTO agent (agent_id, agent_lane, agent_path, agent_created_at) VALUES (?, ?, ?, ?)');
  for (let n = 1; n <= 800; n++) agent.run(`api-${n}`, 'api', `/seats/${n}`, at);
  const item = db.prepare(`INSERT INTO item (item_lane, item_title, item_criterion, item_status,
    item_created_by, item_created_at, item_updated_at) VALUES ('api', ?, 'The work is done.', 'open', 'coordinator', ?, ?)`);
  for (let n = 1; n <= 1000; n++) item.run(`Item ${n}`, at, at);
  const event = db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)');
  for (let n = 0; n < 45000; n++) event.run(at, `api-${1 + n % 800}`, n % 40 === 0 ? 'join' : n % 2 ? 'claim' : 'edit', 1 + n % 1000, '{}');
  const meta = db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)');
  for (let n = 0; n < 150000; n++) meta.run(`local:note-${n}`, `value ${n}`);
  const shout = db.prepare('INSERT INTO shout (shout_from, shout_to, shout_text, shout_at) VALUES (?, ?, ?, ?)');
  for (let n = 0; n < 23000; n++) shout.run(`api-${1 + n % 800}`, 'all', `Board activity ${n}`, at);
  db.exec('COMMIT');
  db.close();
}

/** Run one real CLI process through the resident board and return its wall time and output; the command must not crash. */
export function timed(box, cwd, ...args) {
  const started = performance.now();
  const result = box.run(cwd, ...args);
  const ms = performance.now() - started;
  assert.equal(typeof result.code, 'number', `${args.join(' ')} did not finish: ${result.err}`);
  return { ms, out: result.out, code: result.code, err: result.err };
}

/** Run one CLI call in this process through the production dispatcher and return its wall time and output: the command's own work, without a node start-up that a loaded runner stretches to seconds [C7]. */
async function timedIn(box, cwd, ...args) {
  const started = performance.now();
  const result = await box.runIn(cwd, ...args);
  const ms = performance.now() - started;
  assert.equal(typeof result.code, 'number', `${args.join(' ')} did not finish: ${result.err}`);
  return { ms, out: result.out, code: result.code, err: result.err };
}

/** The middle of a sample, by rank. */
export const p50 = values => [...values].sort((a, b) => a - b)[values.length >> 1];

/** Seed the real-size board and join a web seat that keeps its lane; returns the seat's folder. */
function seatOnRealSizeBoard(box) {
  seed(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  const dir = join(box.dir, 'web-budget');
  box.git(box.repo, 'worktree', 'add', '-q', dir, '-b', 'web/budget');
  assert.equal(joinFixtureSeat(box, dir, 'web', { lockLane: true }).code, 0, 'the seat joins and keeps its lane');
  return dir;
}

/** File one diagnosed web item in this process (no node start-up), so next offers it ahead of the seeded rows [#6998]. */
async function file(box, title) { return (await fileFixtureItem(box, box.repo, { lane: 'web', title, run: box.runLocal })).item_id; }

/** Measure one of next, next --take and next --verify, one file each so a loaded runner never nears the file budget; a claimed item is released, untimed, before the next round [#6998]. */
export async function measureNext(box, command) {
  const dir = seatOnRealSizeBoard(box);
  const samples = { [command]: [] };
  const args = command.split(' ');
  // Round -1 is a warm-up: the first in-process call loads the command's modules, which a real process pays once per run, not per call.
  for (let round = -1; round < ROUNDS; round++) {
    await file(box, `Budget work ${round}.0`);
    await file(box, `Budget work ${round}.1`);
    const run = await timedIn(box, dir, ...args);
    if (round >= 0) samples[command].push(run.ms);
    if (command !== 'next --take') continue;
    assert.equal(run.code, 0, `next --take: ${run.err}${run.out}`);
    // The queue hands out the lowest open item, which may be one an earlier round left open.
    const held = /#(\d+)\b/.exec(run.out)?.[1];
    assert.ok(held, `next --take names the item it claimed: ${run.out}`);
    assert.equal((await box.runLocal(dir, 'release', held, '--reason', 'OTHER', '--note', 'round done', '--no-next')).code, 0);
  }
  return samples;
}

/** Measure claim and release of one filed item per round, in this process like next, so a loaded runner's node start-up is not billed to the command [#6998,C7]. */
export async function measureClaimRelease(box) {
  const dir = seatOnRealSizeBoard(box);
  const samples = { claim: [], release: [] };
  // Round -1 is a warm-up: the first in-process call loads the command's modules, which a real process pays once per run.
  for (let round = -1; round < ROUNDS; round++) {
    const id = String(await file(box, `Budget work ${round}`));
    const claim = await timedIn(box, dir, 'claim', id);
    if (round >= 0) samples.claim.push(claim.ms);
    assert.equal(claim.code, 0, `claim: ${claim.err}${claim.out}`);
    const release = await timedIn(box, dir, 'release', id, '--reason', 'OTHER', '--note', 'measured the release', '--no-next');
    if (round >= 0) samples.release.push(release.ms);
    assert.equal(release.code, 0, `release: ${release.err}${release.out}`);
  }
  return samples;
}

/** Print each command's p50 against the goal and return the ones at or over the bar. */
export function slowCommands(t, samples) {
  const slow = [];
  for (const [name, values] of Object.entries(samples)) {
    const middle = p50(values);
    t.diagnostic(`${name}: p50 ${middle.toFixed(0)} ms against the ${GOAL_MS} ms goal and the ${MAX_P50_MS} ms bar (${middle < GOAL_MS ? 'meets' : 'misses'} the goal); samples ${values.map(ms => ms.toFixed(0)).join(' ')}`);
    if (!(middle < MAX_P50_MS)) slow.push(`${name} p50 ${middle.toFixed(0)} ms is not under ${MAX_P50_MS} ms`);
  }
  return slow;
}
