import { nativeBoardPorts as relayPresentationNativePorts } from '../../../../lib/index.js';
/** Checkpoint invalidation follows sealed business inputs rather than private command recovery [H5,C6,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { repoInfo } from '../../../../../packages/git/index.js';
import { recordBlock } from '../../../../../packages/items/index.js';
import {
  relayPresentation,
  presentationDigest,
} from '../../../../../packages/pages/index.js';

/** Bind the real canonical presentation providers once for this fixture module. */
const RELAY_PRESENTATION_PORTS = relayPresentationNativePorts().presentation;

/** Supply real Git and SQLite state while freezing only the documented presentation observation argument. */
function checkpointBox(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project();
  const observedAt = Date.now();
  t.diagnostic('checkpoint input executor: ' + JSON.stringify({ node: process.versions.node, platform: process.platform, arch: process.arch }));
  return { root: box.repo, commonDir: repoInfo(box.repo).commonDir, observedAt };
}

/** Write a synthetic local refusal through the public ledger API, without a board move or authentication claim. */
function refusal(box, audience, code) {
  recordBlock(box.commonDir, { at: new Date(box.observedAt).toISOString(), code, command: 'pullboard add',
    by: 'coordinator', path: box.root, audience, reason: 'synthetic checkpoint input refusal', step: 'correct the synthetic request' });
}

test('checkpoint fingerprints ignore an agent-only refusal when complete sealed state is unchanged [H5,C6,H16]', t => {
  const box = checkpointBox(t);
  const before = relayPresentation(box.root, { observedAt: box.observedAt }, RELAY_PRESENTATION_PORTS);
  refusal(box, 'agent', 'UNKNOWN_SPEC');
  const after = relayPresentation(box.root, { observedAt: box.observedAt }, RELAY_PRESENTATION_PORTS);
  assert.deepEqual(after.state, before.state, 'all emitted state fields remain exact, including presence, proof stats and observation time');
  assert.equal(presentationDigest(after), presentationDigest(before), 'a private recovery ledger append alone needs no new sealed checkpoint');
});

test('checkpoint fingerprints retain a new person-visible refusal and its complete Needs you state [H5,C6,H16]', t => {
  const box = checkpointBox(t);
  const before = relayPresentation(box.root, { observedAt: box.observedAt }, RELAY_PRESENTATION_PORTS);
  refusal(box, 'person', 'HUMAN_REQUIRED');
  const after = relayPresentation(box.root, { observedAt: box.observedAt }, RELAY_PRESENTATION_PORTS);
  assert.ok(after.state.blocks.some(block => block.code === 'HUMAN_REQUIRED' && block.reason === 'synthetic checkpoint input refusal'));
  assert.notDeepEqual(after.state, before.state);
  assert.notEqual(presentationDigest(after), presentationDigest(before), 'public recovery still invalidates the complete checkpoint');
});
