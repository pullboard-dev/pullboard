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

/** File one web item; the diagnosis fact is not needed to be claimed, so the fixture skips that process. */
function file(box, title) { return fileFixtureItem(box, box.repo, { lane: 'web', title, diagnose: false }).item_id; }

/** Measure next, next --take and next --verify; the claimed item is released, untimed, before the next round. */
export function measureNext(box) {
  const dir = seatOnRealSizeBoard(box);
  const samples = { next: [], 'next --take': [], 'next --verify': [] };
  for (let round = 0; round < ROUNDS; round++) {
    const ids = [0, 1].map(n => file(box, `Budget work ${round}.${n}`));
    samples.next.push(timed(box, dir, 'next').ms);
    const taken = timed(box, dir, 'next', '--take');
    samples['next --take'].push(taken.ms);
    assert.equal(taken.code, 0, `next --take: ${taken.err}${taken.out}`);
    console.error('IDS', JSON.stringify(ids), JSON.stringify(taken.out.slice(0,80)));
    const held = ids.find(id => new RegExp(`#${id}\\b`).test(taken.out));
    assert.ok(held, `next --take names one of the filed items ${ids.join(', ')}: ${taken.out}`);
    samples['next --verify'].push(timed(box, dir, 'next', '--verify').ms);
    assert.equal(box.run(dir, 'release', String(held), '--reason', 'OTHER', '--note', 'round done', '--no-next').code, 0);
  }
  return samples;
}

/** Measure claim and release of one filed item per round. */
export function measureClaimRelease(box) {
  const dir = seatOnRealSizeBoard(box);
  const samples = { claim: [], release: [] };
  for (let round = 0; round < ROUNDS; round++) {
    const id = String(file(box, `Budget work ${round}`));
    const claim = timed(box, dir, 'claim', id);
    samples.claim.push(claim.ms);
    assert.equal(claim.code, 0, `claim: ${claim.err}${claim.out}`);
    const release = timed(box, dir, 'release', id, '--reason', 'OTHER', '--note', 'measured the release', '--no-next');
    samples.release.push(release.ms);
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
