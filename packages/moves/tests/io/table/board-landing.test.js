/** @pullboard-test-input source-cell packages/moves */
/** The live-wired landing merged table records the merge commit's own time beside the time the board recorded it [C7,#12156]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { boardLandingEngine } from '../../../src/io/table/board-landing.js';
import { replayTable } from '../../../index.js';
import { runTable } from '../../../index.js';

const files = privateFixtureFiles('pullboard-board-landing-');
after(() => rmSync(files.root, { recursive: true, force: true }));
const MINUTE = 60 * 1000;

/** The checkout's own HEAD commit; returns its sha and committer time in ms, read with git. */
function commit() {
  const git = (...args) => String(runFixtureGit(args, { cwd: fileURLToPath(new URL('../../../../../', import.meta.url)) })).trim();
  const sha = git('rev-parse', 'HEAD');
  return { sha, committedAt: Number(git('show', '-s', '--format=%ct', sha)) * 1000 };
}

/** A fixture board on real SQLite with the board's event table. */
function board() {
  const db = new DatabaseSync(join(files.root, `board-${Math.random().toString(36).slice(2)}.sqlite`));
  db.exec(`CREATE TABLE event (event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_at TEXT NOT NULL, event_by TEXT NOT NULL, event_kind TEXT NOT NULL, item_id INTEGER, event_detail TEXT NOT NULL DEFAULT '{}')`);
  return db;
}

/** Runs the production landing engine's merged table on a verified item and writes its events at `at`. */
function record(db, engine, move, at) {
  const answer = runTable(engine.tables.merged, engine.rules, { item: { id: 7, status: 'verified', mergedCommit: null } }, { name: 'landing-merged', id: 7, actor: 'coordinator', ...move });
  assert.equal(answer.refused, undefined, 'the merge is accepted');
  for (const event of answer.events) db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)').run(new Date(at).toISOString(), event.by, event.kind, 7, JSON.stringify(event.detail));
  return answer;
}

test('moves.io-landing.merged-at-commit-time: clause 1: a merge recorded ten minutes after its commit carries detail.mergedAt as the commit time while event_at stays the record time [C7,#12156]', () => {
  const { sha, committedAt } = commit();
  const db = board();
  record(db, boardLandingEngine(), { commit: sha, mergedAt: committedAt }, committedAt + 10 * MINUTE);
  const row = db.prepare("SELECT event_at, event_detail FROM event WHERE event_kind = 'merged' AND item_id = 7").get();
  assert.equal(JSON.parse(row.event_detail).mergedAt, committedAt, 'mergedAt is the commit\'s committer time in ms');
  assert.equal(Date.parse(row.event_at) - committedAt, 10 * MINUTE, 'event_at stays the record time');
  db.close();
});

test('moves.io-landing.merged-at-replay: clause 2: replay of a merged event recorded before the engine leaf, with no mergedAt, still agrees with the landing table [C7,#12156]', () => {
  const engine = boardLandingEngine();
  const old = { event: { id: 1, at: '2026-11-20T00:00:00.000Z' }, snapshot: { item: { id: 7, status: 'verified', mergedCommit: null } }, move: { name: 'landing-merged', id: 7, actor: 'coordinator', commit: 'abc' }, recorded: { events: [{ kind: 'merged', by: 'coordinator', detail: { commit: 'abc' } }] } };
  const report = replayTable(engine.tables.merged, engine.rules, [old], { cut: '2026-11-01T00:00:00.000Z' });
  assert.deepEqual([report.total, report.agreed, report.disagreed], [1, 1, 0]);
});
