/** Landing captures the flake ratchet from one read snapshot, so a busy board never refuses it [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { board as store, closeBoard, openBoard } from '../apps/lib/index.js';
import { gateRuns, landingFlakeRatchet } from '../packages/flakes/index.js';

/** A real git repo with a real SQLite board file; returns its root and board path. */
function realBoard(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard busy ratchet '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  const file = join(root, '.git/pullboard/board.sqlite');
  const seed = openBoard(file, undefined, { isMain: true, gitRoot: root });
  try { store.addItem(seed, { by: 'coordinator', lane: 'core', title: 'Seed', criterion: 'Exists' }); } finally { closeBoard(seed); }
  return { root, file };
}

test('a write from a second connection during the capture neither refuses it nor changes it from a quiet capture [C7]', t => {
  const { root, file } = realBoard(t);
  const reader = openBoard(file, undefined, { isMain: true, gitRoot: root });
  t.after(() => closeBoard(reader));
  const quiet = landingFlakeRatchet(reader);
  let wrote = 0;
  /** Read the runs, then write a new item from another connection before the capture's later queries. */
  const busyRuns = board => {
    const runs = gateRuns(board);
    const writer = openBoard(file, undefined, { isMain: true, gitRoot: root });
    try { store.addItem(writer, { by: 'coordinator', lane: 'core', title: 'Concurrent write', criterion: 'Lands mid-capture' }); wrote += 1; }
    finally { closeBoard(writer); }
    return runs;
  };
  const busy = landingFlakeRatchet(reader, { readRuns: busyRuns });
  assert.equal(wrote, 1, 'the second connection committed its write during the capture');
  assert.deepEqual(busy, quiet, 'the busy capture matches the quiet one: every query read the same snapshot');
  const latest = reader.db.prepare('SELECT MAX(event_id) AS id FROM event').get().id;
  assert.ok(latest > quiet.snapshot.eventId, 'the concurrent write is on the board after the capture');
  assert.equal(landingFlakeRatchet(reader).snapshot.eventId, latest, 'the next capture sees it');
});
