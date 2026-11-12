/** next and show agree on an item whose gate stopped on infrastructure: nothing to build, the coordinator requeues [C7,N2,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordSubmitHandoff } from '../../../../packages/jobs/index.js';
import * as store from '../../../../packages/store/index.js';
import { main } from '../../tests/fixtures/native.js';
import { fixture } from '../../tests/fixtures/next/take.js';

const NEXT_LINE = 'nothing to do as the builder: the coordinator restores the named runner and requeues this gate';

/** Run one command with human output as the given seat. */
async function say(box, seat, args) {
  let out = '', err = '';
  const code = await main(args, { cwd: seat.path, clock: box.clock,
    stdout: { isTTY: false, write: part => { out += part; } }, stderr: { write: part => { err += part; } } });
  return { code, text: `${out}${err}` };
}

/** Record the claim's latest gate the way the handoff worker does when its runners are exhausted. */
function exhausted(box, id, seat) {
  const item = store.getItem(box.board, id);
  recordSubmitHandoff(box.board.db, id, { id: `infra-${id}`, commit: box.git(seat.path, 'rev-parse', 'HEAD'), agentId: seat.id,
    digest: item.item_frozen_digest, state: 'infrastructure',
    error: { code: 'GATE_INFRA_EXHAUSTED', message: 'the gate stopped on infrastructure 4 times; nothing is wrong with the candidate', next: NEXT_LINE } });
}

test('clause 1: a claim whose last gate is GATE_INFRA_EXHAUSTED gets the same instruction from next and show, red labelled infrastructure [C7,N2,V4]', async t => {
  const box = await fixture(t);
  box.board.gitRoot = box.root;
  const seat = box.seats.actor;
  const id = box.add('Gate stopped on infrastructure');
  box.claim(id, seat);
  exhausted(box, id, seat);

  const next = await say(box, seat, ['next', '--build']);
  assert.equal(next.code, 0, next.text);
  const lines = next.text.split(/\r?\n/u);
  assert.match(lines[0], new RegExp(`^you hold #${id}: `, 'u'));
  assert.match(lines[1], /^infrastructure stop at [0-9a-f]{12}, not a red on the candidate: GATE_INFRA_EXHAUSTED/u);
  assert.ok(next.text.includes(`next: ${NEXT_LINE}`), next.text);
  assert.doesNotMatch(next.text, /next: build and commit/u, 'an infrastructure stop is not builder work');

  const shown = await say(box, seat, ['show', String(id)]);
  assert.equal(shown.code, 0, shown.text);
  assert.ok(shown.text.includes(`next: ${NEXT_LINE}`), shown.text);
  assert.match(shown.text, /GATE_INFRA_EXHAUSTED: .*nothing is wrong with the candidate/u);
});

test('clause 1: an open, released item whose last gate is GATE_INFRA_EXHAUSTED is skipped by next with the gate named, not offered as fresh work [C7,N2,V4]', async t => {
  const box = await fixture(t);
  box.board.gitRoot = box.root;
  const seat = box.seats.actor;
  const id = box.add('Released after an infrastructure stop');
  box.claim(id, seat);
  exhausted(box, id, seat);
  store.release(box.board, id, seat.id, 'released after the infrastructure stop', undefined, 'BLOCKED');
  assert.equal(store.getItem(box.board, id).item_status, 'open');

  const offer = store.nextFor(box.board, { agentId: seat.id, lane: 'web' });
  assert.equal(offer.item, null, 'the stopped work is not offered as fresh builder work');
  assert.ok(offer.reasons.some(line => new RegExp(`^#${id}: gate GATE_INFRA_EXHAUSTED at [0-9a-f]{12}; nothing to build$`, 'u').test(line)), offer.reasons.join(' | '));

  const next = await say(box, seat, ['next', '--build']);
  assert.doesNotMatch(next.text, new RegExp(`^(claimed|you hold) #${id}`, 'mu'), next.text);
});
