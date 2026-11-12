/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** Approved Roadmap and Activity mockup styles in seeded real Chrome [N26]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { logEvent } from '../../../../../packages/store/index.js';
import {
  fileFixtureItem,
  withFixtureBoard,
} from '../../../../cli/tests/fixtures/testkit.js';
import {
  machine,
  project,
  build,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
} from '../../../../cli/tests/fixtures/cockpit/harness.js';

test('Roadmap and Activity match the approved mockup styles [N26]', { timeout: 120_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'real Chrome is required');
  const box = machine(), alpha = project(box, 'mockup-parity');
  fileFixtureItem(box, alpha.repo, { lane: 'web', title: 'Ready item', args: ['--specs', 'G1'], criterion: 'Ready.', check: null });
  fileFixtureItem(box, alpha.repo, { lane: 'web', title: 'Review item', args: ['--specs', 'G1'], criterion: 'Review.', check: null });
  build(box, alpha, 2, 'review.txt');
  box.run(alpha.repo, 'milestone', 'add', '0.9.4', '--items', '1,2', '--reason', 'mockup parity fixture');
  box.run(alpha.web, 'shout', 'coordinator', 'Question about #1', '--kind', 'question');
  const view = await startView(box);
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, join(box.dir, 'mockup-parity-chrome'));
    await chrome.waitFor('!!data?.project');
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await press(chrome, 'document.querySelector("[data-tab=roadmap]")');
    await chrome.waitFor('document.querySelectorAll(".milestone-item .stage-word").length >= 2');
    const r = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const css = e => getComputedStyle(e), card = document.querySelector('.roadmap-has-summary') || document.querySelector('.milestone');
      const word = label => [...card.querySelectorAll('.milestone-item .stage-word')].find(e => e.textContent === label);
      const ready = word('Ready'), review = word('In review');
      const bar = card.querySelector('.roadmap-summary-bar')?.getBoundingClientRect(), legend = card.querySelector('.roadmap-summary-legend')?.getBoundingClientRect();
      const heading = [...document.querySelectorAll('.roadmap-panel h2, .roadmap-panel .roadmap-last-shipped > span')].map(e => ({ font: css(e).fontFamily, transform: css(e).textTransform }));
      const track = document.querySelector('.roadmap-release-progress');
      const row = ready.closest('.milestone-item').getBoundingClientRect();
      const box = e => e?.getBoundingClientRect(), head = box(card.querySelector('.release-header')), name = box(card.querySelector('.release-name')), rate = box(card.querySelector('.roadmap-forecast'));
      const tops = [...card.querySelectorAll('.roadmap-summary-legend > *')].map(e => Math.round(box(e).top));
      const rows = [...card.querySelectorAll('.milestone-item')].map(e => ({ text: e.innerText, detail: !!e.querySelector('.stage-detail'), words: [...e.querySelectorAll('.stage-word, .roadmap-stage-chip')].map(w => w.textContent.trim()) }));
      const header = { order: name && rate && bar && legend && name.bottom <= rate.top + 2 && rate.bottom <= bar.top && bar.bottom <= legend.top, fullWidth: Math.abs(bar.width - head.width) <= 2, legendLines: new Set(tops).size, rows };
      return { header, sans: css(document.body).fontFamily, ready: { font: css(ready).fontFamily, bg: css(ready).backgroundColor, color: css(ready).color },
        review: { font: css(review).fontFamily, bg: css(review).backgroundColor, color: css(review).color },
        bar, legend, heading, track: css(track).backgroundColor, trackWidth: track.getBoundingClientRect().width,
        rowHeight: row.height, lineHeight: parseFloat(css(ready).lineHeight) };
    })())`));
    assert.ok(r.header.order, 'the release header reads title, rate line, stage bar, then legend');
    assert.ok(r.header.fullWidth, 'the stage bar spans the full card width');
    assert.equal(r.header.legendLines, 1, 'the legend is one line under the bar');
    for (const row of r.header.rows) {
      assert.equal(row.detail, false, 'a Roadmap row carries no stage detail text');
      assert.doesNotMatch(row.text, /route|verifying|awaiting|\bby \w+-\d|merged/i, 'a Roadmap row names no route or holder: ' + row.text);
      assert.ok(row.words.every(word => ['Building', 'Ready', 'In review', 'Sent back', 'Held', 'Landed', 'Gated', 'Verified', 'Landing'].includes(word)), 'row chips use stage words: ' + row.words);
    }
    assert.equal(r.ready.font, r.sans, 'row chips are plain sans'); assert.equal(r.review.font, r.sans);
    assert.notEqual(r.ready.bg, r.review.bg, 'Ready and In review take different stage hues');
    if (r.bar && r.legend) assert.ok(r.legend.top >= r.bar.bottom && Math.abs(r.legend.left - r.bar.left) < 2, 'legend sits in one row under the full-width bar');
    assert.ok(r.heading.length >= 3 && r.heading.every(h => h.transform === 'uppercase' && h.font !== r.sans), 'the Releases, Shipping and Last shipped headings use mono caps');
    assert.notEqual(r.track, 'rgba(0, 0, 0, 0)'); assert.ok(r.trackWidth > 100, 'zero progress retains the full visible track');
    assert.ok(r.rowHeight < 60, 'a Roadmap row stays on one line');
    await press(chrome, 'document.querySelector("[data-tab=activity]")');
    await chrome.waitFor('!!document.querySelector("#activity .activity-about")');
    const a = JSON.parse(await chrome.stable(`JSON.stringify((() => { const chip = document.querySelector('#activity .activity-about'), time = document.querySelector('#activity .activity-event > time'); return { chip: getComputedStyle(chip).fontFamily, time: getComputedStyle(time).fontFamily, mono: getComputedStyle(document.querySelector('.roadmap-panel h2') || document.body).fontFamily }; })())`));
    assert.equal(a.chip, r.sans, 'about chip is sans'); assert.notEqual(a.time, r.sans, 'timestamp is mono');
    assert.deepEqual(chrome.exceptions, []);
  } finally { if (chrome) await closeSnapshotChrome(chrome); await view.stop(); }
});

test('Activity rows match activity.png: faint mono times, plain seat names, one-sentence landings, tinted icons [N26]', { timeout: 120_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'real Chrome is required');
  const box = machine(), alpha = project(box, 'mockup-parity-activity');
  fileFixtureItem(box, alpha.repo, { lane: 'web', title: 'Landed item', args: ['--specs', 'G1'], criterion: 'Landed.', check: null });
  fileFixtureItem(box, alpha.repo, { lane: 'web', title: 'Building item', args: ['--specs', 'G1'], criterion: 'Building.', check: null });
  box.run(alpha.web, 'shout', 'coordinator', 'Question about #2', '--kind', 'question');
  // @pullboard-board-file journey: native lifecycle and landing events are served to the real Activity view.
  withFixtureBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'), (board) => {
    logEvent(board, 'web-1', 'claim', 2, {});
    logEvent(board, 'web-1', 'renew', 2, {});
    logEvent(board, 'web-1', 'note', 2, { note: 'a measurement' });
    logEvent(board, 'coordinator', 'merged', 1, { commit: 'a'.repeat(40) });
    logEvent(board, 'coordinator', 'main-moved', null, { sha: 'b'.repeat(40), items: [1] });
    logEvent(board, 'coordinator', 'main-moved', null, { sha: 'c'.repeat(40), items: [2] });
  });
  const view = await startView(box);
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, join(box.dir, 'mockup-parity-activity-chrome'));
    await chrome.waitFor('!!data?.project');
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await press(chrome, 'document.querySelector("[data-tab=activity]")');
    await chrome.waitFor('!!document.querySelector("#activity [data-activity-kind=main-moved]") && !!document.querySelector("#activity [data-activity-kind=renew]")');
    const a = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const css = e => getComputedStyle(e), root = getComputedStyle(document.documentElement);
      const probe = document.createElement('span'); document.body.append(probe);
      const token = name => { probe.style.color = 'var(' + name + ')'; return getComputedStyle(probe).color; };
      const tokens = { faint: token('--ink-faint'), accent: token('--accent-soft'), violet: token('--violet-soft'), warn: token('--warn-soft'), plain: token('--surface-2') };
      probe.remove();
      const time = document.querySelector('#activity .activity-event > time');
      const seat = [...document.querySelectorAll('#activity .activity-who')].find(e => e.textContent === 'web-1');
      const verb = kind => css(document.querySelector('#activity [data-activity-kind=' + kind + '] .activity-verb')).backgroundColor;
      const landing = document.querySelector('#activity [data-activity-kind=main-moved] .activity-say');
      const landed = [...document.querySelectorAll('#activity [data-activity-kind=merged] .activity-say')];
      return { sans: css(document.body).fontFamily, time: { font: css(time).fontFamily, size: css(time).fontSize, color: css(time).color },
        seat: css(seat).textDecorationLine, tokens, landing: landing.innerText.trim(), landingChip: !!landing.querySelector('a.ref[data-go="item:2"]'),
        landingTip: landing.querySelector('p')?.title ?? '', moved: document.querySelectorAll('#activity [data-activity-kind=main-moved]').length,
        landed: landed.map(say => ({ line: say.querySelector('p').innerText.trim(), title: say.querySelector('.activity-item')?.innerText.trim(), chip: !!say.querySelector('p a.ref[data-go="item:1"]'), tip: say.querySelector('p').title, text: say.innerText })), icons: { claim: verb('claim'), renew: verb('renew'), shout: verb('shout'), note: verb('note'), merged: verb('main-moved') } };
    })())`));
    assert.notEqual(a.time.font, a.sans, 'the time column is mono'); assert.equal(a.time.size, '12px', 'the time column is about 12px');
    assert.equal(a.time.color, a.tokens.faint, 'the time column uses the faint ink');
    assert.equal(a.seat, 'none', 'seat names carry no dotted underline');
    assert.equal(a.landed.length, 1, 'a landing with its main move is one row');
    assert.equal(a.landed[0].line, 'The coordinator landed #1', 'the landing row reads landed with the item chip');
    assert.ok(a.landed[0].chip, 'the landed item is a chip that opens it'); assert.equal(a.landed[0].title, 'Landed item', 'its title is on the second line');
    assert.equal(a.landed[0].tip, 'Landed at ' + 'a'.repeat(12) + ' · Main at ' + 'b'.repeat(12), 'the commit stays on hover');
    assert.doesNotMatch(a.landed[0].text, /Landed at|Main at|moved main/u, 'no bare commit or main line');
    assert.equal(a.moved, 1, 'only the main move with no landing keeps its own row');
    assert.equal(a.landing, 'The coordinator moved main to land #2', 'a lone main move reads as one sentence with its item');
    assert.ok(a.landingChip, 'the lone main move links its item'); assert.equal(a.landingTip, 'Main at ' + 'c'.repeat(12), 'the main tip stays on hover');
    assert.equal(a.icons.claim, a.tokens.accent, 'building rows sit in a green circle'); assert.equal(a.icons.renew, a.tokens.accent, 'continued building is green too');
    assert.equal(a.icons.merged, a.tokens.accent, 'a landing is green');
    assert.equal(a.icons.shout, a.tokens.violet, 'questions sit in a purple circle'); assert.equal(a.icons.note, a.tokens.plain, 'measurements stay grey');
    assert.deepEqual(chrome.exceptions, []);
  } finally { if (chrome) await closeSnapshotChrome(chrome); await view.stop(); }
});
