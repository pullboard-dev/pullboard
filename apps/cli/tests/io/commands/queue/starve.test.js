/** review.starveShout sends one coordinator shout naming the refusing guards for a green submission nobody may review, and is off by default [C7,#9682]. @pullboard-test-input source-cell apps/cli packages/config packages/health */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../../packages/store/index.js';
import { machineSettingsFile } from '../../../../../../packages/config/index.js';
import { submitFixture } from '../../../fixtures/board/submit.js';
import { cli } from '../../../fixtures/next/take.js';
import { fixture } from '../../../fixtures/next/take.js';

/** Every fixture seat declares one vendor family, so the family guard refuses each of them for a builder's submission. */
const ONE_FAMILY = { families: { alpha: ['Family Alpha', 'Family Beta'] } };

/** Write this fixture machine's review settings, keeping the settings the fixture wrote. */
function reviewSettings(review) {
  const file = machineSettingsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false }, review }));
}

/** One green submission, older than the waiting alarm, that every seat is refused. */
function starved(box) {
  const id = box.add('Starved review');
  store.claim(box.board, id, { agentId: box.seats.builder.id, lane: 'web', leaseMs: 3_600_000, freeze: item => {
    const text = JSON.stringify({ title: item.item_title, criterion: item.item_criterion, check: item.item_check, rows: [] });
    return { text, digest: createHash('sha256').update(text).digest('hex') };
  } });
  const head = box.git(box.seats.builder.path, 'rev-parse', 'HEAD');
  submitFixture(box.board, id, { agentId: box.seats.builder.id, commit: head, tree: box.git(box.root, 'rev-parse', `${head}^{tree}`), gateGreen: true });
  box.advance(10 * 60_000);
  return id;
}

/** The sentinel shouts to the coordinator recorded so far. */
function starveShouts(box) {
  return box.board.db.prepare("SELECT shout_text FROM shout WHERE shout_from='sentinel' AND shout_to='coordinator' AND shout_text LIKE 'Stuck: review starved.%'").all();
}

test('cli.journeys-queue-starve-shout.with-review-starveshout-on-a-starved: clause 1: with review.starveShout on, a starved green submission yields exactly one coordinator shout naming the refusing guard [C7,#9682]', async t => {
  const box = await fixture(t, { family: 'require', projectConfig: ONE_FAMILY });
  const id = starved(box);
  reviewSettings({ starveShout: true });
  for (let sweep = 0; sweep < 2; sweep += 1) {
    const answer = await cli(box, box.seats.actor.path, ['next']);
    assert.equal(answer.code, 0, answer.out + answer.err);
  }
  const shouts = starveShouts(box);
  assert.equal(shouts.length, 1, 'two sweeps send one shout');
  assert.match(shouts[0].shout_text, new RegExp(`#${id} `, 'u'));
  assert.match(shouts[0].shout_text, /Refused by: [A-Z0-9_]+ x\d/u, 'the shout names the refusing guard');
});

test('cli.journeys-queue-starve-shout.with-review-starveshout-off-a-starved: clause 2: with review.starveShout off, a starved green submission sends no shout [C7,#9682]', async t => {
  const box = await fixture(t, { family: 'require', projectConfig: ONE_FAMILY });
  starved(box);
  const answer = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(answer.code, 0, answer.out + answer.err);
  assert.equal(starveShouts(box).length, 0);
});
