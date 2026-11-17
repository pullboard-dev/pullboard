/** @pullboard-test-input source-cell packages/landing */
/** A main-moved notice that fails during a landing is kept and replayed on the next lander wake until it succeeds [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { appendDeferredNotice } from '../../../src/io/deferred/notices.js';
import { deferredNoticesFile } from '../../../src/io/deferred/notices.js';
import { refreshLandedMain } from '../../../src/io/deferred/notices.js';
import { replayDeferredNotices } from '../../../src/io/deferred/notices.js';

/**
 * A scratch git repository for the log to live in.
 *
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function scratch(t) {
  return cellRepo(t, { real: true }).root;
}

/**
 * The log's lines as parsed entries.
 *
 * @param {string} root
 * @returns {object[]}
 */
function logged(root) {
  return readFileSync(deferredNoticesFile(root), 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

test('landing.notices.a-failed-main-moved-notice-is: clause 1: a failed main-moved notice is appended to deferred-notices.jsonl with its kind, main and time [C7]', async t => {
  const root = scratch(t);
  const said = [];
  const tip = 'a'.repeat(40);
  await refreshLandedMain({ root, board: {}, batch: { tip }, write: async () => {}, say: line => said.push(line) });
  assert.ok(said.some(line => line.startsWith('main-move warnings deferred:')), 'the log line stays');
  const [entry, ...rest] = logged(root);
  assert.equal(rest.length, 0);
  assert.equal(entry.kind, 'main-moved');
  assert.equal(entry.main, tip);
  assert.match(entry.at, /^\d{4}-\d\d-\d\dT/u);
});

test('landing.notices.the-next-lander-wake-replays-pending: clause 1: the next lander wake replays pending notices in order and drops each that succeeds [C7]', async t => {
  const root = scratch(t);
  const [first, second, third] = ['1', '2', '3'].map(digit => digit.repeat(40));
  for (const main of [first, second, third]) appendDeferredNotice(root, { kind: 'main-moved', main });
  const attempts = [];
  const warn = async trunk => { attempts.push(trunk); if (trunk === second) throw new Error('board busy'); };
  const said = [];
  assert.deepEqual(await replayDeferredNotices({ root, say: line => said.push(line) }, warn), { replayed: 2, kept: 1 });
  assert.deepEqual(attempts, [first, second, third], 'replayed in the order they were deferred');
  assert.deepEqual(logged(root).map(entry => entry.main), [second], 'only the failed notice stays');
  assert.ok(said.some(line => line.includes('still deferred')));
  const retry = async trunk => { attempts.push(trunk); };
  assert.deepEqual(await replayDeferredNotices({ root, say() {} }, retry), { replayed: 1, kept: 0 });
  assert.equal(existsSync(deferredNoticesFile(root)), false, 'a log with nothing pending is removed');
});
