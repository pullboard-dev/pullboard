// pullboard: browser
/** @pullboard-test-gui */
/** Real private native board and HTTP/Chrome timeline presentation journey [N26,B23]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  closeBoard,
  events,
  recordHealthFindings,
} from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import {
  machine,
  project,
  startView,
  boardOf,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
} from '../../../tests/fixtures/cockpit/harness.js';

test('clause 1: the native item timeline reads as sentences with clamped notes and working references at desktop and phone widths [N26,B23]', { timeout: 240_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'The frozen timeline journey requires real Chrome.');
  const box = machine(), demo = project(box, 'item-timeline');
  box.run(demo.repo, 'add', 'web', 'Timeline sentences', '--specs', 'G1', '--criterion', 'The real fixture module parses.', '--check', 'node --check web/timeline.js', '--wait');
  box.run(demo.repo, 'add', 'web', 'Reference target', '--specs', 'G1', '--criterion', 'The reference opens this actual item.');
  const reviewer = JSON.parse(box.run(demo.repo, 'worktree', 'web', '--model', 'Timeline reviewer fixture', '--json'));
  box.run(demo.web, 'claim', '1');
  mkdirSync(join(demo.web, 'web'), { recursive: true });
  writeFileSync(join(demo.web, 'web/timeline.js'), 'export const timelineFixture = true;\n');
  box.git(demo.web, 'add', 'web/timeline.js');
  box.git(demo.web, 'commit', '-m', 'test(web): actual timeline fixture [G1]');
  const head = box.git(demo.web, 'rev-parse', 'HEAD');
  box.run(demo.web, 'check', '1', '--yes');
  box.run(demo.web, 'check', '1', '--yes');
  const body = Array.from({ length: 12 }, (_, index) => 'Line ' + index + ': every original word remains in this long note.').join('\n')
    + `\nOpen #2 and web/timeline.js:1@${head}. Full source ${head}. At 2026-10-28T12:34:56Z ONE_CLAIM <img src=x onerror=alert(1)>.`;
  const fixtureFacts = [];
  for (const [kind, text] of [['note', body], ['measurement', 'The real module parsed twice.'], ['capture', 'The native item has an actual committed module.']]) {
    fixtureFacts.push(JSON.parse(box.run(demo.web, 'fact', '1', kind, text, '--json')).fact);
  }
  box.run(demo.web, 'submit', '1', '--no-next');
  box.git(reviewer.path, 'switch', '--detach', head);
  box.run(reviewer.path, 'next', '--verify', '1');
  box.run(reviewer.path, 'verify', '1', 'reject', '--reason', 'BEHAVIOR_MISMATCH', '--clause', 'The real fixture module parses.', '--note', 'Exercise the actual sent-back timeline sentence.', '--no-next');
  box.run(demo.web, 'claim', '1');
  writeFileSync(join(demo.web, 'web/timeline.js'), 'export const timelineFixture = true;\n// Corrected after the real review.\n');
  box.git(demo.web, 'add', 'web/timeline.js');
  box.git(demo.web, 'commit', '-m', 'test(web): correct real timeline source after review [G1]');
  const correctedHead = box.git(demo.web, 'rev-parse', 'HEAD');
  box.run(demo.web, 'submit', '1', '--no-next');
  // @pullboard-board-file journey: record native health transitions in the private SQLite file read by this HTTP/Chrome journey.
  const board = openBoard(join(demo.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const finding = { key: 'timeline-fixture-observation', cause: 'NO_REVIEWER', item: 1, subject: '#1',
      title: 'is awaiting the fixture review', since: new Date().toISOString(), why: 'The fixture has submitted its real source.', next: 'Review the submitted item.' };
    recordHealthFindings(board, { agentId: 'coordinator', observedRevision: events(board).at(-1).event_id, findings: [finding] });
    recordHealthFindings(board, { agentId: 'coordinator', observedRevision: events(board).at(-1).event_id, findings: [] });
  } finally { closeBoard(board); }
  box.git(reviewer.path, 'switch', '--detach', correctedHead);
  box.run(reviewer.path, 'next', '--verify', '1');
  box.run(reviewer.path, 'verify', '1', 'accept', '--note', 'The real fixture module parses.', '--no-next');
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-item-timeline-'));
  let chrome;
  try {
    const state = await boardOf(view, demo.repo), item = state.items.find(row => row.id === 1);
    assert.ok(item.thread.some(row => row.type === 'fact' && row.kind === 'measurement'));
    // The history leaves out verifier review-comparison receipts and usage records (landed in 7772461bba), so they are not visible facts.
    const apiFacts = item.thread.filter(row => row.type === 'fact' && !['usage', 'shared-usage'].includes(row.kind) && !String(row.text ?? '').startsWith('Review comparison: '));
    const fixtureFactEvents = fixtureFacts.map(fact => item.thread.find(row => row.type === 'fact' && row.id === fact.id));
    assert.deepEqual(fixtureFactEvents.map(fact => fact?.kind), ['note', 'measurement', 'capture'], 'each fixture fact remains in the native item thread');
    /** Map the native fact kind to the timeline's supported visible tint category. */
    const timelineKind = kind => ['note', 'measurement', 'fact', 'proof'].includes(kind) ? kind : 'fact';
    assert.ok(item.thread.some(row => row.kind === 'health-resolved'));
    const proofs = item.thread.filter(row => row.kind === 'proof-run');
    assert.ok(proofs.length >= 2, 'the pair comes from actual native checks');
    const href = new URL(view.link.href); href.pathname = '/items/1';
    chrome = await openSnapshotChrome(executable, href.href, profile);
    await chrome.waitFor('view.item === 1 && !!document.querySelector("#detail .tl .tl-body")');
    await press(chrome, "document.querySelector('#detail [data-item-panel-tab=history]')");
    await chrome.waitFor("!document.querySelector('#detail [data-item-panel-panel=history]').hidden");
    for (const [width, mobile] of [[1440, false], [375, true]]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile });
      const result = await chrome.stable(`(() => {
        const rows = [...document.querySelectorAll('#detail .tl > li')], note = rows.find(row => row.dataset.timelineKind === 'note');
        const text = note.querySelector('.tl-body'), rect = text.getBoundingClientRect(), style = getComputedStyle(text);
        return { sentences: rows.map(row => { const sentence = row.querySelector('.tl-sentence').cloneNode(true); for (const kind of sentence.querySelectorAll('.tl-kind,.tl-kind-type')) kind.remove(); return sentence.textContent.trim(); }),
          body: (() => { const copy = text.cloneNode(true); for (const ref of copy.querySelectorAll('[data-code]')) ref.replaceWith(ref.dataset.code); for (const hash of copy.querySelectorAll('code.sha')) hash.replaceWith(hash.title); for (const time of copy.querySelectorAll('time[datetime]')) time.replaceWith(time.getAttribute('datetime')); return copy.textContent; })(), clamp: style.webkitLineClamp, height: rect.height, lineHeight: parseFloat(style.lineHeight),
          models: [...document.querySelectorAll('#detail .tl-who[title]')].map(row => ({ text: row.textContent, title: row.title })),
          factEvents: rows.filter(row => row.classList.contains('tl-fact')).map(row => [row.dataset.eventId, row.dataset.timelineKind]),
          kindTints: ['note', 'measurement', 'fact', 'proof'].map(kind => getComputedStyle(document.querySelector('#detail .tl-kind-' + kind)).color),
          rail: getComputedStyle(rows[0], '::after').backgroundColor,
          proofRows: rows.filter(row => row.textContent.includes('ran the proof')).map(row => row.dataset.eventIds.split(' ')),
          refs: [...note.querySelectorAll('[data-code]')].map(row => row.dataset.code),
          hashes: [...note.querySelectorAll('code.sha')].map(row => ({ text: row.textContent, title: row.title })),
          unsafe: note.querySelector('img,script') !== null,
          overflow: rows.some(row => row.getBoundingClientRect().right > innerWidth + 1),
          times: rows.every(row => row.querySelector('.tl-heading > time').textContent.length > 0) };
      })()`);
      assert.equal(result.body, body, width + ': all original note words remain in the DOM');
      assert.equal(result.clamp, '3');
      assert.ok(result.height <= result.lineHeight * 3 + 1, width + ': clamped geometry ' + JSON.stringify(result));
      assert.deepEqual(result.factEvents, apiFacts.toReversed().map(fact => [String(fact.eventId), timelineKind(fact.kind)]), `${width}: every native fact appears once in newest-first order`);
      assert.deepEqual(result.factEvents.filter(([eventId]) => fixtureFactEvents.some(fact => String(fact.eventId) === eventId)),
        fixtureFactEvents.toReversed().map(fact => [String(fact.eventId), timelineKind(fact.kind)]), `${width}: the three fixture facts retain their own identities and visible categories`);
      assert.deepEqual({ distinctKinds: new Set(result.kindTints).size, railVisible: !['transparent', 'rgba(0, 0, 0, 0)'].includes(result.rail) },
        { distinctKinds: 4, railVisible: true }, width + ': each kind has its own tint and the timeline rail is visible');
      // Each native check now records its own measurement between proof runs, so the runs are not consecutive and stay separate rows (grouping of consecutive runs is covered in view-pure.test.js).
      assert.ok(result.proofRows.length >= 2 && result.proofRows.every(ids => ids.length >= 1 && ids.every(id => /^\d+$/.test(id))), JSON.stringify(result) + ': each actual native check keeps its own proof row and event identity');
      for (const sentence of ['web-1 claimed it', 'web-1 recorded a measurement', 'Sentinels found this item failing', 'Sentinels found this item passing again', reviewer.agent + ' started reviewing', reviewer.agent + ' passed it', reviewer.agent + ' sent it back']) assert.ok(result.sentences.includes(sentence), `${width}: ${sentence}`);
      assert.ok(result.models.some(row => row.text === 'web-1' && row.title === 'Fixture Model'));
      assert.ok(result.models.every(row => !row.text.includes('(')));
      assert.ok(result.refs.includes('web/timeline.js:1@' + head));
      assert.deepEqual(result.hashes, [{ text: head.slice(0, 12), title: head }]);
      assert.equal(result.unsafe, false); assert.equal(result.overflow, false); assert.equal(result.times, true);
      if (await chrome.stable("!document.querySelector('#detail .item-panel-history-list').classList.contains('expanded')")) {
        await press(chrome, "document.querySelector('#detail [data-item-panel-history]')");
        await chrome.waitFor("document.querySelector('#detail .item-panel-history-list').classList.contains('expanded')");
      }
      await press(chrome, "document.querySelector('#detail [data-timeline-more]')");
      assert.equal(await chrome.stable("document.querySelector('#detail .tl-note').classList.contains('expanded')"), true);
      assert.equal(await chrome.stable("document.querySelector('#detail [data-timeline-more]').textContent"), 'Show less');
      await press(chrome, "document.querySelector('#detail [data-timeline-more]')");
      assert.equal(await chrome.stable("document.querySelector('#detail .tl-note').classList.contains('expanded')"), false);
    }
    if (await chrome.stable("!document.querySelector('#detail .item-panel-history-list').classList.contains('expanded')")) {
      await press(chrome, "document.querySelector('#detail [data-item-panel-history]')");
      await chrome.waitFor("document.querySelector('#detail .item-panel-history-list').classList.contains('expanded')");
    }
    const noteRow = "[...document.querySelectorAll('#detail .item-panel-history-list.expanded .tl > li[data-timeline-kind=note]')].find(row => !row.closest('[hidden]') && row.getBoundingClientRect().width > 0 && row.getBoundingClientRect().height > 0 && row.querySelector('.tl-body')?.textContent.includes('Line 0: every original word remains in this long note.'))";
    await press(chrome, noteRow + "?.querySelector('[data-timeline-more]')");
    const sourceRef = JSON.stringify('web/timeline.js:1@' + head);
    await press(chrome, noteRow + "?.querySelector('.tl-body [data-code=" + sourceRef + "]')");
    const notePreview = noteRow + "?.querySelector('.code-ref.open .code-wrap')";
    const previewError = noteRow + "?.querySelector('.code-ref.open .code.no')";
    await chrome.waitFor("(" + notePreview + "?.textContent.includes('timelineFixture') && " + notePreview + "?.getBoundingClientRect().height > 0) || !!" + previewError);
    const errorText = await chrome.stable(previewError + "?.textContent || ''");
    assert.equal(errorText, '', 'the selected note opens its actual referenced source preview: ' + errorText);
    assert.ok(await chrome.stable(notePreview + "?.getBoundingClientRect().height > 0"), 'the selected note shows its actual referenced source preview');
    await press(chrome, "document.querySelector('#detail .tl [data-go=\"item:2\"]')");
    await chrome.waitFor("view.item === 2 && document.querySelector('#detail h2')?.textContent.includes('Reference target')");
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop(); rmSync(profile, { recursive: true, force: true });
  }
});
