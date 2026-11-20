/** Claim judges lane ownership only by the files an item changes, from main's committed config, on every claim route [C7,#11857]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../../packages/store/index.js';
import { cli } from '../../../fixtures/next/take.js';
import { fixture } from '../../../fixtures/next/take.js';

/** A file on main that no lane of the fixture owns: web owns web/, docs owns docs/. */
const READ_ONLY = 'vendor/cells/clock/index.js';

/** A board whose main holds the unowned file next to the web lane's own file. */
const board = t => fixture(t, { files: { [READ_ONLY]: 'export const now = () => 0;\n', 'web/dispatch.js': 'export const run = () => 1;\n' } });

/** A web item that changes only web/dispatch.js but names the unowned file in its criterion, as a cited spec row does. */
const readsOnly = (box, title) => box.add(title, { criterion: `1. web/dispatch.js calls now() from ${READ_ONLY} unchanged [test].` });

/** A web item whose Files list changes the unowned file. */
const changesUnowned = (box, title) => box.add(title, { brief: `Files: ${READ_ONLY}\nTest: the clock cell answers.` });

/** The refusal code a CLI run printed, or null when it exited 0. */
const refusal = result => (result.code === 0 ? null : result.document?.error?.code ?? `exit ${result.code}: ${result.out}${result.err}`);

test('cli.io-item-bar-claim-owners.read-only-path-claims: clause 1: an item naming an unowned path only in its criterion is claimed by claim <id> and by next [C7,#11857]', async t => {
  const box = await board(t);
  const byId = readsOnly(box, 'Read the clock by id');
  const claimed = await cli(box, box.seats.actor.path, ['claim', String(byId)]);
  assert.equal(refusal(claimed), null, claimed.out + claimed.err);
  assert.equal(store.getItem(box.board, byId).item_owner, box.seats.actor.id);
  const byNext = readsOnly(box, 'Read the clock through next');
  const next = await cli(box, box.seats.builder.path, ['next', '--build']);
  assert.equal(refusal(next), null, next.out + next.err);
  assert.equal(store.getItem(box.board, byNext).item_status, 'claimed');
  assert.equal(store.getItem(box.board, byNext).item_owner, box.seats.builder.id, 'the claim next makes takes the read-only item too');
});

test('cli.io-item-bar-claim-owners.claim-and-next-agree: clause 2: an item whose Files list changes an unowned path gets CROSS_OWNERSHIP from claim <id> and next passes over it [C7,#11857]', async t => {
  const box = await board(t);
  const id = changesUnowned(box, 'Change the clock cell');
  const claimed = await cli(box, box.seats.actor.path, ['claim', String(id)]);
  assert.equal(refusal(claimed), 'CROSS_OWNERSHIP', claimed.out + claimed.err);
  assert.match(claimed.document.error.message, new RegExp(READ_ONLY.replaceAll('.', '\\.'), 'u'));
  const next = await cli(box, box.seats.builder.path, ['next', '--build']);
  assert.equal(refusal(next), 'NOTHING_FREE', next.out + next.err);
  assert.equal(store.getItem(box.board, id).item_status, 'open', 'neither route claims it');
});

test('cli.io-item-bar-claim-owners.main-config-one-answer: clause 3: a seat whose uncommitted local config gives its lane the path gets the same CROSS_OWNERSHIP as a seat on main config [C7,#11857]', async t => {
  const box = await board(t);
  const id = changesUnowned(box, 'Change the clock cell from two seats');
  const file = join(box.seats.actor.path, 'pullboard.json');
  const local = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...local, lanes: { ...local.lanes, web: { owns: ['web/', 'vendor/'] } } }));
  const edited = await cli(box, box.seats.actor.path, ['claim', String(id)]);
  const plain = await cli(box, box.seats.builder.path, ['claim', String(id)]);
  assert.equal(refusal(edited), 'CROSS_OWNERSHIP', edited.out + edited.err);
  assert.equal(refusal(plain), 'CROSS_OWNERSHIP', plain.out + plain.err);
  assert.equal(edited.document.error.message, plain.document.error.message, 'both seats get one answer');
});
