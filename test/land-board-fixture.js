/** Shared board observations and owned-process helpers for real landing fixtures [B3,R3]. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from '../src/board.js';
import { startFixtureChild } from './fixture-child.js';

/** Read a private board through public functions, never by mutating its database. */
export function onBoard(box, action, clock) {
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), clock);
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
