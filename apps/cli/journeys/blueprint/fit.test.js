/** @pullboard-test-gui */
/** Cockpit blueprint fit checks, using the shared real-board fixtures [N26,S1]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SPEC,
  machine,
  project,
  startView,
  openPage,
} from '../../tests/fixtures/cockpit/harness.js';

/**
 * A fit proposal as the state carries it after projectFit: unverified, with its recorder shown only as recorded.
 *
 * @param {object} fields - The target, decision, text or reason, and recorder.
 * @returns {object} One proposal in the state's shape.
 */
function proposal({ target, decision, text, reason, recorder }) {
  return {
    target, decision, text, reason,
    kind: 'row', key: target, source: 'blueprints/cockpit.md', blueprint: { name: 'cockpit starter', version: '2' },
    recordedAs: recorder, verified: false,
  };
}

test('the view shows every fit proposal with its reason and source [N26,S1]', async () => {
  const box = machine();
  project(box, 'fit board', SPEC);
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ tab: 'spec' }); // a person opens Spec first: pages open on the Dashboard and the fit panel draws only there.
    const fit = [
      proposal({ target: 'G1', decision: 'keep', recorder: 'builder-1' }),
      proposal({ target: 'G2', decision: 'adapt', text: 'Each card names its owner.', recorder: 'builder-1' }),
      proposal({ target: 'G3', decision: 'drop', reason: 'Covered by G1.', recorder: 'reviewer-2' }),
    ];
    await page.run(`data.project.fit = ${JSON.stringify(fit)}; render();`);
    const html = page.element('spec-fit').innerHTML;
    const panel = html.replace(/<[^>]+>/g, '');
    assert.match(panel, /Blueprint fit: 3 unverified proposals waiting for you/, 'the panel counts all three proposals together');
    assert.equal((html.match(/class="fit-row"/g) || []).length, 3, 'each proposal is one row in the panel');
    assert.match(panel, /G1keepunverified draft, recorded as builder-1/, 'a keep row names its decision and its recorder as recorded');
    assert.match(panel, /G2adaptunverified draft, recorded as builder-1Each card names its owner\./, 'an adapt row shows its new text');
    assert.match(panel, /G3dropunverified draft, recorded as reviewer-2Reason: Covered by G1\./, 'a drop row shows its reason');
    assert.equal((panel.match(/Blueprint source: cockpit starter v2 row G[123]: blueprints\/cockpit\.md/g) || []).length, 3, 'every row shows its blueprint source');
    assert.doesNotMatch(panel, /authenticated|verified by|signed/i, 'no recorder is shown as authenticated');
    await page.run('data.project.fit = []; render();');
    assert.equal(page.element('spec-fit').innerHTML, '', 'the panel is empty when no proposal waits');
  } finally {
    await view.stop();
  }
});
