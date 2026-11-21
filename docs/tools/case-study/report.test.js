/** @pullboard-test-input packages/codemap/data/plan/** */
/** @pullboard-world-pin copies the committed cells plan into a private git fixture so the generator reads a real plan and a controlled inventory. */
/** The case study generator reads its metrics from real event and lint sources, not constants [C7]. */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fixture, git } from '../../../packages/landing/tests/fixtures/plan.js';
import { caseStudy } from './report.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = fileURLToPath(new URL('../case-study.js', import.meta.url));
const FROM = '2026-11-01T00:00:00.000Z', TO = '2026-11-01T04:00:00.000Z';

/** Commit one more legacy module so the repo lint inventory has a new finding. */
function addLegacy(root, name) {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', name), 'export const value = 1;\n');
  git(root, 'add', `src/${name}`);
  git(root, 'commit', '-q', '-m', `add ${name}`);
}

/** Append one native event row to the seeded board. */
function put(boardPath, kind, item, at, detail) {
  const db = new DatabaseSync(boardPath);
  try {
    db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)').run(at, 'core-1', kind, item, JSON.stringify(detail));
  } finally { db.close(); }
}

/** Seed a private git repo with the real cells plan and a board holding one landing. */
function seed(t) {
  const { root } = fixture(t), boardPath = join(root, 'board.sqlite');
  cpSync(join(REPO, 'packages/codemap/data/plan'), join(root, 'packages/codemap/data/plan'), { recursive: true });
  git(root, 'add', 'packages');
  git(root, 'commit', '-q', '-m', 'real plan');
  const db = new DatabaseSync(boardPath);
  db.exec('CREATE TABLE event (event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_at TEXT NOT NULL, event_by TEXT NOT NULL, event_kind TEXT NOT NULL, item_id INTEGER, event_detail TEXT NOT NULL DEFAULT \'{}\')');
  db.close();
  put(boardPath, 'claim', 1, '2026-11-01T00:10:00.000Z', {});
  put(boardPath, 'merged', 1, '2026-11-01T00:40:00.000Z', { commit: 'a'.repeat(40) });
  return { root, boardPath };
}

test('docs.tools-case-study-report.real-sources: clause 1: the case study generator reads the real event and lint sources [C7]', (t) => {
  const { root, boardPath } = seed(t);
  const before = caseStudy({ root, boardPath, from: FROM, to: TO });
  const legacy = before.observation.structure.lints.legacySource;
  assert.ok(legacy >= 1);
  assert.equal(before.observation.events.landings.n, 1);
  assert.equal(before.observation.events.claimToLand.medianMs, 30 * 60_000);

  // Change one source in each reader: a new legacy module and a new landing must move exactly their metrics.
  addLegacy(root, 'legacy-new.js');
  put(boardPath, 'claim', 2, '2026-11-01T01:00:00.000Z', {});
  put(boardPath, 'merged', 2, '2026-11-01T01:10:00.000Z', { commit: 'b'.repeat(40) });
  const after = caseStudy({ root, boardPath, from: FROM, to: TO });
  assert.equal(after.observation.structure.lints.legacySource, legacy + 1);
  assert.equal(after.observation.events.landings.n, 2);
  assert.equal(after.observation.events.claimToLand.medianMs, 20 * 60_000);
});

test('docs.tools-case-study-report.cli-prints-json: clause 2: docs/tools/case-study.js prints the JSON caseStudy returns [C7]', (t) => {
  const { root, boardPath } = seed(t);
  addLegacy(root, 'legacy-cli.js');
  const expected = caseStudy({ root, boardPath, from: FROM, to: TO });
  const run = spawnSync(process.execPath, [CLI, '--root', root, '--board', boardPath, '--from', FROM, '--to', TO], { cwd: dirname(CLI), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), JSON.parse(JSON.stringify(expected)));
});
