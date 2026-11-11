/**
 * The spec (S1–S5): parsing SPEC.md rows, the lint, the frozen criterion and sign-offs.
 */
import assert from 'node:assert/strict';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { draftSpecRow } from '../../../../lib/index.js';
import { recordRowVerification } from '../../../../lib/index.js';
import { fixtureBoard } from '../../../tests/fixtures/board.js';
import { applyEngineMove } from '../../../../../packages/state/index.js';
import { prepareEngineMove } from '../../../../../packages/state/index.js';
import { exportBoard } from '../../../../../packages/store/index.js';
import { importBoard } from '../../../../../packages/store/index.js';
import { SPEC_VERDICT_ENGINE } from '../../../../../packages/state/light.js';
import { ENGINE_VERSION } from '../../../../../packages/state/index.js';
import { minimumMoveEngine } from '../../../../../packages/moves/index.js';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { lintSpec } from '../../../../../packages/spec/index.js';
import { parseSpec } from '../../../../../packages/spec/index.js';
import { specBox } from '../../../tests/fixtures/spec/box.js';

test('a verdict on a spec row is recorded by an outside verifier [S1,V4,H16]', t => {
  const line = '- G1 [draft, must] Keep the original row. | gate: review';
  const reason = 'The stated behavior is supported by the cited proof.';
  const formatted = `${line} | verify: accepted by review-2 | ${reason}`;
  const parsed = parseSpec(`## G · Goals\n${formatted}\n`);
  assert.deepEqual(parsed.rows[0].verify, { decision: 'accepted', by: 'review-2', reason },
    'the row grammar preserves a structured verifier verdict');
  assert.deepEqual(lintSpec(parsed), []);
  const box = specBox(t, { specSource: '# Demo\n\n## G · Goals\n' });
  const board = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  const author = store.register(board, { lane: 'core', path: join(box.root, 'author'), parentDigest: 'a'.repeat(64) });
  const sibling = store.register(board, { lane: 'review', path: join(box.root, 'sibling'), parentDigest: 'a'.repeat(64) });
  const verifier = store.register(board, { lane: 'review', path: join(box.root, 'outside'), parentDigest: 'b'.repeat(64) });
  draftSpecRow(board, { agentId: author, row: { id: 'G1', text: 'Keep the original row.',
    gate: 'review', tier: 'must', section: 'G · Goals', target: 'spec' } });
  assert.equal(box.run('apply').status, 0);
  const source = readFileSync(join(box.root, box.specName), 'utf8').split('\n').find(value => value.startsWith('- G1 '));
  const before = store.events(board).length;
  for (const agentId of [author, sibling]) assert.throws(() => recordRowVerification(board,
    { agentId, source, decision: 'accepted', reason }), { code: 'ROW_VERIFY_SELF' });
  assert.equal(store.events(board).length, before, 'refused self and sibling verdicts leave the board unchanged');
  recordRowVerification(board, { agentId: verifier, source, decision: 'accepted', reason });
  assert.equal(box.run('apply').status, 0);
  const check = box.run('check');
  assert.equal(check.status, 0, check.stdout + check.stderr);
  const shown = box.run('show', 'G1');
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, new RegExp(`verify: accepted by ${verifier}`));
  assert.ok(shown.stdout.includes(reason));
  const json = JSON.parse(box.run('show', 'G1', '--json').stdout);
  assert.deepEqual(json.row.verify, { decision: 'accepted', by: verifier, reason });
  assert.equal(json.row.status, 'draft', 'a verifier verdict does not approve normative text');
  recordRowVerification(board, { agentId: verifier, source, decision: 'rejected', reason: 'A counterexample remains.' });
  assert.equal(box.run('apply').status, 0);
  assert.match(box.run('show', 'G1').stdout, /verify: rejected by/u);
  const valid = readFileSync(join(box.root, box.specName), 'utf8');
  writeFileSync(join(box.root, box.specName), valid.replace('A counterexample remains.', 'A forged reason.'));
  const forged = box.run('check');
  assert.equal(forged.status, 1);
  assert.match(forged.stdout, /ROW_VERIFY_RECEIPT/u);
  writeFileSync(join(box.root, box.specName), valid);
  for (const changed of [source.replace('G1', 'G99'), source.replace('original row', 'different row')]) {
    assert.throws(() => recordRowVerification(board, { agentId: verifier, source: changed, decision: 'accepted', reason }),
      { code: 'ROW_VERIFY_PROVENANCE' });
  }
  const unknown = store.register(board, { lane: 'review', path: join(box.root, 'unknown') });
  assert.throws(() => recordRowVerification(board, { agentId: unknown, source, decision: 'accepted', reason }),
    { code: 'ROW_VERIFY_PROVENANCE' });
  writeFileSync(join(box.root, box.specName), valid.replace(/\n/gu, '\r\n'));
  recordRowVerification(board, { agentId: verifier, source, decision: 'accepted', reason });
  assert.equal(box.run('apply').status, 0);
  const windowsSource = readFileSync(join(box.root, box.specName), 'utf8');
  assert.ok(!/(?<!\r)\n/u.test(windowsSource), 'applying a new verdict preserves CRLF source endings');
  assert.equal(box.run('check').status, 0);
});

