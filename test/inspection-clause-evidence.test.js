/** Evidence declarations are enforced at native add/edit admission, with replay compatibility [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../apps/lib/index.js';
import * as store from '../packages/store/index.js';
import { CLAUSE_EVIDENCE_ENGINE } from '../packages/state/index.js';
import { requireCriterionEvidence } from '../packages/state/index.js';
import { clauseInspectionSummary } from '../packages/state/index.js';
import { createE2eHelpers } from './e2e-helpers.js';

/** Use native SQLite storage and native item writers, without a replacement board implementation. */
function fixture(t, engine = CLAUSE_EVIDENCE_ENGINE) {
  const board = openBoard(':memory:');
  board.executionEngineVersion = engine;
  store.register(board, { lane: 'coordinator', path: '/evidence/main' });
  t.after(() => store.closeBoard(board));
  return board;
}

/** A deliberately small routed item with an ordinary executable check. */
function item(criterion) {
  return { by: 'coordinator', lane: 'core', title: 'Evidence declaration', criterion,
    route: 'mid', brief: 'Files: packages/state/index.js\nTest: evidence admission', check: 'true' };
}

/** Assert both the named refusal and its concrete repair instruction. */
function refused(work, code) {
  assert.throws(work, error => error.code === code && /clause/u.test(error.message)
    && /declare|declaration/u.test(error.message));
}

test('native add and edit refuse missing clause kinds atomically and name the fix [C7]', t => {
  const board = fixture(t);
  for (const criterion of ['1. the command returns zero', '1. one [test]\n2. two', '2. out of order', 'After this item: 1. one [test]; 2. two']) {
    refused(() => store.addItem(board, item(criterion)), 'CLAUSE_EVIDENCE_REQUIRED');
  }
  assert.equal(store.listItems(board).length, 0, 'refused additions persist no item');
  const id = store.addItem(board, item('1. the command returns zero [command]'));
  const before = store.getItem(board, id);
  const events = store.itemThread(board, id).length;
  refused(() => store.editItem(board, id, { agentId: 'coordinator', criterion: '1. no kind', reason: 'correct evidence' }), 'CLAUSE_EVIDENCE_REQUIRED');
  assert.equal(store.getItem(board, id).item_criterion, before.item_criterion);
  assert.equal(store.itemThread(board, id).length, events, 'refused edits persist no event');
  refused(() => store.addItem(board, item('1. ambiguous [test] [command]')), 'CLAUSE_EVIDENCE_KIND');
});

test('all five kinds are accepted and native add/edit events flag reasoning [C7]', t => {
  const board = fixture(t);
  const criterion = '1. the case passes [test]\n2. the command prints OK [command]\n3. visual layout [screenshot]\n4. latency distribution [measurement]\n5. explain the design tradeoff [reasoning]';
  const id = store.addItem(board, item(criterion));
  const add = store.itemThread(board, id).find(entry => entry.type === 'move' && entry.kind === 'add');
  assert.equal(add.detail.criterionEvidenceWarnings[0].code, 'CLAUSE_REASONING_WEAK');
  assert.equal(add.detail.criterionEvidenceWarnings[0].clause, 5);
  store.editItem(board, id, { agentId: 'coordinator', criterion: '1. explain the choice [reasoning]', reason: 'narrow the judgement' });
  const edit = store.itemThread(board, id).findLast(entry => entry.type === 'move' && entry.kind === 'edit');
  assert.equal(edit.detail.criterionEvidenceWarnings[0].clause, 1);
  assert.match(edit.detail.criterionEvidenceWarnings[0].message, /weakest evidence/u);
  const summary = clauseInspectionSummary({ item_criterion: '1. design [reasoning]\n2. appearance [reasoning]', item_owner: 'builder' },
    [1, 2].map(number => ({ type: 'fact', kind: 'note', by: 'builder', text: `clause ${number} [reasoning]: design argument` })));
  assert.equal(summary.match(/weakest evidence/gu).length, 2, 'every reasoning tick is flagged');
});

test('observable outcomes cannot declare reasoning alone at either native write [C7]', t => {
  const board = fixture(t);
  const id = store.addItem(board, item('1. explain the design [reasoning]'));
  for (const outcome of ['exits zero', 'prints OK', 'refuses invalid input', 'passes its check', 'returns a value', 'finishes under 10 ms', 'finishes under 1.5 s']) {
    const criterion = `1. the command ${outcome} [reasoning]`;
    refused(() => store.addItem(board, item(criterion)), 'CLAUSE_REASONING_ONLY');
    refused(() => store.editItem(board, id, { agentId: 'coordinator', criterion, reason: 'observable correction' }), 'CLAUSE_REASONING_ONLY');
  }
  assert.equal(store.listItems(board).length, 1);
  assert.deepEqual(requireCriterionEvidence('free prose remains free prose'), []);
  assert.deepEqual(requireCriterionEvidence('After this item: 1. one [test]; 2. two [command].'), []);
});

test('historical engine replay accepts old untagged criteria and unrelated edits remain possible [C7]', t => {
  const board = fixture(t, CLAUSE_EVIDENCE_ENGINE - 1);
  const id = store.addItem(board, item('1. old untagged outcome\n2. another outcome'));
  store.editItem(board, id, { agentId: 'coordinator', criterion: '1. old corrected outcome', reason: 'historical correction' });
  board.executionEngineVersion = CLAUSE_EVIDENCE_ENGINE;
  store.editItem(board, id, { agentId: 'coordinator', brief: 'Files: packages/state/index.js\nTest: original case' });
  assert.equal(store.getItem(board, id).item_criterion, '1. old corrected outcome');
});

test('real CLI refuses add/edit before starting the check and exposes reasoning warnings [C7]', t => {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project();
  const marker = join(box.repo, 'should-not-execute');
  const check = `node -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)},"ran")'`;
  const bad = box.run(box.repo, 'add', 'web', 'Invalid evidence', '--criterion', '1. returns zero', '--check', check,
    '--route', 'mid', '--brief', 'Files: web/page.html\nTest: refusal before check');
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /CLAUSE_EVIDENCE_REQUIRED/u);
  assert.equal(existsSync(marker), false);
  const added = box.run(box.repo, 'add', 'web', 'Design evidence', '--criterion', '1. explain design [reasoning]', '--check', 'true',
    '--route', 'mid', '--brief', 'Files: web/page.html\nTest: native evidence warning', '--json');
  assert.equal(added.code, 0, added.err);
  const result = JSON.parse(added.out);
  assert.equal(result.warnings[0].code, 'CLAUSE_REASONING_WEAK');
  const edited = box.run(box.repo, 'edit', String(result.item.item_id), '--criterion', '1. no kind', '--check', check, '--reason', 'invalid correction');
  assert.notEqual(edited.code, 0);
  assert.match(edited.err, /CLAUSE_EVIDENCE_REQUIRED/u);
  assert.equal(existsSync(marker), false);
});
