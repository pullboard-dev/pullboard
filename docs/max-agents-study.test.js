/** @pullboard-test-input source-cell stats */
/** @pullboard-world-pin reads the unpublished draft docs/studies/max-agents.md and README.md to prove the draft's numbers match the series command and the draft is not linked. */
/** The max-agents study draft is marked unpublished and quotes the series command's output exactly [C7,#9450,#2218]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { maxAgentsLines, readMaxAgentsSeries } from '../packages/stats/index.js';

const ROOT = resolve(import.meta.dirname, '..');
const SINCE = '2026-11-01T00:00:00.000Z';
const UNTIL = '2026-11-01T04:00:00.000Z';
const draft = readFileSync(resolve(ROOT, 'docs/studies/max-agents.md'), 'utf8');

/** The fixture board of the series command's own test: hours land 1, 4, 4 and 1 with 1, 3, 5 and 0 active seats. */
function fixtureBoard() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE event (event_id INTEGER PRIMARY KEY, event_kind TEXT NOT NULL, event_by TEXT, item_id INTEGER, event_at TEXT NOT NULL)');
  const put = (kind, by, at) => db.prepare('INSERT INTO event (event_kind, event_by, item_id, event_at) VALUES (?, ?, 1, ?)').run(kind, by, at);
  put('claim', 'core-1', '2026-11-01T00:10:00.000Z'); put('merged', 'board', '2026-11-01T00:20:00.000Z');
  for (const [seat, minute] of [['core-1', 5], ['core-2', 6], ['core-3', 7]]) put('claim', seat, `2026-11-01T01:0${minute}:00.000Z`);
  for (let i = 0; i < 4; i += 1) put('merged', 'board', `2026-11-01T01:3${i}:00.000Z`);
  for (const seat of ['core-1', 'core-2', 'core-3', 'core-4', 'core-5']) put('claim', seat, '2026-11-01T02:05:00.000Z');
  for (let i = 0; i < 4; i += 1) put('merged', 'board', `2026-11-01T02:4${i}:00.000Z`);
  put('merged', 'board', '2026-11-01T03:30:00.000Z');
  put('merged', 'board', '2026-11-01T05:30:00.000Z');
  return db;
}

/** The fenced block of the draft, as lines. */
function quotedBlock() {
  const match = /```\n([\s\S]*?)\n```/u.exec(draft);
  assert.ok(match, 'the draft quotes the series output in a fenced block');
  return { text: match[1], rest: draft.replace(match[0], '') };
}

test('clause 1: the draft exists and states it is a draft awaiting the person\'s approval [C7,#2218]', () => {
  assert.match(draft, /this is a draft awaiting the person's approval/iu);
  assert.match(draft, /not published/iu);
});

test('clause 1: every number in the draft equals the series command output on the fixture board [C7,#9450]', () => {
  const lines = maxAgentsLines(readMaxAgentsSeries(fixtureBoard(), { since: SINCE, until: UNTIL }));
  const { text, rest } = quotedBlock();
  assert.equal(text, lines.join('\n'));
  assert.equal(/\d/u.test(rest), false, 'no number outside the quoted command output');
});

test('clause 1: the draft is not linked from the README [C7,#2218]', () => {
  assert.equal(readFileSync(resolve(ROOT, 'README.md'), 'utf8').includes('studies/max-agents'), false);
});
