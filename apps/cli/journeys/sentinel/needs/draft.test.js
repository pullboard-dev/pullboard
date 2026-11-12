// pullboard: browser
/** @pullboard-test-gui */
/** Long native sentinel proposals keep every metadata label and value apart on both Needs-you surfaces [N26]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
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
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
  proofShot,
  openItemsNeeds,
} from '../../../tests/fixtures/cockpit/harness.js';

test('clause 1: sentinel draft Command, Directory and Schedule labels never overlap long values in Dashboard or Items at desktop and phone widths [N26]', { timeout: 120_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required to measure the sentinel draft card.');
  const box = machine(), alpha = project(box, 'sentinel-labels');
  const directory = ['a-long-directory-without-shortcuts', 'nested-watch-inputs-with-extra-context', 'another-long-component-to-wrap-inside-the-card', 'the-final-directory'].join('/');
  mkdirSync(join(alpha.repo, directory), { recursive: true });
  const command = 'node -e ' + JSON.stringify('process.stdout.write(' + JSON.stringify('aVeryLongUnbrokenWatchValue'.repeat(12)) + ')');
  box.run(alpha.repo, 'sentinel', 'propose', 'long-card', '--check', command, '--directory', directory, '--every', 'hourly', '--owner', 'coordinator');
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-sentinel-labels-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.root === ' + JSON.stringify(alpha.repo));
    // A fresh board opens on the first-run Dashboard (0de17112c6); set it aside so the usual Needs-you card is measured.
    await chrome.stable("(() => { keep('pb.firstrun.' + view.root, 'hidden'); render(); return true; })()");
    for (const width of [1440, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 700 });
      await chrome.waitFor('innerWidth === ' + width);
      for (const [tab, root] of [['dashboard', '#dashboard'], ['items', '#needs']]) {
        await press(chrome, 'document.querySelector("#tabs [data-tab=' + tab + ']")');
        if (tab === 'items') await openItemsNeeds(chrome);
        const selector = root + ' [data-sentinel-draft] details';
        await chrome.waitFor('!!document.querySelector(' + JSON.stringify(selector) + ')');
        const disclosure = 'document.querySelector(' + JSON.stringify(selector) + ')';
        if (!await chrome.stable(disclosure + '.open')) await press(chrome, disclosure + '.querySelector("summary")');
        await chrome.waitFor(disclosure + '.open');
        const measured = await chrome.stable(`(() => {
          const card = ${disclosure}.querySelector('.needs-detail');
          const boundary = card.getBoundingClientRect();
          const rect = box => ({ left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height });
          const fragments = element => { const range = document.createRange(); range.selectNodeContents(element); return [...range.getClientRects()].filter(box => box.width && box.height).map(rect); };
          const fields = [...card.querySelectorAll('dt')].map(label => {
            const value = label.nextElementSibling;
            return { label: label.textContent, value: value.textContent, labels: fragments(label), values: fragments(value),
              wraps: fragments(value.querySelector('code') || value).length > 1, scrolls: value.scrollWidth > value.clientWidth + 1 };
          });
          const pieces = fields.flatMap(field => [...field.labels.map(box => ({ field: field.label, type: 'label', box })), ...field.values.map(box => ({ field: field.label, type: 'value', box }))]);
          const overlaps = [];
          for (let a = 0; a < pieces.length; a++) for (let b = a + 1; b < pieces.length; b++) {
            const x = pieces[a], y = pieces[b];
            if (x.field === y.field && x.type === y.type) continue;
            if (Math.min(x.box.right, y.box.right) - Math.max(x.box.left, y.box.left) > .5
              && Math.min(x.box.bottom, y.box.bottom) - Math.max(x.box.top, y.box.top) > .5) overlaps.push([x.field, x.type, y.field, y.type]);
          }
          const outside = pieces.filter(piece => piece.box.left < boundary.left - 1 || piece.box.right > boundary.right + 1);
          return { fields, overlaps, outside, pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 };
        })()`);
        const byName = new Map(measured.fields.map(field => [field.label, field]));
        assert.equal(byName.get('Command')?.value, command, `${tab}/${width}: the complete native command remains readable`);
        assert.ok(byName.get('Directory')?.value.endsWith(directory), `${tab}/${width}: the complete native directory remains readable`);
        assert.equal(byName.get('Schedule')?.value, 'hourly');
        assert.deepEqual(measured.overlaps, [], `${tab}/${width}: no label or neighbouring value overlaps another text fragment`);
        assert.deepEqual(measured.outside, [], `${tab}/${width}: text wraps inside the card`);
        assert.equal(measured.fields.some(field => field.scrolls), false, `${tab}/${width}: no metadata value has hidden horizontal overflow`);
        assert.equal(measured.pageFits, true, `${tab}/${width}: the card does not widen the page`);
        if (width === 375) {
          assert.equal(byName.get('Command').wraps, true, 'the long command actually exercises wrapping');
          assert.equal(byName.get('Directory').wraps, true, 'the long directory actually exercises wrapping');
        }
        await proofShot(chrome, 'sentinel-draft-' + tab, width);
      }
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
