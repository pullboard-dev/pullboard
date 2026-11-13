/** A pull request without second-agent proof carries a not-verified status [B3,R3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bridgeProject,
  bridgeProvider,
  landBridgeItems,
  runBridgeCLI,
} from '../../tests/fixtures/bridge.js';

test('a pull request carries a not-verified status while its commits lack second-agent proof [B3,R3]', async t => {
  const box = bridgeProject(t);
  await landBridgeItems(box);
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

});
