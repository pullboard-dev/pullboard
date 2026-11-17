/** @pullboard-test-input source-cell store */
/** A board without the opt-in tables made on first use is not schema drift: the notice names none of them [C7,#9351]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { sharedSchemaDiagnostic } from '../../../index.js';
import { declaredBoardSchema } from '../../../index.js';

const BASE = 'CREATE TABLE item (item_id INTEGER PRIMARY KEY);';
const OPT_IN = ['gate_hop', 'field_decl', 'item_field', 'item_related'].map(name => `CREATE TABLE ${name} (a TEXT, b TEXT);`).join('');

test('store.io-board-schema-opt-in.a-shared-board-lacking-the-gate: clause 1: a shared board lacking the gate hop, field and related tables raises no schema notice [C7,#9351]', () => {
  const expected = declaredBoardSchema(db => db.exec(BASE + OPT_IN));
  const shared = new DatabaseSync(':memory:');
  shared.exec(BASE);
  assert.equal(sharedSchemaDiagnostic(shared, expected), null);
  shared.close();
});

test('store.io-board-schema-opt-in.a-shared-board-lacking-a-core: clause 2: a shared board lacking a core column still raises the notice [C7,#9351]', () => {
  const expected = declaredBoardSchema(db => db.exec(`${BASE} CREATE TABLE job (job_id INTEGER);`));
  const shared = new DatabaseSync(':memory:');
  shared.exec(BASE);
  assert.match(sharedSchemaDiagnostic(shared, expected), /column only in this worktree: job\.job_id/u);
  shared.close();
});