test('verifier fields reject duplicate and malformed annotations without swallowing check pipelines [S1,V4]', () => {
  const base = '- G1 [draft, must] A row. | gate: check printf yes | grep yes | count: 0';
  assert.equal(parseSpec(`## G\n${base}\n`).rows[0].gate, 'check printf yes | grep yes');
  const valid = parseSpec(`## G\n${base} | verify: rejected by tests-2 | Missing evidence.\n`);
  assert.equal(valid.rows[0].gate, 'check printf yes | grep yes');
  assert.deepEqual(lintSpec(valid), []);
  for (const suffix of ['verify: maybe by tests-2 | Why.', 'verify: accepted by tests-2',
    'verify: rejected by tests-2 | ', 'verify: accepted by tests-2 | Why. | verify: rejected by tests-3 | Why.']) {
    assert.ok(lintSpec(parseSpec(`## G\n${base} | ${suffix}\n`)).some(finding => finding.level === 'error'), suffix);
  }
});

test('spec verify binds the real caller and preserves a pending person decision [S1,V4,P6]', t => {
  const box = specBox(t, { specSource: '# Demo\n\n## G · Goals\n' });
  const board = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: box.root, parentDigest: 'c'.repeat(64) });
  const author = store.register(board, { lane: 'core', path: join(box.root, 'author'), parentDigest: 'a'.repeat(64) });
  draftSpecRow(board, { agentId: author, row: { id: 'G1', text: 'Keep the actual requirement.',
    gate: 'review', tier: 'must', section: 'G · Goals' } });
  assert.equal(box.run('apply').status, 0);
  const original = readFileSync(join(box.root, box.specName), 'utf8');
  const result = box.run('verify', 'G1', 'accepted', '--reason', 'The exact draft was reviewed.', '--json');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const record = JSON.parse(result.stdout).verification;
  assert.equal(record.by, 'coordinator', 'the actual joined caller is the verifier; the CLI takes no claimed seat');
  assert.equal(readFileSync(join(box.root, box.specName), 'utf8'), original, 'recording a verdict changes no spec file');
  assert.equal(box.run('approve', 'G1').status, 0);
  const pending = box.run('verify', 'G1', 'rejected', '--reason', 'A newer opinion.');
  assert.equal(pending.status, 1);
  assert.match(pending.stderr, /ROW_VERIFY_PENDING/u);
  assert.equal(store.rowVerifications(board)[0].decision, 'accepted', 'the pending signed source cannot be superseded');
  assert.equal(readFileSync(join(box.root, box.specName), 'utf8'), original);
  assert.equal(box.run('apply').status, 0);
  const applied = readFileSync(join(box.root, box.specName), 'utf8');
  assert.match(applied, /G1 \[approved, must\]/u);
  assert.ok(!applied.includes('verify:'), 'the stale draft verdict does not overwrite the person-approved replacement');
  assert.equal(box.run('check').status, 0);
});

test('row verifier reads need an exact receipt and never create a missing board [S1,V4]', t => {
  const box = specBox(t, { specSource: '# Demo\n\n## G · Goals\n- G1 [draft] A row. | verify: accepted by review-2 | A claimed reason.\n' });
  const file = join(box.root, '.git', 'pullboard', 'board.sqlite');
  rmSync(file, { force: true });
  for (const suffix of ['-shm', '-wal']) rmSync(file + suffix, { force: true });
  const checked = box.run('check');
  assert.equal(checked.status, 1);
  assert.match(checked.stdout, /ROW_VERIFY_RECEIPT/u);
  assert.equal(existsSync(file), false, 'checking a forged field initializes no board');
  const shown = box.run('show', 'G1');
  assert.equal(shown.status, 1);
  assert.match(shown.stderr, /ROW_VERIFY_RECEIPT/u);
  assert.equal(existsSync(file), false, 'show refuses the unproved field before opening a writer');
});

test('an exact row verifier receipt replays once with its engine floor and native snapshot [S1,V4,H16]', t => {
  const root = '/fixture/spec-verdict';
  const board = fixtureBoard(t);
  const replica = fixtureBoard(t);
  const author = store.register(board, { lane: 'core', path: join(root, 'author'), parentDigest: 'a'.repeat(64) });
  const verifier = store.register(board, { lane: 'review', path: join(root, 'verifier'), parentDigest: 'b'.repeat(64) });
  draftSpecRow(board, { agentId: author, row: { id: 'G1', text: 'An exact requirement.',
    gate: 'review', tier: 'must', section: 'G · Goals' } });
  const move = prepareEngineMove(board, 'recordRowVerification', [{ agentId: verifier,
    source: '- G1 [draft, must] An exact requirement. | gate: review', decision: 'accepted', reason: 'Reviewed exactly.' }]);
  assert.equal(move.engine, ENGINE_VERSION, 'the native writer stamps its current version');
  assert.equal(minimumMoveEngine(move.operation, move.args, board), SPEC_VERDICT_ENGINE, 'the historical reader floor remains fixed');
  const options = { sequence: 1, at: new Date().toISOString() };
  const before = store.events(board).length;
  assert.throws(() => applyEngineMove(board, { ...move, engine: SPEC_VERDICT_ENGINE - 1 }, options), { code: 'RELAY_MOVE' });
  assert.equal(store.events(board).length, before, 'an older engine records no verdict');
  const result = applyEngineMove(board, move, options);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(store.rowVerifications(board)[0].by, verifier);
  const count = store.events(board).length;
  assert.deepEqual(applyEngineMove(board, move, options), result);
  assert.equal(store.events(board).length, count, 'same-position retry adds no receipt or event');
  importBoard(replica, exportBoard(board));
  assert.deepEqual(store.rowVerifications(replica), store.rowVerifications(board), 'native restore retains the verdict and parent-bearing source board');
});
