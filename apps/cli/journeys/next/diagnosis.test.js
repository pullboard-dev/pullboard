/** next hands a returned item with its gate receipt, reject note and last builder facts [C7,N2,V4]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { main } from '../../tests/fixtures/native.js';
import { fixture } from '../../tests/fixtures/next/take.js';

/** Run next --build and return its exit code with the text and JSON it printed. */
async function next(box, ...args) {
  let out = '', err = '';
  const code = await main(['next', '--build', ...args], { cwd: box.seats.actor.path, clock: box.clock,
    stdout: { isTTY: false, write: part => { out += part; } }, stderr: { write: part => { err += part; } } });
  return { code, text: `${out}${err}`, out };
}

test('clause 1: next prints a red-returned item with its gate failure, the builder facts and, in JSON, the same record [C7,N2,V4]', async t => {
  const box = await fixture(t);
  box.board.gitRoot = box.root;
  const seat = box.seats.actor;
  const id = box.add('A returned red carries its diagnosis');
  box.claim(id, seat);
  const commit = box.git(seat.path, 'rev-parse', 'HEAD');
  const tree = box.git(box.root, 'rev-parse', `${commit}^{tree}`);
  const item = store.getItem(box.board, id);
  const job = store.writeBoardCommand(box.board, 'queueSubmitHandoff', [id, { agentId: seat.id,
    job: randomUUID(), main: box.git(box.root, 'rev-parse', 'HEAD'), commit, tree,
    executionCommit: commit, executionTree: tree, digest: item.item_frozen_digest, companionDigest: null,
    leaseMs: 7_200_000 }], seat.id).job;
  store.startSubmitHandoff(box.board, id, { agentId: seat.id, job: job.id });
  store.completeSubmitHandoff(box.board, id, { agentId: seat.id, job: job.id,
    result: { code: 1, error: { code: 'GATE_RED', message: 'Fixture gate is red on the zebra case.', next: 'Fix the named source.' } } });
  store.appendFact(box.board, id, { agentId: seat.id, kind: 'note', text: 'the zebra case fails because the stripe is missing' });

  const text = await next(box);
  assert.equal(text.code, 0, text.text);
  assert.match(text.text, /returned red at [0-9a-f]{12}: GATE_RED: Fixture gate is red on the zebra case\./u);
  assert.match(text.text, /builder fact, note: the zebra case fails because the stripe is missing/u);
  const json = await next(box, '--json');
  const result = JSON.parse(json.out.slice(json.out.indexOf('{')));
  assert.equal(result.returned.gate.code, 'GATE_RED');
  assert.equal(result.returned.gate.commit, commit);
  assert.ok(result.returned.facts.some(fact => fact.includes('the zebra case fails')));
  assert.equal(result.returned.reject, null);
});
