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

test('clause 1: a spec revision shows old and proposed rows side by side with proposal-id actions [P6,B23,N39]', { timeout: 120_000 }, async () => {
  const T0 = Date.now(); const Q = (m) => console.error('PROBE10034 +' + (Date.now() - T0) + 'ms ' + m);
  const executable = chromeExecutable();
  Q('1');
  assert.ok(executable, 'Chrome is required for the phone and desktop revision actions.');
  Q('2');
  const box = machine();
  Q('3');
  const spec = '# Revision fixture\n\n## G · Goals\n' + [1, 2, 3, 4].map(id =>
    `- G${id} [approved, must] Original requirement ${id}. | gate: true\n`).join('');
  const alpha = project(box, 'revision-board', spec);
  Q('4');
  const proposals = [];
  Q('5');
  for (const id of [1, 2, 3, 4]) proposals.push(JSON.parse(await box.inProcess(alpha.web, 'spec', 'draft',
    `Proposed requirement ${id}.`, '--revises', `G${id}`, '--reason', `Reason for revision ${id}.`, '--json')).id);
  assert.ok(proposals.every((id, index) => id && id !== `G${index + 1}`), 'the real core assigns distinct proposal identities');
  Q('6');
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-revision-chrome-'));
  Q('7');
  let chrome;
  try {
    const state = await boardOf(view, alpha.repo);
    Q('8');
    assert.equal(state.needs.filter(row => row.kind === 'spec-revision').length, 4, 'the actual API carries all four proposals');
    Q('9');
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.specRevisions?.length === 4');
    Q('10');
    await press(chrome, "document.querySelector('[data-tab=items]')");
    Q('11');
    await chrome.waitFor("!document.querySelector('[data-pane=items]').hidden");
    Q('12');
    assert.equal(await chrome.stable('document.querySelectorAll("#needs [data-spec-revision]").length'), 4,
      'Needs you renders each core-projected revision as its own actionable comparison');
    await openItemsNeeds(chrome);
    Q('13');
    await chrome.stable(`window.revisionMoves = []; window.revisionSettled = []; window.revisionFetch = window.fetch; window.fetch = function(input, init) {
      const answer = window.revisionFetch.apply(this, arguments);
      Q('14');
      if (init?.body && String(input).includes('/moves')) {
        const move = JSON.parse(init.body);
        if (move.verb) { window.revisionMoves.push(move); answer.finally(() => setTimeout(() => window.revisionSettled.push(move.args.ids), 0)); }
      }
      return answer;
    }; true`);
    for (const [index, width] of [375, 1280].entries()) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      Q('15');
      const approve = proposals[index * 2], decline = proposals[index * 2 + 1];
      Q('16');
      const row = `document.querySelector('#needs [data-spec-revision="${approve}"]')`;
      Q('17');
      await press(chrome, `${row}.querySelector('summary')`);
      Q('18');
      await chrome.waitFor(`${row}.querySelector('details').open`);
      Q('19');
      const shown = JSON.parse(await chrome.stable(`(() => { const row = ${row}; const old = row.querySelector('[data-revision-before]');
      Q('20');
        const proposed = row.querySelector('[data-revision-after]'); const a = old.getBoundingClientRect(), b = proposed.getBoundingClientRect();
        return JSON.stringify({ old: old.textContent, proposed: proposed.textContent, reason: row.textContent,
          visible: a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0,
          sideBySide: a.right <= b.left + 1 && Math.abs(a.top - b.top) <= 1, right: row.getBoundingClientRect().right }); })()`));
      const original = state.specRevisions.find(proposal => proposal.id === approve);
      Q('21');
      assert.ok(shown.old.includes(original.source), `${width}: the complete old row is shown`);
      Q('22');
      assert.ok(shown.proposed.includes(original.replacement), `${width}: the complete proposed row is shown`);
      Q('23');
      assert.ok(shown.reason.includes(original.reason), `${width}: the reason is shown`);
      Q('24');
      assert.ok(shown.visible, `${width}: both row versions have visible layout boxes`);
      Q('25');
      assert.ok(shown.sideBySide, `${width}: old and proposed columns are alongside each other`);
      Q('26');
      assert.ok(shown.right <= width, `${width}: the comparison stays in the viewport`);
      Q('27');
      await press(chrome, `${row}.querySelector('[data-row-decision="approve"]')`);
      Q('28');
      await chrome.waitFor(`window.revisionMoves.some(move => move.verb === 'spec-approve' && move.args.ids === '${approve}')`);
      Q('29');
      await chrome.waitFor(`window.revisionSettled.includes('${approve}')`);
      Q('30');
      const declinedRow = `document.querySelector('#needs [data-spec-revision="${decline}"]')`;
      Q('31');
      await press(chrome, `${declinedRow}.querySelector('summary')`);
      Q('32');
      await chrome.waitFor(`${declinedRow}.querySelector('details').open`);
      Q('33');
      await press(chrome, `${declinedRow}.querySelector('[data-row-decision="decline"]')`);
      Q('34');
      await chrome.waitFor('!document.getElementById("spec-decline-dialog").hidden');
      Q('35');
      await chrome.stable(`document.getElementById('spec-decline-reason').value = 'Keep the existing requirement.'; true`);
      Q('36');
      await press(chrome, 'document.getElementById("spec-decline-submit")');
      Q('37');
      await chrome.waitFor(`window.revisionMoves.some(move => move.verb === 'spec-decline' && move.args.ids === '${decline}')`);
      Q('38');
      await chrome.waitFor(`!data.project.specRevisions.some(proposal => proposal.id === '${decline}')`);
      Q('39');
      assert.equal(await chrome.stable(`window.revisionMoves.some(move => ['spec-approve','spec-decline'].includes(move.verb) && ['G1','G2','G3','G4'].includes(move.args.ids))`), false,
        'the actions address proposal IDs, never their original approved rows');
    }
    assert.deepEqual(chrome.exceptions, []);
    Q('40');
  } finally {
    const T = Date.now(), P = m => console.error('PROBE10034 +' + (Date.now() - T) + 'ms ' + m);
    P('finally start');
    if (chrome) await closeSnapshotChrome(chrome);
    P('chrome closed');
    await view.stop();
    P('view stopped');
    rmSync(profile, { recursive: true, force: true });
    P('profile removed; handles ' + process.getActiveResourcesInfo().join(',') + ' children ' + JSON.stringify(process._getActiveHandles().filter(h => h.spawnfile).map(h => ({ file: h.spawnfile, args: (h.spawnargs || []).slice(0, 4).join(' ').slice(0, 120), pid: h.pid, exit: h.exitCode }))));
    
  }
});
