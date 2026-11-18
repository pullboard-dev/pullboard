/** pullboard status shows the adaptive landing batch size and its clean run, only with landing.adaptiveBatch on [C7,#9018]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { apiHttpFixture } from '../fixtures/api.js';
import { runCliInProcess } from '../fixtures/process.js';
import { adaptiveBatchLine } from '../../src/io/landing/adaptive.js';

/** Turn landing.adaptiveBatch on in the fixture's machine settings, keeping what the fixture already set. */
function enableAdaptive(box) {
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(readFileSync(file, 'utf8')); } catch { settings = {}; }
  writeFileSync(file, JSON.stringify({ ...settings, landing: { ...settings.landing, adaptiveBatch: true } }));
}

/** A board stub holding finished landing runs, oldest first. */
function board(outcomes) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE board_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT); CREATE TABLE run (run_job TEXT PRIMARY KEY, run_kind TEXT, run_outcome TEXT, run_updated INTEGER)');
  outcomes.forEach((outcome, i) => db.prepare('INSERT INTO run VALUES (?, ?, ?, ?)').run(`land:${i}`, 'land', outcome, i));
  return { db };
}

test('cli.io-landing-adaptive-status.with-landing-adaptivebatch-on-status-prints-the: clause 1: with landing.adaptiveBatch on, status prints the landing batch size and the clean batches behind it [C7,#9018]', async t => {
  assert.equal(adaptiveBatchLine(board([]), true), 'landing batch size: 1 (0 clean batches in a row)');
  assert.equal(adaptiveBatchLine(board(Array(4).fill('landed')), true), 'landing batch size: 2 (4 clean batches in a row)');
  assert.equal(adaptiveBatchLine(board(['landed', 'landed', 'landed', 'red', 'landed']), true), 'landing batch size: 1 (1 clean batch in a row)');
  const box = apiHttpFixture(t);
  enableAdaptive(box);
  const ran = await runCliInProcess(['status'], { cwd: box.root, env: box.env });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /^landing batch size: 1 \(0 clean batches in a row\)$/mu);
});

test('cli.io-landing-adaptive-status.with-landing-adaptivebatch-off-status-prints-no: clause 2: with landing.adaptiveBatch off, status prints no landing batch size line [C7,#9018]', async t => {
  assert.equal(adaptiveBatchLine(board(Array(9).fill('landed')), false), null);
  const box = apiHttpFixture(t);
  const ran = await runCliInProcess(['status'], { cwd: box.root, env: box.env });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.doesNotMatch(ran.stdout, /landing batch size/u);
});
