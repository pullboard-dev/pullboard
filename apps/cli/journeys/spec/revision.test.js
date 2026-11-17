// pullboard: browser
/** @pullboard-test-gui */
/** Real person actions keep revision proposals distinct from their approved source rows [P6,B23,N39]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  machine,
  project,
  startView,
  boardOf,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
  openItemsNeeds,
} from '../../tests/fixtures/cockpit/harness.js';

test('a spec revision shows old and proposed rows side by side with proposal-id actions [P6,B23,N39]', { timeout: 120_000 }, async () => {
  const T0 = Date.now(); const P = (m) => console.error('PROBE10034 +' + (Date.now() - T0) + 'ms ' + m);
  const executable = chromeExecutable();
  P('1');
  assert.ok(executable, 'Chrome is required for the phone and desktop revision actions.');
  P('2');
  const box = machine();
  P('3');
  const spec = '# Revision fixture\n\n## G · Goals\n' + [1, 2, 3, 4].map(id =>
    `- G${id} [approved, must] Original requirement ${id}. | gate: true\n`).join('');
  const alpha = project(box, 'revision-board', spec);
  P('4');
  const proposals = [1, 2, 3, 4].map(id => JSON.parse(box.run(alpha.web, 'spec', 'draft',
    `Proposed requirement ${id}.`, '--revises', `G${id}`, '--reason', `Reason for revision ${id}.`, '--json')).id);
  assert.ok(proposals.every((id, index) => id && id !== `G${index + 1}`), 'the real core assigns distinct proposal identities');
  P('5');
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-revision-chrome-'));
  P('6');
  let chrome;
  try {
    const state = await boardOf(view, alpha.repo);
    P('7');
    assert.equal(state.needs.filter(row => row.kind === 'spec-revision').length, 4, 'the actual API carries all four proposals');
    P('8');
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.specRevisions?.length === 4');
    P('9');
    await press(chrome, "document.querySelector('[data-tab=items]')");
    P('10');
    await chrome.waitFor("!document.querySelector('[data-pane=items]').hidden");
    P('11');
    assert.equal(await chrome.stable('document.querySelectorAll("#needs [data-spec-revision]").length'), 4,
      'Needs you renders each core-projected revision as its own actionable comparison');
    await openItemsNeeds(chrome);
    P('12');
    await chrome.stable(`window.revisionMoves = []; window.revisionFetch = window.fetch; window.fetch = function(input, init) {
      if (init?.body && String(input).includes('/moves')) { const move = JSON.parse(init.body); if (move.verb) window.revisionMoves.push(move); }
      return window.revisionFetch.apply(this, arguments);
    }; true`);
    for (const [index, width] of [375, 1280].entries()) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      P('13');
      const approve = proposals[index * 2], decline = proposals[index * 2 + 1];
      P('14');
      const row = `document.querySelector('#needs [data-spec-revision="${approve}"]')`;
      P('15');
      await press(chrome, `${row}.querySelector('summary')`);
      P('16');
      await chrome.waitFor(`${row}.querySelector('details').open`);
      P('17');
      const shown = JSON.parse(await chrome.stable(`(() => { const row = ${row}; const old = row.querySelector('[data-revision-before]');
      P('18');
        const proposed = row.querySelector('[data-revision-after]'); const a = old.getBoundingClientRect(), b = proposed.getBoundingClientRect();
        return JSON.stringify({ old: old.textContent, proposed: proposed.textContent, reason: row.textContent,
          visible: a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0,
          sideBySide: a.right <= b.left + 1 && Math.abs(a.top - b.top) <= 1, right: row.getBoundingClientRect().right }); })()`));
      const original = state.specRevisions.find(proposal => proposal.id === approve);
      P('19');
      assert.ok(shown.old.includes(original.source), `${width}: the complete old row is shown`);
      P('20');
      assert.ok(shown.proposed.includes(original.replacement), `${width}: the complete proposed row is shown`);
      P('21');
      assert.ok(shown.reason.includes(original.reason), `${width}: the reason is shown`);
      P('22');
      assert.ok(shown.visible, `${width}: both row versions have visible layout boxes`);
      P('23');
      assert.ok(shown.sideBySide, `${width}: old and proposed columns are alongside each other`);
      P('24');
      assert.ok(shown.right <= width, `${width}: the comparison stays in the viewport`);
      P('25');
      await press(chrome, `${row}.querySelector('[data-row-decision="approve"]')`);
      P('26');
      await chrome.waitFor(`window.revisionMoves.some(move => move.verb === 'spec-approve' && move.args.ids === '${approve}')`);
      P('27');
      const declinedRow = `document.querySelector('#needs [data-spec-revision="${decline}"]')`;
      P('28');
      await press(chrome, `${declinedRow}.querySelector('summary')`);
      P('29');
      await chrome.waitFor(`${declinedRow}.querySelector('details').open`);
      P('30');
      await press(chrome, `${declinedRow}.querySelector('[data-row-decision="decline"]')`);
      P('31');
      await chrome.waitFor('!document.getElementById("spec-decline-dialog").hidden');
      P('32');
      await chrome.stable(`document.getElementById('spec-decline-reason').value = 'Keep the existing requirement.'; true`);
      P('33');
      await press(chrome, 'document.getElementById("spec-decline-submit")');
      P('34');
      await chrome.waitFor(`window.revisionMoves.some(move => move.verb === 'spec-decline' && move.args.ids === '${decline}')`);
      P('35');
      await chrome.waitFor(`!data.project.specRevisions.some(proposal => proposal.id === '${decline}')`);
      P('36');
      assert.equal(await chrome.stable(`window.revisionMoves.some(move => ['spec-approve','spec-decline'].includes(move.verb) && ['G1','G2','G3','G4'].includes(move.args.ids))`), false,
        'the actions address proposal IDs, never their original approved rows');
    }
    assert.deepEqual(chrome.exceptions, []);
    P('37');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    P('38');
    rmSync(profile, { recursive: true, force: true });
  }
});
