import { readMainAudit } from '../../../../../packages/gate/index.js';
import { closePolicySourceWake } from '../landing/queue.js';
import { writeFileSync } from 'node:fs';
import { waitForFixtureProgress } from '../progress.js';
/** Shared board observations and owned-process helpers for real landing fixtures [B3,R3]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { startFixtureChild } from '../child.js';
import { stopGroup } from '../runner/group.js';

/** Read a private board through public functions, never by mutating its database. */
export function onBoard(box, action, clock) {
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), clock);
  try { return action(board); } finally { store.closeBoard(board); }
}

/** Return append-only public events for receipt and replay assertions. */
export function events(box) { return onBoard(box, (board) => store.events(board)); }

/** Parse the gate's actual command arguments to distinguish full runs from single-file diagnoses. */
export function calls(box) {
  return existsSync(box.calls) ? readFileSync(box.calls, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}


/** Run a successful JSON command, retaining child context if any actual hook or check refuses. */
export function json(box, cwd, ...args) {
  const result = box.run(cwd, ...args, '--json');
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** Read the actual first-parent merge sequence at the published tip. */
export function mergeSubjects(box, base, tip) {
  return box.git(box.repo, 'log', '--reverse', '--first-parent', '--format=%s', `${base}..${tip}`).split('\n').filter(Boolean);
}


/** Resolve when an owned fixture child closes or fails to spawn. */
export function childOutcome(child) {
  return new Promise((resolveOutcome) => {
    let spawnError = null;
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => resolveOutcome({ code, signal, error: spawnError }));
  });
}

/**
 * Put a private board into rollback-journal mode while no process has it open.
 * Why: SQLite refuses to leave WAL while any connection is open, so an exclusive writer started after a hook has opened the board
 * could never take its lock; converting first lets the later writer's own journal pragma be a no-op.
 */
export function useRollbackJournal(boardFile) {
  const db = new DatabaseSync(boardFile);
  try {
    const journal = db.prepare('PRAGMA journal_mode = DELETE').get().journal_mode;
    assert.equal(journal, 'delete', 'the private board leaves WAL before any hook opens it');
  } finally { db.close(); }
}

/** Start a separate process holding an exclusive write transaction on the fixture board. */
export function startExclusiveBoardWriter(box, boardFile, name) {
  const ready = join(box.dir, `${name}-ready`);
  const release = join(box.dir, `${name}-release`);
  const released = join(box.dir, `${name}-released`);
  const source = [
    "const fs = require('node:fs'); const { DatabaseSync } = require('node:sqlite');",
    'const [file, ready, release, released] = process.argv.slice(1);',
    'const db = new DatabaseSync(file);',
    "try { const journal = db.prepare('PRAGMA journal_mode = DELETE').get().journal_mode;",
    "const locking = db.prepare('PRAGMA locking_mode = EXCLUSIVE').get().locking_mode;",
    "if (journal !== 'delete' || locking !== 'exclusive') throw new Error('fixture did not acquire rollback-journal exclusive mode');",
    "db.exec('BEGIN EXCLUSIVE'); db.exec('CREATE TABLE IF NOT EXISTS fixture_write (value INTEGER)'); db.exec('INSERT INTO fixture_write (value) VALUES (1)');",
    'fs.writeFileSync(ready, JSON.stringify({ journal, locking })); const deadline = Date.now() + 20_000;',
    'while (!fs.existsSync(release) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);',
    "if (!fs.existsSync(release)) throw new Error('writer release was not received');",
    "db.exec('COMMIT'); db.close(); fs.writeFileSync(released, 'released');",
    "} catch (error) { try { db.close(); } catch {} process.stderr.write(error.stack + '\\n'); process.exitCode = 1; }",
  ].join('\n');
  const child = startFixtureChild(process.execPath, ['-e', source, boardFile, ready, release, released], {
    cwd: box.repo, env: box.env, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  return { child, closed: childOutcome(child), ready, release, released };
}

/** Start the actual owned lander and watch its progress without turning startup load into a speed assertion. */
export function startInterruptedLanding(box, entry, t) {
  const startup = join(box.dir, 'adoption-startup.jsonl');
  const env = { ...box.env, PULLBOARD_STARTUP_TRACE_FILE: startup, PULLBOARD_STARTUP_TRACE_ENTRY: entry };
  const child = startFixtureChild(process.execPath, [entry, 'land', '--json'], {
    cwd: box.repo, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let outputBytes = 0;
  child.stdout.on('data', part => { outputBytes += Buffer.byteLength(part); });
  child.stderr.on('data', part => { outputBytes += Buffer.byteLength(part); });
  const closed = new Promise(resolveClose => child.once('close', (status, signal) => resolveClose({ status, signal })));
  t.after(async () => {
    writeFileSync(box.release, 'release');
    await stopGroup(child, closed);
  });
  return { child, closed, waitForGate: () => waitForFixtureProgress({
    child,
    ready: () => existsSync(box.entered),
    progress: () => outputBytes + [box.calls, box.trace, startup].reduce((bytes, file) =>
      bytes + (existsSync(file) ? readFileSync(file).length : 0), 0),
    description: 'landing gate entered',
  }) };
}

/** Settle only the exact native wake recorded by this private fixture before counting foreground publish calls. */
export async function settleRecordedSourceWake(box, helpers) {
  const directory = join(box.repo, '.git', 'pullboard', 'source-advances');
  const path = join(directory, 'wake.json');
  if (!existsSync(path)) {
    assert.equal(existsSync(join(directory, 'owner.json')), false, 'an unrecorded source worker cannot be treated as settled');
    return null;
  }
  const wake = readMainAudit(path);
  assert.ok(Number.isSafeInteger(wake?.generation) && wake.generation > 0, 'the fixture records a valid exact native wake');
  return closePolicySourceWake(box, helpers, wake.generation);
}


/** Merge checked fixture items through real Git and the native per-item merged receipt, without pushing. */
export function recordManualMergedItems(box, entries) {
  for (const entry of entries) {
    box.git(box.repo, 'merge', '-q', '--no-ff', '-m', `chore(merge): land fixture ${entry.item} [G1]`, entry.commit);
    const merged = box.run(box.repo, 'merged', String(entry.item), box.git(box.repo, 'rev-parse', 'HEAD'));
    assert.equal(merged.code, 0, merged.err);
  }
}
