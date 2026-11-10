/** @pullboard-test-input source-tree */
/** Durable namespaced decision delivery, with actual SQLite and a signed authority port [B21,H16]. */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

/** The fixture capability authenticates the disclosed question, source, destination and option binding. */
function signature(value) {
  const { authority, ...body } = value;
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
  return createHmac('sha256', 'private-fixture-authority').update(JSON.stringify(canonical(body))).digest('hex');
}

test('a decision hand-off returns one matching answer to its source board, once [B21,H16]', async t => {
  assert.equal(existsSync(new URL('../../src/io/decision.js', import.meta.url)), true,
    'the durable decision hand-off contract must exist');
  const { decisionHandoffs, optionsDigest } = await import("../../src/io/decision.js");
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-decision-handoff-'));
  const databases = [];
  t.after(() => { for (const db of databases) db.close(); rmSync(dir, { recursive: true }); });
  /** Each participant has its own real persistent database and explicitly supplied authority port. */
  function open(boardId) {
    const db = new DatabaseSync(join(dir, boardId + '.sqlite'));
    databases.push(db);
    return decisionHandoffs(db, { boardId, authorize: (action, value) =>
      value.authority === signature(value) && ['disclose', 'answer', 'read'].includes(action) });
  }
  const options = ['ship', 'wait'];
  const source = { boardId: 'source', decisionId: 17 };
  /** A separate capability is required for each exact disclosed destination and question. */
  function offer(destinationBoardId, handoffId = destinationBoardId, ref = source) {
    const value = { version: 1, handoffId, source: ref, destinationBoardId, requester: 'core-1',
      question: 'Ship the reviewed change?', optionsDigest: optionsDigest(options), authority: '', answer: null };
    return { ...value, authority: signature(value) };
  }
  const signed = value => ({ ...value, authority: signature(value) });
  const queryToken = (participants, ref = source) => signature({ version: 1, source: ref, participants });
  const original = offer('child');
  const home = open('source'), away = open('child');
  await assert.rejects(away.deliver({ ...original, authority: 'forged' }, options), { code: 'DECISION_HANDOFF_AUTH' });
  assert.deepEqual(await home.query(source, ['child'], queryToken(['child'])), { complete: false, agreed: false, answers: [] });
  const disclosed = await away.deliver(original, options);
  assert.deepEqual(disclosed, original);
  await home.deliver(original, options);
  const answered = signed({ ...original, answer: { boardId: 'child', option: 'ship' } });
  await away.deliver(answered, options);
  assert.deepEqual(await home.deliver(answered, options), answered);
  assert.deepEqual(await home.deliver(answered, options), answered, 'an exact answer retry returns the same result');
  assert.deepEqual(await home.deliver(Object.fromEntries(Object.entries(answered).reverse()), options), answered,
    'wire field order cannot change an idempotent delivery');
  assert.deepEqual(await home.deliver(original, options), answered, 'a late question cannot erase its answer');
  assert.deepEqual(await open('source').query(source, ['child'], queryToken(['child'])),
    { complete: true, agreed: true, answers: [{ boardId: 'child', option: 'ship' }] }, 'reopening preserves correlation and one answer');
  await assert.rejects(home.deliver(signed({ ...answered, answer: { boardId: 'child', option: 'wait' } }), options), { code: 'DECISION_HANDOFF_CONFLICT' });
  await assert.rejects(home.deliver(answered, ['ship', 'cancel']), { code: 'DECISION_HANDOFF_BINDING' });
  await assert.rejects(home.deliver({ ...answered, answer: { boardId: 'child', option: 'unknown' } }, options), { code: 'DECISION_HANDOFF_BINDING' });
  await assert.rejects(home.deliver({ ...answered, source: { ...source, decisionId: 18 } }, options), { code: 'DECISION_HANDOFF_AUTH' });
  await assert.rejects(home.deliver({ ...answered, extra: 'not disclosed' }, options), { code: 'DECISION_HANDOFF_BINDING' });
  await assert.rejects(open('unrelated').deliver(original, options), { code: 'DECISION_HANDOFF_BINDING' });
  const second = offer('other');
  await home.deliver(second, options);
  assert.equal((await home.query(source, ['child', 'other'], queryToken(['child', 'other']))).complete, false);
  await home.deliver(signed({ ...second, answer: { boardId: 'other', option: 'wait' } }), options);
  const joint = await home.query(source, ['child', 'other'], queryToken(['child', 'other']));
  assert.equal(joint.complete, true);
  assert.equal(joint.agreed, false, 'different options never become a joint decision');
  assert.equal(joint.answers.length, 2);
  await assert.rejects(home.query(source, ['child'], queryToken(['child'])), { code: 'DECISION_HANDOFF_BINDING' },
    'a caller cannot omit a known dissenting participant');
  const unanimous = { boardId: 'source', decisionId: 18 };
  for (const boardId of ['a', 'b']) {
    const request = offer(boardId, 'joint-' + boardId, unanimous);
    await home.deliver(signed({ ...request, answer: { boardId, option: 'ship' } }), options);
  }
  assert.equal((await home.query(unanimous, ['a', 'b'], queryToken(['a', 'b'], unanimous))).agreed, true);
  const foreign = offer('source', 'foreign-source', { boardId: 'peer', decisionId: 17 });
  assert.equal((await home.deliver(foreign, options)).source.boardId, 'peer', 'equal decision ids on different boards stay distinct');
  await assert.rejects(home.query(source, ['child'], 'forged'), { code: 'DECISION_HANDOFF_AUTH' });
  const early = offer('late', 'early-answer');
  const earlyAnswer = signed({ ...early, answer: { boardId: 'late', option: 'ship' } });
  assert.deepEqual(await home.deliver(earlyAnswer, options), earlyAnswer, 'answer delivery may arrive before the question');
  assert.deepEqual(await home.deliver(early, options), earlyAnswer);
  const different = { ...original, handoffId: 'duplicate-destination' };
  different.authority = signature(different);
  await assert.rejects(home.deliver(different, options), { code: 'DECISION_HANDOFF_CONFLICT' });
});
