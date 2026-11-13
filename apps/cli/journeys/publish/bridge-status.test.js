/** A pull request carries a second-agent verified status, and repeating a publish adds none [B3,R3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bridgeProject,
  bridgeProvider,
  landBridgeItems,
  runBridgeCLI,
} from '../../tests/fixtures/bridge.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import * as store from '../../../../packages/store/index.js';

test('a pull request carries a verified-by-a-second-agent status, and an unchanged republish adds no duplicate [B3,R3]', async t => {
  const box = bridgeProject(t);
  landBridgeItems(box);
  const provider = await bridgeProvider(t, box);
  const published = await runBridgeCLI(box, 'publish', '--json');
  assert.equal(published.code, 0, published.err);
  const pull = provider.pulls[0];
  const status = provider.statuses.findLast(entry => entry.sha === pull.head.sha
    && entry.context === 'pullboard/verified-by-second-agent');
  assert.equal(status?.state, 'failure',
    'the actual PR must carry not verified while its unreceipted configuration/merge commits lack second-agent proof');
  assert.match(status.description, /^not verified/u);
  assert.match(status.description, /independence is unproven/u, 'procedural receipts are explicitly unproven');

  const proven = bridgeProject(t);
  const entries = landBridgeItems(proven, { independent: true });
  assert.ok(onBoard(proven, board => entries.every(entry => store.acceptedVerdict(board, store.getItem(board, entry.id)).assurance === 'independent')),
    'the positive uses actual CLI checks and immutable independently registered fixture parent receipts');
  const github = await bridgeProvider(t, proven);
  const opened = await runBridgeCLI(proven, 'publish', '--json');
  assert.equal(opened.code, 0, opened.err);
  const native = github.pulls[0];
  const latest = head => github.statuses.findLast(entry => entry.sha === head && entry.context === 'pullboard/verified-by-second-agent');
  assert.equal(latest(native.head.sha).state, 'success', 'recorded item merges, introduced commits and trusted companion are covered');
  assert.match(latest(native.head.sha).description, /independent/u);
  const beforeRepeat = github.statuses.length;
  assert.equal((await runBridgeCLI(proven, 'publish', '--json')).code, 0);
  assert.equal(github.statuses.length, beforeRepeat, 'unchanged receipt state does not create duplicate provider statuses');
});
