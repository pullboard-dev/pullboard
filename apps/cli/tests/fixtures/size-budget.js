/** Shared real-size board for the command-budget journeys: one seeded board, five commands, one bar [C7,#3019]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadavg } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { HISTORY_BOARD } from './board/large.js';
import { largeBoard } from './board/large.js';
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

/** Measure next as a user runs it: each round is one cold spawned CLI process, node start-up included; one warm-up round is untimed [C7]. */
export async function measureColdNext(box, t) {
  const dir = seatOnRealSizeBoard(box);
  const samples = { 'cold next': [] };
  t.diagnostic(`cold next runner load average before samples: ${loadavg().map(value => value.toFixed(2)).join(' ')}`);
  for (let round = -1; round < ROUNDS; round++) {
    await file(box, `Cold work ${round}.0`);
    await file(box, `Cold work ${round}.1`);
    const run = timed(box, dir, 'next');
    assert.equal(run.code, 0, `cold next exited ${run.code}: ${run.err}${run.out}`);
    if (round >= 0) samples['cold next'].push(run.ms);
  }
  const { floor, top, children } = coldNextPhases(box, dir);
  t.diagnostic(`cold next phases: process start and exit alone ${floor.toFixed(0)} ms; next's self time by file: ${top.join('; ')}`);
  t.diagnostic(`cold next child processes (${children.length}): ${children.slice(0, 12).join(' | ')}`);
  return samples;
}

/** Measure five cold spawned `next` processes on the recorded 1:4 live history board. */
export async function measureColdHistoryNext(t) {
  const box = largeBoard(t, { scale: HISTORY_BOARD });
  const samples = { 'HISTORY_BOARD cold next': [] };
  t.diagnostic(`HISTORY_BOARD cold next runner load average before samples: ${loadavg().map(value => value.toFixed(2)).join(' ')}`);
  for (let round = -1; round < ROUNDS; round++) {
    const run = timed(box, box.web, 'next');
    assert.equal(run.code, 0, `HISTORY_BOARD cold next exited ${run.code}: ${run.err}${run.out}`);
    if (round >= 0) samples['HISTORY_BOARD cold next'].push(run.ms);
  }
  return samples;
}

/** Where one cold next spends its time: a process that only starts and exits (the floor), then the same next profiled, as self time by file, so a miss names its slow phase [C7,#8547]. */
export function coldNextPhases(box, dir) {
  const floor = timed(box, dir, '--version').ms;
  const prof = join(box.dir, 'cold-prof');
  mkdirSync(prof, { recursive: true });
  // A preload that logs every child process next starts and how long a synchronous one took, so the slow phase is named by command.
  const log = join(prof, 'children.log');
  const preload = join(prof, 'children.cjs');
  writeFileSync(preload, `const cp = require('node:child_process'); const fs = require('node:fs'); const { performance } = require('node:perf_hooks');
for (const name of ['spawnSync', 'execFileSync', 'execSync', 'spawn', 'execFile']) {
  const original = cp[name];
  cp[name] = function (...args) {
    const started = performance.now();
    try { return original.apply(this, args); }
    finally { fs.appendFileSync(${JSON.stringify(log)}, name + ' ' + String(args[0]).slice(0, 60) + ' ' + JSON.stringify(Array.isArray(args[1]) ? args[1] : []).slice(0, 70) + ' ' + (performance.now() - started).toFixed(0) + ' ms\\n'); }
  };
}
require('node:module').syncBuiltinESMExports();`);
  const before = box.env.NODE_OPTIONS;
  box.env.NODE_OPTIONS = `${before ?? ''} --cpu-prof --cpu-prof-dir=${prof} --require=${preload}`.trim();
  try { timed(box, dir, 'next'); } finally { if (before === undefined) delete box.env.NODE_OPTIONS; else box.env.NODE_OPTIONS = before; }
  const self = new Map();
  for (const name of readdirSync(prof).filter(file => file.endsWith('.cpuprofile'))) {
    const profile = JSON.parse(readFileSync(join(prof, name), 'utf8'));
    const byId = new Map(profile.nodes.map(node => [node.id, node]));
    profile.samples.forEach((id, at) => {
      const url = byId.get(id).callFrame.url.replace(/^.*\/(?=(?:apps|packages)\/)/u, '') || byId.get(id).callFrame.functionName || '(native)';
      self.set(url, (self.get(url) ?? 0) + (profile.timeDeltas[at] ?? 0) / 1000);
    });
  }
  const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([url, ms]) => `${url} ${ms.toFixed(0)} ms`);
  let children = [];
  try { children = readFileSync(log, 'utf8').trim().split('\n'); } catch { /* No child process started. */ }
  return { floor, top, children };
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
  t.diagnostic(`runner load average after samples: ${loadavg().map(value => value.toFixed(2)).join(' ')}`);
  const slow = [];
  for (const [name, values] of Object.entries(samples)) {
    const middle = p50(values);
    t.diagnostic(`${name}: p50 ${middle.toFixed(0)} ms against the ${GOAL_MS} ms goal and the ${MAX_P50_MS} ms bar (${middle < GOAL_MS ? 'meets' : 'misses'} the goal); samples ${values.map(ms => ms.toFixed(0)).join(' ')}`);
    if (!(middle < MAX_P50_MS)) slow.push(`${name} p50 ${middle.toFixed(0)} ms is not under ${MAX_P50_MS} ms`);
  }
  return slow;
}

/** Report the runner load that surrounded one timing case. */
export function runnerLoad() { return loadavg().map(value => value.toFixed(2)).join(' '); }
