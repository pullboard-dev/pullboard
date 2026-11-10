import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crossLaneFixture } from '../../tests/fixtures/e2e.js';

test('next and show give the holding seat its continuation step without suggesting a claim [N2,B13]', t => {
  const box = crossLaneFixture(t);
  const holder = box.seat('you-hold-builder', 'web', box.session);
  const peer = box.seat('you-hold-peer', 'web', box.session);
  const item = box.add('web', 'Continue the existing claim');
  box.json(box.runAs(box.session, holder.root, 'claim', String(item), '--json'));

  const next = box.runAs(box.session, holder.root, 'next', '--build');
  assert.equal(next.code, 0, next.out + next.err);
  assert.match(next.out, new RegExp(`you hold #${item}\\b`, 'u'));
  assert.match(next.out, new RegExp(`pullboard submit ${item}(?:\\s|$)`, 'u'));
  assert.doesNotMatch(next.out, new RegExp(`pullboard submit ${item} --wait`, 'u'));
  assert.doesNotMatch(next.out, new RegExp(`pullboard claim ${item}`, 'u'));

  const ownShow = box.runAs(box.session, holder.root, 'show', String(item));
  assert.equal(ownShow.code, 0, ownShow.out + ownShow.err);
  assert.match(ownShow.out, new RegExp(`you hold #${item}\\b`, 'u'));
  assert.match(ownShow.out, new RegExp(`pullboard submit ${item}(?:\\s|$)`, 'u'));
  assert.doesNotMatch(ownShow.out, new RegExp(`pullboard submit ${item} --wait`, 'u'));
  assert.doesNotMatch(ownShow.out, new RegExp(`pullboard claim ${item}`, 'u'));

  const peerShow = box.runAs(box.session, peer.root, 'show', String(item));
  assert.equal(peerShow.code, 0, peerShow.out + peerShow.err);
  assert.doesNotMatch(peerShow.out, new RegExp(`you hold #${item}\\b`, 'u'));
  assert.doesNotMatch(peerShow.out, new RegExp(`pullboard claim ${item}`, 'u'));
  assert.notEqual(holder.agent, peer.agent);
});
