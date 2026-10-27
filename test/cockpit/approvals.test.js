/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** Agent-approved rows remain readable and actionable in the person view [B26,N26,S1,P6]. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { machine, project, startView, boardOf, chromeExecutable, openSnapshotChrome, closeSnapshotChrome } from './fixture.js';

test('agent approvals show full rows and styled actions at narrow width and resolve from Spec detail [B26,N26,S1,P6]', { timeout: 120_000 }, async () => { // budget: real Git/API/browser setup and two person decisions; no performance claim.
  const box = machine();
  box.env.GIT_AUTHOR_NAME = 'Agent <review> & team';
  const spec = '# Approval review\n\n## G · Goals\n- G1 [approved, must] Show the complete first requirement, including its final words. | gate: first browser gate\n- G2 [approved, must] Show the complete second requirement before declining it. | gate: second browser gate\n';
  const alpha = project(box, 'approval-review', spec, {}, { agentApproved: true });
  const view = await startView(box);
  let chrome;
  try {
    const before = await boardOf(view, alpha.repo);
    assert.deepEqual(before.needs.filter(row => row.kind === 'agent-approved').map(row => row.id), ['G1', 'G2']);
    const executable = chromeExecutable();
    assert.ok(executable, 'real Chrome is required for person actions and narrow layout');
    chrome = await openSnapshotChrome(executable, view.link.href, join(box.dir, 'approval-review-chrome'));
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 375 && document.querySelectorAll("#needs [data-agent-approved]").length === 2');
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor(`view.tab === 'items' && [...document.querySelectorAll('#needs [data-agent-approved], #needs [data-row-decision]')].every(element => {
      const box = element.getBoundingClientRect();
      return !element.closest('[hidden]') && getComputedStyle(element).visibility === 'visible' && box.width > 0 && box.height > 0;
    })`);
    for (const row of before.spec) {
      const commitDate = new Date(box.git(alpha.repo, 'show', '-s', '--format=%cI', row.agentApproval.commit)).toISOString();
      assert.equal(row.agentApproval.approvedAt, commitDate, 'core approval time matches the actual commit committer date');
      const shown = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const row = document.querySelector('#needs [data-agent-approved="${row.id}"]');
        const buttons = [...row.querySelectorAll('[data-row-decision]')];
        const boxes = buttons.map(button => button.getBoundingClientRect());
        const commit = row.querySelector('code');
        const title = row.querySelector('.t');
        return { text: row.textContent, commit: commit.textContent, full: commit.title, at: row.querySelector('time')?.dateTime,
          tab: view.tab, boxes: boxes.map(box => ({ x: box.x, y: box.y, width: box.width, height: box.height })),
          unclipped: getComputedStyle(title).whiteSpace !== 'nowrap' && title.scrollHeight <= title.clientHeight,
          labels: buttons.map(button => button.textContent),
          styled: buttons.every(button => button.classList.contains(button.dataset.rowDecision === 'approve' ? 'approve-row' : 'decline-row'))
            && getComputedStyle(buttons[0]).backgroundColor !== 'rgba(0, 0, 0, 0)' && getComputedStyle(buttons[1]).borderTopStyle === 'solid',
          targets: boxes.every(box => box.height >= 44),
          beside: boxes[0].top === boxes[1].top && boxes[0].right <= boxes[1].left,
          overflow: document.documentElement.scrollWidth > innerWidth };
      })())`));
      assert.ok(shown.text.includes(row.text), 'Needs-you includes the entire actual row text');
      assert.equal(shown.unclipped, true, 'the complete row wraps without visual clipping');
      assert.ok(shown.text.includes(row.gate), 'Needs-you includes the actual gate');
      assert.ok(shown.text.includes(row.agentApproval.agent), 'plain attribution preserves the actual recorded Git author');
      assert.equal(shown.at, commitDate, 'the visible date uses the core-provided timestamp');
      assert.doesNotMatch(shown.text, /Git author, seat unknown/u);
      assert.equal(shown.commit, row.agentApproval.commit.slice(0, 12));
      assert.equal(shown.full, row.agentApproval.commit, 'the full commit remains available on hover');
      assert.deepEqual(shown.labels, ['Confirm', 'Decline']);
      assert.equal(shown.styled, true);
      assert.equal(shown.targets, true, 'visible action geometry: ' + JSON.stringify({ tab: shown.tab, boxes: shown.boxes }));
      assert.equal(shown.beside, true, 'both styled buttons remain side by side on a phone');
      assert.equal(shown.overflow, false);
    }
    await chrome.click("document.querySelector('[data-tab=spec]')");
    await chrome.click('document.querySelector(\'#spec-chips [data-rows="spec:all"]\')');
    await chrome.click('document.querySelector(\'#spec-list [data-row="spec:G1"]\')');
    await chrome.waitFor('document.querySelector("#spec-detail h2 span")?.textContent === "G1"');
    assert.equal(await chrome.stable('document.querySelector("#spec-detail [data-row-decision=approve]")?.textContent'), 'Confirm');
    await chrome.click('document.querySelector("#spec-detail [data-row-decision=approve]")');
    await chrome.waitFor('!data.project.spec.find(row => row.id === "G1").agentApproval');
    const confirmed = await boardOf(view, alpha.repo);
    assert.equal(confirmed.spec.find(row => row.id === 'G1').agentApproval, null, 'the actual person confirmation is recorded');
    assert.equal(confirmed.needs.some(row => row.kind === 'agent-approved' && row.id === 'G1'), false);
    await chrome.click('document.querySelector(\'#spec-list [data-row="spec:G2"]\')');
    await chrome.waitFor('document.querySelector("#spec-detail h2 span")?.textContent === "G2"');
    await chrome.click('document.querySelector("#spec-detail [data-row-decision=decline]")');
    await chrome.click('document.querySelector("#spec-decline-reason")');
    await chrome.send('Input.insertText', { text: 'The second requirement needs revision.' });
    await chrome.click('document.querySelector("#spec-decline-submit")');
    await chrome.waitFor('data.project.spec.find(row => row.id === "G2").decision?.decision === "decline"');
    const declined = await boardOf(view, alpha.repo);
    assert.equal(declined.spec.find(row => row.id === 'G2').decision.reason, 'The second requirement needs revision.');
    assert.equal(declined.needs.some(row => row.kind === 'agent-approved' && row.id === 'G2'), false);
    appendFileSync(join(alpha.repo, 'SPEC.md'), '- G3 [approved, must] A working-tree approval has no commit date. | gate: manual review\n');
    await chrome.stable('refresh()');
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor('document.querySelector(\'#needs [data-agent-approved="G3"]\') !== null');
    assert.equal(await chrome.stable('data.project.spec.find(row => row.id === "G3").agentApproval.commit'), null);
    assert.match(await chrome.stable('document.querySelector(\'#needs [data-agent-approved="G3"]\').textContent'), /Date unknown/u,
      'an actual uncommitted approval never invents a date');
  } finally {
    try { if (chrome) await closeSnapshotChrome(chrome); }
    finally { await view.stop(); }
  }
});
