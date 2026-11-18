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

test('cli.journeys-spec-revision.a-spec-revision-shows-old-and: clause 1: a spec revision shows old and proposed rows side by side with proposal-id actions [P6,B23,N39]', { timeout: 120_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the phone and desktop revision actions.');
  const box = machine();
  const spec = '# Revision fixture\n\n## G · Goals\n' + [1, 2, 3, 4].map(id =>
    `- G${id} [approved, must] Original requirement ${id}. | gate: true\n`).join('');
  const alpha = project(box, 'revision-board', spec);
  const proposals = [];
  for (const id of [1, 2, 3, 4]) proposals.push(JSON.parse(await box.inProcess(alpha.web, 'spec', 'draft',
    `Proposed requirement ${id}.`, '--revises', `G${id}`, '--reason', `Reason for revision ${id}.`, '--json')).id);
  assert.ok(proposals.every((id, index) => id && id !== `G${index + 1}`), 'the real core assigns distinct proposal identities');
  const view = await startView(box, { inProcess: true }), profile = mkdtempSync(join(tmpdir(), 'pullboard-revision-chrome-'));
  let chrome;
  try {
    const state = await boardOf(view, alpha.repo);
    assert.equal(state.needs.filter(row => row.kind === 'spec-revision').length, 4, 'the actual API carries all four proposals');
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.specRevisions?.length === 4');
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor("!document.querySelector('[data-pane=items]').hidden");
    assert.equal(await chrome.stable('document.querySelectorAll("#needs [data-spec-revision]").length'), 4,
      'Needs you renders each core-projected revision as its own actionable comparison');
    await openItemsNeeds(chrome);
    await chrome.stable(`window.revisionMoves = []; window.revisionSettled = []; window.revisionFetch = window.fetch; window.fetch = function(input, init) {
      const answer = window.revisionFetch.apply(this, arguments);
      if (init?.body && String(input).includes('/moves')) {
        const move = JSON.parse(init.body);
        if (move.verb) { window.revisionMoves.push(move); answer.finally(() => setTimeout(() => window.revisionSettled.push(move.args.ids), 0)); }
      }
      return answer;
    }; true`);
    for (const [index, width] of [375, 1280].entries()) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const approve = proposals[index * 2], decline = proposals[index * 2 + 1];
      const row = `document.querySelector('#needs [data-spec-revision="${approve}"]')`;
      await press(chrome, `${row}.querySelector('summary')`);
      await chrome.waitFor(`${row}.querySelector('details').open`);
      const shown = JSON.parse(await chrome.stable(`(() => { const row = ${row}; const old = row.querySelector('[data-revision-before]');
        const proposed = row.querySelector('[data-revision-after]'); const a = old.getBoundingClientRect(), b = proposed.getBoundingClientRect();
        return JSON.stringify({ old: old.textContent, proposed: proposed.textContent, reason: row.textContent,
          visible: a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0,
          sideBySide: a.right <= b.left + 1 && Math.abs(a.top - b.top) <= 1, right: row.getBoundingClientRect().right }); })()`));
      const original = state.specRevisions.find(proposal => proposal.id === approve);
      assert.ok(shown.old.includes(original.source), `${width}: the complete old row is shown`);
      assert.ok(shown.proposed.includes(original.replacement), `${width}: the complete proposed row is shown`);
      assert.ok(shown.reason.includes(original.reason), `${width}: the reason is shown`);
      assert.ok(shown.visible, `${width}: both row versions have visible layout boxes`);
      assert.ok(shown.sideBySide, `${width}: old and proposed columns are alongside each other`);
      assert.ok(shown.right <= width, `${width}: the comparison stays in the viewport`);
      await press(chrome, `${row}.querySelector('[data-row-decision="approve"]')`);
      await chrome.waitFor(`window.revisionMoves.some(move => move.verb === 'spec-approve' && move.args.ids === '${approve}')`);
      await chrome.waitFor(`window.revisionSettled.includes('${approve}')`);
      const declinedRow = `document.querySelector('#needs [data-spec-revision="${decline}"]')`;
      await press(chrome, `${declinedRow}.querySelector('summary')`);
      await chrome.waitFor(`${declinedRow}.querySelector('details').open`);
      await press(chrome, `${declinedRow}.querySelector('[data-row-decision="decline"]')`);
      await chrome.waitFor('!document.getElementById("spec-decline-dialog").hidden');
      await chrome.stable(`document.getElementById('spec-decline-reason').value = 'Keep the existing requirement.'; true`);
      await press(chrome, 'document.getElementById("spec-decline-submit")');
      await chrome.waitFor(`window.revisionMoves.some(move => move.verb === 'spec-decline' && move.args.ids === '${decline}')`);
      await chrome.waitFor(`!data.project.specRevisions.some(proposal => proposal.id === '${decline}')`);
      assert.equal(await chrome.stable(`window.revisionMoves.some(move => ['spec-approve','spec-decline'].includes(move.verb) && ['G1','G2','G3','G4'].includes(move.args.ids))`), false,
        'the actions address proposal IDs, never their original approved rows');
    }
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
