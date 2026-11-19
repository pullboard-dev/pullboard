/** next.holdAboveLoad hands no new claim to a seat on a machine above machine.loadCeiling, on an injected load reading, and is off by default [C7,#9703]. @pullboard-test-input source-cell apps/cli packages/config packages/resources */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { cli } from '../../fixtures/next/take.js';
import { fixture } from '../../fixtures/next/take.js';
import { injectLoad } from '../../fixtures/next/take.js';
import { machineSettings } from '../../fixtures/next/take.js';

test('cli.io-next-load-ceiling.cli-next-load-ceiling-above-machine-loadceiling: cli.next.load-ceiling.above-machine-loadceiling-next-hands-no: clause 1: above machine.loadCeiling next hands no new build or review claim and names the load [C7,#9703]', async t => {
  const box = await fixture(t);
  const review = box.add('Review waiting');
  box.submit(review);
  const open = box.add('Open build');
  machineSettings({ holdAboveLoad: true });
  injectLoad(t, 30);
  for (const args of [['next', '--take'], ['next'], ['next', '--verify']]) {
    const answer = await cli(box, box.seats.actor.path, args);
    assert.equal(answer.document?.item ?? null, null, `${args.join(' ')} hands no item: ${answer.out}${answer.err}`);
    assert.match(answer.out + answer.err, /1-minute load 30 on 4 cores \(ceiling 6\)/u, `${args.join(' ')} names the load`);
  }
  assert.equal(store.getItem(box.board, open).item_status, 'open', 'the open build stays unclaimed');
  assert.equal(store.getItem(box.board, review).item_review_by ?? null, null, 'the waiting review stays unreserved');
});
