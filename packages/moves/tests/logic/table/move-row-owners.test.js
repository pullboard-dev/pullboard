/** @pullboard-test-input source-cell packages/moves */
/** Every move-table row has exactly one owning registry record, and the check reports a row with none or two [C7,U148,#8393]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKBONE_TABLE } from '../../../index.js';
import { RECLAIM_TABLE } from '../../../index.js';
import { OUTBOX_TABLE } from '../../../index.js';
import { PULLED_TABLE } from '../../../index.js';
import { boardClaimEngine } from '../../../index.js';
import { boardLandingEngine } from '../../../index.js';
import { boardReleaseEngine } from '../../../index.js';
import { boardReopenEngine } from '../../../index.js';
import { boardSubmitEngine } from '../../../index.js';
import { boardVerifyEngine } from '../../../index.js';
import { boardWithdrawEngine } from '../../../index.js';
import { hopEngine } from '../../../index.js';
import { jobEngine } from '../../../index.js';
import { leaseEngine } from '../../../index.js';
import { moveRowOwnershipProblems } from '../../../index.js';

const DIR = import.meta.dirname;
const ids = (table) => ['guards', 'outcomes', 'followups'].flatMap((kind) => (table[kind] ?? []).map((row) => row.id));
const submit = boardSubmitEngine().tables;

/** The row ids of every move table the moves cell generates tests for, from each table's own export. */
const TABLES = {
  backbone: ids(BACKBONE_TABLE),
  claim: ids(boardClaimEngine().table),
  hop: ids(hopEngine({ leaseMs: 1, leaseLapsed: () => false }).table),
  job: ids(jobEngine({ leaseMs: 1, maxAttempts: 1 }).table),
  landing: [...new Set(Object.values(boardLandingEngine().tables).flatMap(ids))],
  lease: ids(leaseEngine({ leaseMs: 1, valid: () => true }).table),
  outbox: ids(OUTBOX_TABLE),
  pulled: ids(PULLED_TABLE),
  reclaim: ids(RECLAIM_TABLE),
  release: ids(boardReleaseEngine().table),
  reopen: ids(boardReopenEngine().table),
  submit: [...new Set(Object.values(submit).flatMap(ids))],
  verify: ids(boardVerifyEngine().table),
  withdraw: ids(boardWithdrawEngine().table),
};
const own = (id, move) => ({ [id]: { proves: { move } } });

test('moves.row-owners.unowned-row: clause 1: a table row no record owns is reported [C7,U148,#8393]', () => {
  const tables = { hop: ['live', 'fenced'] };
  assert.deepEqual(moveRowOwnershipProblems(tables, own('moves.hop.fence-breaks', 'hop:fenced')), ['hop:live has no record that owns it']);
  assert.equal(moveRowOwnershipProblems(tables, {}).length, 2);
  assert.equal(moveRowOwnershipProblems(tables, own('moves.hop.deterministic', 'hop:*')).length, 2, 'a property record over the whole table owns no row');
  assert.deepEqual(moveRowOwnershipProblems(tables, own('moves.hop.rows-fire', 'hop:*')), []);
});

test('moves.row-owners.doubly-owned-row: clause 2: a row two moves-cell records own is reported [C7,U148,#8393]', () => {
  const tables = { hop: ['live', 'fenced'] };
  const records = { ...own('moves.hop.a', 'hop:fenced'), ...own('moves.hop.b', 'hop:fenced'), ...own('moves.hop.rows-fire', 'hop:*') };
  assert.deepEqual(moveRowOwnershipProblems(tables, records), ['hop:fenced is owned by two records: moves.hop.a, moves.hop.b']);
  const twoWhole = { ...own('moves.hop.rows-fire', 'hop:*'), ...own('moves.hop.x.rows-fire', 'hop:*') };
  assert.match(moveRowOwnershipProblems(tables, twoWhole)[0], /the whole table has two owners/u);
  assert.match(moveRowOwnershipProblems(tables, { ...own('moves.hop.rows-fire', 'hop:*'), ...own('moves.hop.c', 'hop:nope') })[0], /names row nope, which the table does not have/u);
});

test('moves.row-owners.main-whole: clause 3: every row of main\'s move tables has exactly one owning record in the moves cell\'s registry [C7,U148,#8393]', () => {
  const records = JSON.parse(readFileSync(join(DIR, '../../registry.json'), 'utf8'));
  assert.ok(Object.values(TABLES).every((rows) => rows.length > 0), 'every table has rows');
  assert.deepEqual(moveRowOwnershipProblems(TABLES, records), []);
});

test('moves.row-owners.reopen: clause 2: the reopen table has rows and exactly one owner for each [C7,#8559]', () => {
  const records = JSON.parse(readFileSync(join(DIR, '../../registry.json'), 'utf8'));
  assert.equal(TABLES.reopen.length, 14);
  assert.deepEqual(moveRowOwnershipProblems({ reopen: TABLES.reopen }, records), []);
});

test('moves.row-owners.backbone: clause 2: the backbone table has rows and exactly one owner for each [C7,#8558]', () => {
  const records = JSON.parse(readFileSync(join(DIR, '../../registry.json'), 'utf8'));
  assert.ok(TABLES.backbone.length > 40, 'the backbone has its guard and outcome rows');
  assert.deepEqual(moveRowOwnershipProblems({ backbone: TABLES.backbone }, records), []);
});

test('moves.row-owners.landing: clause 2: the five landing tables have rows and every row has exactly one owner [C7,#8561]', () => {
  const records = JSON.parse(readFileSync(join(DIR, '../../registry.json'), 'utf8'));
  assert.equal(TABLES.landing.length, 43);
  assert.deepEqual(moveRowOwnershipProblems({ landing: TABLES.landing }, records), []);
});

test('moves.row-owners.reclaim: clause 2: the reclaim table has rows and exactly one owner for each [C7,#8560]', () => {
  const records = JSON.parse(readFileSync(join(DIR, '../../registry.json'), 'utf8'));
  assert.equal(TABLES.reclaim.length, 12);
  assert.deepEqual(moveRowOwnershipProblems({ reclaim: TABLES.reclaim }, records), []);
});

test('moves.row-owners.pulled: clause 2: the pulled table is listed with its five rows and every pulled row has exactly one owner [C7,#9187]', () => {
  const records = JSON.parse(readFileSync(join(DIR, '../../registry.json'), 'utf8'));
  assert.deepEqual(TABLES.pulled, ['coordinator', 'item-exists', 'pulling', 'revert-named', 'pulled']);
  assert.deepEqual(moveRowOwnershipProblems({ pulled: TABLES.pulled }, records), []);
  const owners = TABLES.pulled.map((row) => Object.keys(records).filter((id) => records[id].proves?.move === `pulled:${row}`));
  assert.deepEqual(owners, TABLES.pulled.map((row) => [`moves.pulled.${row}`]));
});
