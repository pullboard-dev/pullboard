// pullboard: browser
/** @pullboard-test-gui */
/** A retained refreeze stays claimed in native history and in the real detail timeline [N26,C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { machine, project, startView, boardOf, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, press } from './fixture.js';

test('retained refreeze remains claimed in API history and the detail timeline on desktop and phone [N26,C7]', { timeout: 120_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the desktop and phone timeline controls.');
  const box = machine();
  const repo = project(box, 'retained-refreeze-timeline');
  box.run(repo.repo, 'add', 'web', 'Timeline retained refreeze', '--specs', 'G1', '--route', 'strong', '--criterion', 'Original criterion', '--check', 'true', '--wait');
  const id = 1;
  box.run(repo.web, 'claim', String(id));
  box.run(repo.repo, 'edit', String(id), '--criterion', 'Corrected criterion', '--reason', 'The original criterion omitted a necessary case');
  box.run(repo.repo, 'refreeze', String(id));
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-retained-refreeze-timeline-'));
  let chrome;
  try {
    const state = await boardOf(view, repo.repo);
    const item = state.items.find(row => row.id === id);
    const threadRefreeze = item.thread.findLast(entry => entry.type === 'move' && entry.kind === 'refreeze');
    const historyRefreeze = item.history.findLast(entry => entry.kind === 'refreeze');
    assert.equal(item.status, 'claimed');
    assert.equal(threadRefreeze.detail.retainedClaim, true, 'the native thread keeps the retained-claim detail object');
    assert.equal(historyRefreeze.retainedClaim, true, 'shared history projection exposes the retained-claim flag');
    assert.equal(state.moveCounts['claimed>claimed:refreeze'], 1);
    assert.equal(state.moveCounts['claimed>open:refreeze'] ?? 0, 0);
    const href = new URL(view.link.href);
    href.hash = `items/${id}`;
    chrome = await openSnapshotChrome(executable, href.href, profile);
    await chrome.waitFor(`data?.project?.items?.some(item => item.id === ${id})`);
    for (const [width, mobile] of [[1440, false], [375, true]]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile });
      await press(chrome, `document.querySelector('[data-tab="items"]')`);
      await chrome.waitFor(`!document.querySelector('[data-pane="items"]').hidden`);
      const row = `document.querySelector('#detail .tl li[data-event-id="${threadRefreeze.eventId}"]')`;
      await chrome.waitFor(`${row} !== null`);
      const rendered = JSON.parse(await chrome.stable(`(() => { const row = ${row}; return JSON.stringify({
        claimed: row.classList.contains('tl-claimed'),
        open: row.classList.contains('tl-open'),
        text: row.textContent,
        eventId: row.getAttribute('data-event-id'),
        visible: (() => { const r = row.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right <= innerWidth + 1; })()
      }); })()`));
      assert.equal(rendered.eventId, String(threadRefreeze.eventId), `${width}: row is bound to the actual retained-refreeze event`);
      assert.ok(rendered.claimed, `${width}: retained refreeze is shown as claimed`);
      assert.equal(rendered.open, false, `${width}: retained refreeze is not replayed as open`);
      assert.match(rendered.text, /refreshed the frozen bar/u, `${width}: the actual refreeze event remains visible as its plain sentence`);
      assert.ok(rendered.visible, `${width}: the detail timeline row is visible in the viewport`);
    }
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
