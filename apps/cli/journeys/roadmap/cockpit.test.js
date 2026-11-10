// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit roadmap checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  spawn,
  spawnSync,
} from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  generateStressBoard,
  removeStressBoard,
} from '../../tests/fixtures/cockpit/perf/generate.mjs';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';
import {
  BIN,
  tapTarget,
  SPEC,
  machine,
  project,
  build,
  sendBack,
  fetchLive,
  fetchPage,
  startView,
  target,
  accept,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
  travel,
  pressedInto,
  settled,
  roadmapRow,
  showing,
  readRoadmap,
  openRoadmapParts,
  tabBar,
  proofShot,
  pickProject,
  chooseFilter,
} from '../../tests/fixtures/cockpit/harness.js';


/** The roadmap state a failed wait saw: its tab, rows, row ids and expansion, dots and open detail (#938). */
const ROADMAP_FACTS = `JSON.stringify({ tab: typeof view === 'undefined' ? null : view.tab,
  rows: document.querySelectorAll('#roadmap .milestone-item').length,
  ids: [...document.querySelectorAll('#roadmap .milestone-item .id')].slice(0, 12).map((node) => node.textContent),
  expanded: [...document.querySelectorAll('#roadmap .milestone-item')].slice(0, 12).map((row) => row.getAttribute('aria-expanded')),
  dots: document.querySelectorAll('#roadmap .dot').length,
  detail: (document.querySelector('#detail h2')?.textContent || '').trim().slice(0, 80),
  pressed: window.__pressed ?? null, jump: window.__roadmapJump ?? null })`;

/**
 * Name the step a roadmap wait was waiting on and the roadmap state it last saw, so a timeout reads as a diagnosis
 * rather than a bare 90 s test timeout (#938).
 */
function namedRoadmapWaits(chrome) {
  const waitFor = chrome.waitFor.bind(chrome);
  chrome.waitFor = async (...args) => {
    try { return await waitFor(...args); }
    catch (error) {
      try { error.message += `; waiting for step: ${args[0]}; the roadmap showed ${await chrome.stable(ROADMAP_FACTS)}`; } catch { /* the page may be gone; the wait's own error stays */ }
      throw error;
    }
  };
  return chrome;
}

/** Open the Chrome a roadmap case drives, with its waits named (#938). */
async function openRoadmapChrome(...args) {
  return namedRoadmapWaits(await openSnapshotChrome(...args));
}

/** Expand a real roadmap row, then use its explicit link to leave for Items. */
async function openRoadmapItem(chrome, id) {
  const row = roadmapRow(id);
  if (await chrome.stable(row + ".getAttribute('aria-expanded')") !== 'true') await press(chrome, row);
  await chrome.waitFor(row + ".getAttribute('aria-expanded') === 'true'");
  await press(chrome, row + ".parentElement.querySelector('.milestone-why a[data-go]')");
}

/** Record a real trunk merge before reporting a fixture item as landed. */
function landRoadmapItem(box, p, id) {
  box.git(p.repo, 'merge', '--no-ff', '--no-edit', p.itemBranches.get(`${p.baseBranch}:${id}`));
  const commit = box.git(p.repo, 'rev-parse', 'HEAD');
  box.run(p.repo, 'merged', String(id), commit);
  return commit;
}

test('Roadmap references stay inline and rows expand before opening Items [N26,N38]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for prose-reference checks.');
  const box = machine();
  const demo = project(box, 'a-inline-prose', `${SPEC}- G3 [approved, must] Follow #1 first. | gate: review\n`, { practice: 'ways.md' });
  writeFileSync(join(demo.repo, 'ways.md'), '# Local rules\n\n## Team\n- R1 [approved, must] Review #1 first. | gate: review\n');
  box.run(demo.repo, 'add', 'web', 'Local target', '--specs', 'G1', '--criterion', 'target');
  box.run(demo.repo, 'add', 'web', 'Local title links to #1', '--specs', 'G1', '--criterion', 'title');
  build(box, demo, 2, 'title.txt');
  sendBack(box, demo, 2, 'Review #1 before accepting.');
  const other = project(box, 'beacon-prose');
  box.run(other.repo, 'add', 'web', 'Remote target', '--specs', 'G1', '--criterion', 'target');
  box.run(other.repo, 'add', 'web', 'Remote title links to #1', '--specs', 'G1', '--criterion', 'title');
  box.run(demo.repo, 'milestone', 'add', 'Choose #1', '--note', 'Review #1 next.', '--reason', 'Arrange fixture release', '--items', '2,beacon-prose#2');
  box.run(demo.repo, 'shout', 'person', 'Choose #1 before shipping.', '--decision');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-prose-references-chrome-'));
  let chrome;
  try {
    chrome = await openRoadmapChrome(executable, view.link.href, profile);
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor("document.querySelector('#chain .row[data-item=\"2\"]')");
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const contexts = [
        ['roadmap', '#roadmap .milestone h2 .ref', 'Local target'],
        ['roadmap', '#roadmap .milestone-note .ref', 'Local target'],
        ['roadmap', '#roadmap .milestone-item[data-roadmap-key="i:#2"]:not([data-board]) .t .ref', 'Local target', true],
        ['roadmap', '#roadmap .milestone-item[data-board] .t .ref', 'Remote target', true],
        ['spec', '#spec-list [data-row="spec:G3"] .ref', 'Local target'],
        ['doctrine', '#doctrine-list [data-row="doctrine:R1"] .ref', 'Local target'],
      ];
      for (const [tab, selector, target, expands] of contexts) {
        await pickProject(chrome, `document.querySelector('[data-root=${JSON.stringify(demo.repo)}]')`);
        await chrome.waitFor("data?.project?.root === view.root && !document.body.classList.contains('switching') && document.querySelector('#proj-name').textContent === 'a-inline-prose'");
        await chrome.click(`document.querySelector('[data-tab="${tab}"]')`);
        if (tab !== 'roadmap') await chrome.click(`document.querySelector('[data-rows="${tab}:all"]')`);
        const metrics = JSON.parse(await chrome.stable(`JSON.stringify((() => {
          const ref = document.querySelector(${JSON.stringify(selector)});
          const row = ref?.closest('.milestone-item');
          const style = ref && getComputedStyle(ref);
          return { present:!!ref, title:ref?.title, border:style?.borderWidth, height:ref?.getBoundingClientRect().height,
            line:style && parseFloat(style.lineHeight), nested:!!ref?.parentElement.closest('button'),
            rowHeight:row?.getBoundingClientRect().height };
        })())`));
        assert.ok(metrics.present, `${width}: ${selector} contains its inline reference`);
        assert.equal(metrics.title, target, `${width}: the reference tooltip names the target on its own board`);
        assert.equal(metrics.border, '0px', `${width}: ${selector} has no box`);
        assert.ok(Math.abs(metrics.height - metrics.line) < 1, `${width}: ${selector} keeps the text line height`);
        assert.equal(metrics.nested, false, `${width}: ${selector} never nests buttons`);
        if (metrics.rowHeight !== undefined) assert.ok(metrics.rowHeight >= tapTarget(width), `${width}: the containing Roadmap control keeps its target`);
        if (expands) {
          const ref = `document.querySelector(${JSON.stringify(selector)})`;
          const row = ref + ".closest('.milestone-item')";
          if (await chrome.stable(row + ".getAttribute('aria-expanded')") === 'true') await chrome.click(ref);
          const address = await chrome.stable('location.href');
          await chrome.click(ref);
          await chrome.waitFor(row + ".getAttribute('aria-expanded') === 'true'");
          assert.equal(await chrome.stable('location.href'), address, 'inline title text expands without leaving Roadmap');
          assert.equal(await chrome.stable('view.tab'), 'roadmap');
          await chrome.click(row + ".parentElement.querySelector('.milestone-why a[data-go]')");
          await chrome.waitFor("document.querySelector('[data-tab=items].on') && document.querySelector('#detail h2 > span')?.textContent === '#2'");
          assert.equal(await chrome.stable('view.root'), target === 'Remote target' ? other.repo : demo.repo);
          continue;
        }
        await chrome.click(`document.querySelector(${JSON.stringify(selector)})`);
        await chrome.waitFor("!document.body.classList.contains('switching') && document.querySelector('[data-tab=items].on') && document.querySelector('#detail h2 > span')?.textContent === '#1'");
        assert.ok((await chrome.stable("document.querySelector('#detail h2').textContent")).includes(target), 'the reference opens its target title');
        assert.equal(await chrome.stable('view.root'), target === 'Remote target' ? other.repo : demo.repo, 'duplicate item numbers stay bound to their own board');
      }
      await chrome.click(`document.querySelector('[data-tab="items"]')`); await chrome.click(`document.querySelector('#chain .row[data-item="2"]')`);
      // The latest verdict has its own panel, and the history row keeps its own copy (639c16dbb5); read the panel's.
      await chrome.waitFor("document.querySelector('#detail .item-panel-latest .verdict .note')");
      assert.equal(await chrome.stable("document.querySelectorAll('#detail .item-panel-latest .verdict .note .ref').length"), 1, 'verdict prose keeps its item reference');
      await chrome.click("document.querySelector('#detail .item-panel-latest .verdict .note .ref')");
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Local target')");
      await chooseFilter(chrome, 'state:active');
      const decision = "document.querySelector('#needs details[data-needs-key^=\"decision:\"]')";
      if (await chrome.stable(`${decision}.open`) !== true) await chrome.click(`${decision}.querySelector('summary')`);
      await chrome.click(`${decision}.querySelector('button[data-go^="decide:"]')`);
      assert.equal(await chrome.stable("document.querySelectorAll('#answering-q .ref').length"), 1, 'the answering question keeps its inline item reference');
      await chrome.click("document.querySelector('#answering-q .ref')");
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Local target') && document.querySelector('[data-tab=items].on')");
      await chrome.click("document.querySelector('[data-tab=roadmap]')");
      const keyboardRow = "document.querySelector('#roadmap .milestone-item[role=button]:not([data-board])')";
      if (await chrome.stable(keyboardRow + ".getAttribute('aria-expanded')") === 'true') await chrome.click(keyboardRow);
      await chrome.stable(keyboardRow + ".dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}))");
      await chrome.waitFor(keyboardRow + ".getAttribute('aria-expanded') === 'true' && view.tab === 'roadmap'");
      await openRoadmapItem(chrome, '#2');
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Local title links to #1') && document.querySelector('[data-tab=items].on')");
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('the Roadmap uses its approved stage words, opens rows, and keeps its own address [N26,N38]', { timeout: 150_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for roadmap browser checks.');
  const phaseStarted = Date.now();
  /** Preserve which real fixture phase ran before a timeout, without changing its budget. */
  const phase = name => t.diagnostic('roadmap phase ' + name + ' ' + (Date.now() - phaseStarted) + 'ms');
  phase('start');
  const box = machine();
  const alpha = project(box, 'roadmap-demo');
  const beacon = project(box, 'beacon');
  phase('projects-ready');
  const long = 'A deliberately long title that runs past the width of a phone and keeps going, far enough to be cut on a wide desktop card as well';
  const titles = ['Merged greeting page', 'Verified farewell page', 'Session timeout banner', 'Upload progress bar', 'Live search results', long, 'Withdrawn experiment'];
  for (const title of titles) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  // One item in each state: verified and merged, verified, sent back, to verify, building, open, withdrawn.
  build(box, alpha, 1, 'one.txt');
  accept(box, alpha, 1);
  const itemCommit = box.git(alpha.repo, 'rev-parse', alpha.branch);
  box.git(alpha.repo, 'merge', '--no-ff', '--no-edit', alpha.branch);
  const trunkCommit = box.git(alpha.repo, 'rev-parse', 'HEAD');
  assert.notEqual(trunkCommit, itemCommit, 'the Roadmap receipt names the trunk merge commit');
  box.run(alpha.repo, 'merged', '1', trunkCommit);
  build(box, alpha, 2, 'two.txt');
  accept(box, alpha, 2);
  build(box, alpha, 3, 'three.txt');
  sendBack(box, alpha, 3, 'the banner does not time out yet');
  build(box, alpha, 4, 'four.txt');
  box.run(alpha.web, 'claim', '5');
  box.run(alpha.repo, 'withdraw', '7', 'no longer needed');
  // Another repo's item, sent back on its own board.
  box.run(beacon.repo, 'add', 'web', 'Billing webhook retries', '--specs', 'G1', '--criterion', 'retries');
  build(box, beacon, 1, 'retry.txt');
  sendBack(box, beacon, 1, 'retry twice before failing');
  box.run(alpha.repo, 'milestone', 'add', 'Launch', '--note', 'Ships when the review lands; your call on the name.', '--reason', 'Arrange fixture release', '--items', '1,2,3,4,beacon#1');
  box.run(alpha.repo, 'milestone', 'add', 'Next', '--note', 'Queued behind Launch.', '--reason', 'Arrange fixture release', '--items', '5,6,7');
  box.run(alpha.repo, 'milestone', 'add', 'Later', '--note', 'Ideas not filed yet.');
  // What the person reads on each row: the approved stage word; rejected work is a separate mark. Rows follow the
  // backend's queue order, queued items first by position (36add4ed61, f8e8ce444a), never re-sorted by stage (b83469ff53).
  const words = [
    { id: '#3', label: 'Ready', tone: 'ready' },
    { id: '#4', label: 'In review', tone: 'in-review' },
    { id: '#2', label: 'Verified', tone: 'verified' },
    { id: 'beacon#1', label: 'Ready', tone: 'ready' },
    { id: '#1', label: 'Merged', tone: 'merged' },
    { id: '#5', label: 'Building', tone: 'building' },
    { id: '#6', label: 'Ready', tone: 'ready' },
  ];
  phase('states-ready');
  const view = await startView(box);
  phase('view-ready');
  const roadmapPath = '/roadmap-demo/roadmap';
  const roadmap = `${roadmapPath}${view.link.search}`;
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-chrome-'));
  let chrome;
  try {
    const direct = await fetchPage(view, roadmapPath);
    assert.equal(direct.status, 200, 'the view serves its page at /roadmap, behind its session cookie');
    assert.equal((await fetchLive(new URL('/roadmap', view.link))).status, 403, 'and nothing there without the secret');
    chrome = await openRoadmapChrome(executable, new URL(roadmap, view.link).href, profile);
    const consoleErrors = [];
    chrome.socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') consoleErrors.push(message.params.entry.text);
    });
    await chrome.send('Log.enable');
    await settled(chrome, `!!data?.project && ${showing('roadmap', roadmapPath)} && document.querySelectorAll('#roadmap .milestone').length === 3`);
    phase('browser-ready');
    // This story reads every release; open the later cards through their actual controls.
    await openRoadmapParts(chrome);

    let seen;
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width} && ${showing('roadmap', roadmapPath)}`);
      seen = await readRoadmap(chrome);
      phase('rows-read-' + width);
      assert.deepEqual([seen.address, seen.shown, seen.tab], [roadmapPath, ['roadmap'], 'roadmap'], `${width}: the direct address shows the Roadmap tab, and only it`);
      assert.ok(seen.document <= seen.client && seen.body <= seen.client, `${width}: no sideways scroll: ${JSON.stringify(seen)}`);
      assert.deepEqual(seen.cards.map((card) => card.name), ['Launch', 'Next', 'Later'], `${width}: a card for each milestone, in order`);
      assert.deepEqual(seen.cards.map((card) => card.note), ['Ships when the review lands; your call on the name.', 'Queued behind Launch.', 'Ideas not filed yet.'], `${width}: each card's note`);
      assert.deepEqual(seen.cards.map((card) => [card.count, card.progress, card.filled]), [['1/5 landed', [1, 5], 0.2], ['0/2 landed', [0, 2], 0], [null, null, null]], `${width}: counts and bars say how many retained items landed`);
      assert.deepEqual([seen.cards[2].empty, seen.cards[2].rows.length], ['No items yet.', 0], `${width}: an empty milestone says so with zero summary counts`);
      const rows = seen.cards.flatMap((card) => card.rows);
      assert.deepEqual(rows.map(({ id, label, tone }) => ({ id, label, tone })), words, `${width}: each roadmap row uses an approved stage word`);
      assert.deepEqual(rows.filter((row) => row.id === '#3' || row.id === 'beacon#1').map((row) => row.marks), [['Sent back'], ['Sent back']], `${width}: a rejected item keeps its mark beside its stage`);
      assert.ok(rows.every((row) => row.seen), `${width}: every stage is on screen`);
      assert.deepEqual(rows.map((row) => row.title), [titles[2], titles[3], titles[1], 'Billing webhook retries', titles[0], titles[4], titles[5]], `${width}: queued items lead in queue order, then the rest, then landed items (36add4ed61)`);
      assert.deepEqual(rows.map((row) => row.tip), rows.map((row) => row.title), `${width}: each row's tooltip is its whole title`);
      assert.ok(rows.every((row) => row.lines === 1 && row.ellipsis), `${width}: every title holds one line, set to end in an ellipsis: ${JSON.stringify(rows)}`);
      assert.ok(rows.find((row) => row.id === '#6').cut, `${width}: the long title is cut, so its ellipsis shows`);
      assert.ok(rows.every((row) => row.button), `${width}: every item opens, another repo's included`);

      const bar = await tabBar(chrome);
      phase('tabs-read-' + width);
      for (const layout of bar.layouts) {
        const place = `${width} with ${layout.on} picked`;
        assert.equal(layout.tabs.length, 8, `${place}: Dashboard and seven retained tabs`);
        for (const tab of layout.tabs) assert.ok(tab.labelLeft >= tab.left + 2 && tab.labelRight <= tab.right - 2, `${place}: ${tab.tab}'s label sits inside its highlight: ${JSON.stringify(tab)}`);
        assert.equal(new Set(layout.tabs.map(tab => Math.round(tab.top))).size, width < 480 ? 2 : 1, `${place}: phone tabs use two rows, desktop one`);
        layout.tabs.forEach((tab, n) => { if (n) assert.ok(tab.top >= layout.tabs[n - 1].bottom - 0.5 || tab.left >= layout.tabs[n - 1].right - 0.5, `${place}: ${tab.tab} starts after the tab before it ends or on the next row`); });
        assert.ok(layout.tabs[0].left >= layout.bar[0] - 0.5 && layout.tabs.at(-1).right <= layout.bar[1] + 0.5 && layout.bar[1] <= bar.client, `${place}: the tab bar fits on screen: ${JSON.stringify(layout)}`);
      }
      await proofShot(chrome, 'roadmap', width);

      // An item opens on the Items tab; Back shows the Roadmap at its address again, Forward the item.
      await openRoadmapItem(chrome, '#3');
      await pressedInto(chrome, `${showing('items', '/roadmap-demo/items/3')} && document.querySelector('#detail h2')?.innerText.includes('Session timeout banner')`);
      assert.equal(await chrome.stable('location.search'), '', `${width}: the address keeps the rest of itself, which holds no key`);
      await travel(chrome, -1);
      await settled(chrome, `${showing('roadmap', roadmapPath)} && document.querySelector('.tab.on')?.dataset.tab === 'roadmap'`);
      await travel(chrome, 1);
      await settled(chrome, `${showing('items', '/roadmap-demo/items/3')} && document.querySelector('.tab.on')?.dataset.tab === 'items' && document.querySelector('#detail h2')?.innerText.includes('Session timeout banner')`);
      await press(chrome, `document.querySelector('[data-tab="roadmap"]')`);
      await pressedInto(chrome, `${showing('roadmap', roadmapPath)} && location.search === ''`);
    }

    // Another repo's item opens on its own board, and Back and Forward move between the two boards.
    await openRoadmapItem(chrome, 'beacon#1');
    await chrome.waitFor(`document.querySelector('#proj-name').textContent === 'beacon' && ${showing('items', '/beacon/items/1')} && document.querySelector('#detail h2')?.innerText.includes('Billing webhook retries')`);
    const there = JSON.parse(await chrome.stable(`JSON.stringify((() => { const chip = document.querySelector('#detail .meta .item-stage'); return {
      id: document.querySelector('#detail h2 span').innerText, label: chip.querySelector('.stage-word').innerText, chip: getComputedStyle(chip.querySelector('.stage-word')).color + ' on ' + getComputedStyle(chip.querySelector('.stage-word')).backgroundColor,
      dot: getComputedStyle(document.querySelector('#chain [data-item="1"] .dot')).backgroundColor }; })())`));
    const crossed = seen.cards[0].rows.find((row) => row.id === 'beacon#1');
    assert.deepEqual(there, { id: '#1', label: crossed.label, chip: crossed.chip, dot: crossed.dot }, "the other repo's Items tab shows that item with the Roadmap's word and colours");
    await travel(chrome, -1);
    await settled(chrome, `document.querySelector('#proj-name').textContent === 'roadmap-demo' && ${showing('roadmap', roadmapPath)} && !!${roadmapRow('beacon#1')}`);
    await travel(chrome, 1);
    await settled(chrome, `document.querySelector('#proj-name').textContent === 'beacon' && ${showing('items', '/beacon/items/1')} && document.querySelector('#detail h2')?.innerText.includes('Billing webhook retries')`);
    await travel(chrome, -1);
    await settled(chrome, `document.querySelector('#proj-name').textContent === 'roadmap-demo' && ${showing('roadmap', roadmapPath)} && !!${roadmapRow('#1')}`);

    // Each of this board's rows opens its item on the Items tab, which gives it the same word and
    // colours, its list dot included; a withdrawn item is left out of the list while browsing.
    for (const row of seen.cards.flatMap((card) => card.rows).filter((each) => each.id.startsWith('#'))) {
      await openRoadmapItem(chrome, row.id);
      await chrome.waitFor(`${showing('items', '/roadmap-demo/items/' + row.id.slice(1))} && document.querySelector('#detail h2 span')?.innerText === ${JSON.stringify(row.id)}`);
      const here = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const chip = document.querySelector('#detail .meta .item-stage'), word = chip.querySelector('.stage-word'), dot = document.querySelector('#chain [data-item="${row.id.slice(1)}"] .dot');
        return { label: word.innerText, chip: getComputedStyle(word).color + ' on ' + getComputedStyle(word).backgroundColor, dot: dot ? getComputedStyle(dot).backgroundColor : 'not listed' };
      })())`));
      assert.deepEqual(here, { label: row.label, chip: row.chip, dot: row.label === 'Withdrawn' ? 'not listed' : row.dot }, `${row.id}: the Items detail keeps the Roadmap stage and its state dot`);
      await travel(chrome, -1);
      await settled(chrome, `${showing('roadmap', roadmapPath)} && !!${roadmapRow(row.id)}`);
    }

    // It updates live as items move, here and on the other repo's board.
    accept(box, alpha, 4);
    await chrome.waitFor(`${roadmapRow('#4')}?.querySelector('.stage-word').innerText === 'Verified' && document.querySelector('#roadmap .roadmap-left [aria-label]').getAttribute('aria-label') === '1/5 landed'`, 15_000); // budget: hang ceiling for the accepted receipt and unchanged landed count to reach the browser; no throughput claim.
    landRoadmapItem(box, alpha, 4);
    await chrome.waitFor(`${roadmapRow('#4')}?.querySelector('.stage-word').innerText === 'Merged' && document.querySelector('#roadmap .roadmap-left [aria-label]').getAttribute('aria-label') === '2/5 landed'`, 15_000); // budget: hang ceiling for the real merge receipt and landed count to reach the browser; no throughput claim.
    box.run(beacon.web, 'claim', '1');
    await chrome.waitFor(`${roadmapRow('beacon#1')}?.querySelector('.stage-word').innerText === 'Building'`, 15_000); // budget: hang ceiling for the claimed external item to refresh; no throughput claim.

    // A board with no milestones says how one starts; the address stays the Roadmap's.
    await press(chrome, `document.querySelector('[data-root=${JSON.stringify(beacon.repo)}]')`);
    await chrome.waitFor(`document.querySelector('#proj-name').textContent === 'beacon' && ${showing('roadmap', '/beacon/roadmap')} && document.querySelector('#roadmap').innerText.startsWith('No milestones yet.')`);
    await press(chrome, `document.querySelector('[data-root=${JSON.stringify(alpha.repo)}]')`);
    await chrome.waitFor(`document.querySelector('#proj-name').textContent === 'roadmap-demo' && !!${roadmapRow('#1')}`);

    // A reload keeps the explicit Roadmap address. A fresh board address opens Dashboard.
    await chrome.send('Page.reload');
    await settled(chrome, `!!data?.project && ${showing('roadmap', roadmapPath)} && !!${roadmapRow('#1')}`);
    await press(chrome, `document.querySelector('[data-tab="shouts"]')`);
    await chrome.waitFor(showing('shouts', '/roadmap-demo/shouts'));
    await press(chrome, `document.querySelector('[data-tab="roadmap"]')`);
    await chrome.waitFor(showing('roadmap', roadmapPath));
    await chrome.send('Page.navigate', { url: view.link.href });
    await settled(chrome, `!!data?.project && ${showing('dashboard', '/roadmap-demo/dashboard')} && document.querySelector('.tab.on')?.dataset.tab === 'dashboard'`);
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught page exceptions');
    assert.deepEqual(consoleErrors, [], 'Chrome reports no console errors');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a milestone lists work to ship first, shipped below, and no withdrawn items [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for shipping-order checks.');
  const box = machine();
  const alpha = project(box, 'shipping-rows');
  for (const title of ['First verified', 'First open', 'Second verified', 'Dropped idea', 'Second open']) {
    box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  }
  for (const id of [1, 3]) { build(box, alpha, id, `page-${id}.html`); accept(box, alpha, id); landRoadmapItem(box, alpha, id); }
  box.run(alpha.repo, 'withdraw', '4', 'not needed');
  // Placing an item in an open release takes it out of the other open ones (2a3a0f7555), so Shipped ships before Next
  // takes the same items; a shipped release keeps its history.
  box.run(alpha.repo, 'milestone', 'add', 'Shipped', '--reason', 'Arrange fixture release', '--items', '1,4,3');
  box.run(alpha.repo, 'milestone', 'ship', 'Shipped');
  box.run(alpha.repo, 'milestone', 'add', 'Next', '--reason', 'Arrange fixture release', '--items', '3,2,4,1,5');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-shipping-rows-chrome-'));
  let chrome;
  /** Read the actual row order and every visible-count consumer, including folded history. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const next = document.querySelector('#roadmap-list > [data-key="m:Next"]');
    const progress = next.querySelector('.roadmap-summary-bar');
    const shipped = document.querySelector('#roadmap .shipped-one[data-key="m:Shipped"]');
    return {
      rows: [...next.querySelectorAll(':scope > .milestone-body > ul .milestone-item .id')].map(id => id.textContent),
      count: next.querySelector('.roadmap-left [aria-label]').getAttribute('aria-label'),
      progress: [progress.querySelector('[data-summary-segment=landed]').dataset.count, progress.dataset.total],
      index: document.querySelector('#roadmap-panel [data-roadmap-jump="m:Next"] b').textContent,
      status: document.querySelector('[data-status=release]').textContent.replace(/\\s+/g, ' ').trim(),
      // Desktop and phone each render the shipping counts; only the panel shown at this width counts (cead5a98d7).
      openCounts: [...document.querySelectorAll('[data-shipping-stage=waiting] dd')].filter(count => count.getClientRects().length > 0).map(count => count.textContent),
      headerWaiting: next.querySelector('[data-summary-state=waiting] b').textContent,
      shippedCount: shipped.querySelector('.milestone-count').textContent,
      shippedRows: [...shipped.querySelectorAll(':scope > .milestone-body > ul .milestone-item .id')].map(id => id.textContent),
      allIds: [...document.querySelectorAll('#roadmap .milestone-item .id')].map(id => id.textContent),
    };
  })())`));
  try {
    chrome = await openRoadmapChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.milestones?.length === 2');
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor("!document.querySelector('[data-pane=roadmap]').hidden && document.querySelector('#roadmap-list > [data-key=\"m:Next\"]')");
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      const seen = await read();
      // Queued work leads in queue order, then other work, then landed items in landing order (36add4ed61, f8e8ce444a).
      assert.deepEqual(seen.rows, ['#2', '#5', '#1', '#3'], `${width}: work to ship leads, and landed items follow in landing order`);
      assert.equal(seen.count, '2/4 landed', `${width}: withdrawn work is absent from the card count`);
      assert.deepEqual(seen.progress, ['2', '4'], `${width}: progress counts only retained items`);
      assert.equal(seen.index, '2/4', `${width}: the release index uses the same count`);
      assert.equal(seen.status, 'Next 2/4', `${width}: the status bar names the same next release and count`);
      assert.deepEqual(seen.openCounts, ['2'], `${width}: the companion panel reads the supplied waiting count`);
      assert.equal(seen.headerWaiting, '2', `${width}: the header includes both waiting items`);
      assert.equal(seen.shippedCount, '2 items', `${width}: folded history excludes withdrawn work from its total`);
      assert.equal(seen.allIds.includes('#4'), false, `${width}: no withdrawn row is rendered, including folded history`);
      await press(chrome, "document.querySelector('#roadmap-list > [data-key=shipped] > .milestone-head')");
      await press(chrome, "document.querySelector('#roadmap .shipped-one[data-key=\"m:Shipped\"] > .milestone-head')");
      await chrome.waitFor("document.querySelector('#roadmap .shipped-one[data-key=\"m:Shipped\"] > .milestone-head').getAttribute('aria-expanded') === 'true'");
      assert.deepEqual((await read()).shippedRows, ['#1', '#3'], `${width}: verified history remains available below the work to ship`);
      await press(chrome, "document.querySelector('#roadmap .shipped-one[data-key=\"m:Shipped\"] > .milestone-head')");
      await press(chrome, "document.querySelector('#roadmap-list > [data-key=shipped] > .milestone-head')");
    }
    assert.deepEqual(chrome.exceptions, [], 'the shipping roadmap raises no uncaught page exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('the roadmap leads with the next release and folds shipped ones [N26]', { timeout: 150_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for roadmap browser checks.');
  const box = machine();
  const alpha = project(box, 'releases');
  for (const title of ['First page', 'Second page', 'Third page', 'Fourth page', 'Fifth page', 'Dropped idea']) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  for (const id of [1, 2, 4]) { build(box, alpha, id, `page-${id}.html`); accept(box, alpha, id); landRoadmapItem(box, alpha, id); }
  box.run(alpha.repo, 'withdraw', '6', 'not needed');
  // In the board's order: two releases shipped (one with a withdrawn item, which does not hold it back), the next one
  // part done, and one queued after it.
  box.run(alpha.repo, 'milestone', 'add', '0.1', '--note', 'The first page.', '--reason', 'Arrange fixture release', '--items', '1');
  box.run(alpha.repo, 'milestone', 'add', '0.2', '--note', 'Shipped on Tuesday.\nA second line the shipped row leaves out.', '--reason', 'Arrange fixture release', '--items', '2,6');
  box.run(alpha.repo, 'milestone', 'add', '0.3', '--note', 'Next out.', '--reason', 'Arrange fixture release', '--items', '3,4');
  box.run(alpha.repo, 'milestone', 'add', '0.4', '--note', 'Queued behind 0.3.', '--reason', 'Arrange fixture release', '--items', '5');
  box.run(alpha.repo, 'milestone', 'add', 'Later', '--note', 'Work not filed yet.');
  box.run(alpha.repo, 'milestone', 'move', 'Later', '--before', '0.1');
  box.run(alpha.repo, 'milestone', 'ship', '0.1', '--next', '0.3');
  box.run(alpha.repo, 'milestone', 'ship', '0.2', '--next', '0.3', '--as', 'person', '--reason', 'Arrange fixture release'); // a second ship is the person's past the coordinator-actions ratchet
  const shippedCommit = box.git(alpha.repo, 'rev-parse', 'HEAD');
  const other = project(box, 'other-releases');
  box.run(other.repo, 'add', 'web', 'Other next page', '--specs', 'G1', '--criterion', 'renders');
  box.run(other.repo, 'milestone', 'add', '0.3', '--reason', 'Arrange fixture release', '--items', '1');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-releases-chrome-'));
  let chrome;
  /** The Roadmap as it reads: each part in order, open or closed, with what its summary says. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    /** Read header columns without the decorative caret. */
    // A release with work left opens from the shared release header (0ab202b994): read its name and landed count, not
    // its time-dependent forecast, which apps/cli/journeys/release/header.test.js checks.
    const words = (e) => [...(e.querySelector(':scope > .release-header-top')?.children ?? e.children)].filter((c) => !c.classList.contains('caret') && !c.matches('.roadmap-shipped-commit, .roadmap-forecast')).map((c) => c.matches('.roadmap-left') ? c.querySelector('[aria-label]').getAttribute('aria-label') : c.textContent.replace(/\\s+/g, ' ').trim()).join(' | ');
    /** Measure the rendered header target. */
    const box = (e) => { const r = e.getBoundingClientRect(); return { width: r.width, height: r.height }; };
    /** Find the direct disclosure control. */
    const head = (part) => part.querySelector(':scope > .milestone-head, :scope > .release-header > .milestone-head');
    /** Find the direct disclosure contents. */
    const body = (part) => part.querySelector(':scope > .milestone-body');
    /** Read the accessible expanded state. */
    const open = (part) => head(part)?.getAttribute('aria-expanded') === 'true';
    /** Read only visible item rows from an expanded release. */
    const rows = (part) => open(part) ? [...body(part).querySelectorAll(':scope > ul .milestone-item')].filter((row) => row.getBoundingClientRect().height > 0).map((row) => row.querySelector('.id').textContent) : [];
    return {
      statusRelease: document.querySelector('[data-status=release]')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
      page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
      parts: [...document.querySelectorAll('#roadmap-list > [data-key]')].map((d) => ({ key: d.dataset.key, open: open(d), summary: words(head(d)), height: box(head(d)).height,
        rows: rows(d), empty: body(d).querySelector('.milestone-empty')?.textContent ?? null, note: body(d).querySelector('.milestone-note')?.textContent ?? null,
        shipped: [...body(d).querySelectorAll(':scope > .shipped-one[data-key]')].map((one) => ({ key: one.dataset.key, open: open(one), summary: words(head(one)), height: box(head(one)).height,
          rows: rows(one), commit: one.querySelector('.roadmap-shipped-commit')?.title, copySeparate: !!one.querySelector('.hash-copy') && !one.querySelector('.hash-copy').closest('[role="button"]') })) })),
    };
  })())`));
  /** Activate a disclosure or item through the shared native pointer helper. */
  const click = (selector) => press(chrome, `document.querySelector(${JSON.stringify(selector)})`);
  try {
    chrome = await openRoadmapChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && data?.project?.milestones?.length === 5");
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor("!document.querySelector('[data-pane=roadmap]').hidden && document.querySelectorAll('#roadmap-list > [data-key]').length > 0");
    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.stable("delete document.documentElement.dataset.theme");
        await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
        const at = `${width}px ${scheme}`;
        const r = await read();
        assert.equal(r.statusRelease, '0.3 1/2', at + ': the status bar names the same next release');
        assert.ok(r.page.scroll <= r.page.width && r.page.body <= r.page.width, `${at}: no sideways scroll`);
        // Every release with work ahead stays open; the shipped ones fold into one part at the end.
        assert.deepEqual(r.parts.map((part) => [part.key, part.open, part.summary]), [
          ['m:0.3', true, '0.3 | 1/2 landed'],
          ['m:0.4', true, '0.4 | 0/1 landed'],
          ['m:Later', true, 'Later'],
          ['shipped', false, 'Shipped | 2 releases'],
        ], `${at}: every upcoming milestone opens in order, with Shipped folded last`);
        assert.deepEqual(r.parts[0].rows, ['#3', '#4'], `${at}: the next release shows its items`);
        assert.deepEqual([r.parts[2].empty, r.parts[2].note], ['No items yet.', 'Work not filed yet.'], `${at}: the open empty milestone shows its note and empty state`);
        assert.ok(r.parts.every((part) => part.height >= 44), `${at}: each part opens from a 44px target`);
        await click('#roadmap-list > [data-key="shipped"] > .milestone-head');
        const expanded = await read();
        const history = expanded.parts.find((part) => part.key === 'shipped');
        assert.deepEqual(history.shipped.map((one) => [one.key, one.open, one.summary]), [
          ['m:0.2', false, '0.2 | Shipped on Tuesday. | 1 item'],
          ['m:0.1', false, '0.1 | The first page. | 1 item'],
        ], at + ': shipped names, first note line and counts in reverse roadmap order');
        assert.ok(history.shipped.every((one) => one.commit === shippedCommit && one.copySeparate), at + ': each shipment displays its real commit with a copy control outside the disclosure');
        assert.ok(history.shipped.every((one) => one.height >= 44), at + ': shipped targets are at least 44px');
        assert.ok(expanded.page.scroll <= expanded.page.width && expanded.page.body <= expanded.page.width, at + ': expanded history has no sideways scroll');
        await click('#roadmap .shipped-one[data-key="m:0.2"] > .milestone-head');
        assert.deepEqual((await read()).parts.find((part) => part.key === 'shipped').shipped[0].rows, ['#2'], at + ': verified items remain readable and withdrawn work is absent');
        await proofShot(chrome, 'releases', width);
        await click('#roadmap .shipped-one[data-key="m:0.2"] > .milestone-head');
        await click('#roadmap-list > [data-key="shipped"] > .milestone-head');
      }
    }

    // Opened, Shipped lists the releases newest first: each its name, its note's first line and its item count; one
    // opens to its items as before.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 1280');
    await press(chrome, "document.querySelector('[data-status=release]')");
    assert.deepEqual((await read()).parts.map(part => part.key), ['m:0.3'], 'the status-bar release link opens only the same next release');
    await press(chrome, "document.querySelector('[data-roadmap-all]')");
    assert.deepEqual((await read()).parts.map(part => part.key), ['m:0.3', 'm:0.4', 'm:Later', 'shipped'], 'show all restores upcoming and shipped history');
    await click('#roadmap-list > [data-key="shipped"] > .milestone-head');
    let r = await read();
    const shipped = r.parts.find((part) => part.key === 'shipped');
    assert.deepEqual(shipped.shipped.map((one) => [one.key, one.open, one.summary]), [
      ['m:0.2', false, '0.2 | Shipped on Tuesday. | 1 item'],
      ['m:0.1', false, '0.1 | The first page. | 1 item'],
    ], 'newest first, each one line, closed');
    assert.ok(shipped.shipped.every((one) => one.height >= 44), 'each a 44px target');
    await click('#roadmap .shipped-one[data-key="m:0.2"] > .milestone-head');
    r = await read();
    assert.deepEqual(r.parts.find((part) => part.key === 'shipped').shipped.find((one) => one.key === 'm:0.2').rows, ['#2'], 'a shipped release opens to its verified items');
    await click('#roadmap .shipped-one[data-key="m:0.2"] .milestone-item');
    await click('#roadmap .shipped-one[data-key="m:0.2"] .milestone-why a[data-go="item:2"]');
    await chrome.waitFor("view.tab === 'items' && document.querySelector('#detail h2')?.textContent.includes('Second page')");

    // The parts stay as the person left them when the board redraws: close the next release, then change the board.
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor("!document.querySelector('[data-pane=roadmap]').hidden");
    await click('#roadmap-list > [data-key="m:0.3"] > .release-header > .milestone-head'); // the shared release header holds the head (0ab202b994)
    box.run(alpha.web, 'claim', '3');
    await chrome.waitFor("data.project.items.find((i) => i.id === 3)?.status === 'claimed'", 15_000); // budget: hang ceiling for the native claim to reach the open roadmap; no throughput claim.
    r = await read();
    assert.deepEqual(r.parts.map((part) => [part.key, part.open]), [['m:0.3', false], ['m:0.4', true], ['m:Later', true], ['shipped', true]], 'a redraw keeps each part as it was left');
    await pickProject(chrome, `[...document.querySelectorAll('[data-root]')].find((e) => e.dataset.root === ${JSON.stringify(other.repo)})`);
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    assert.deepEqual((await read()).parts.map((part) => [part.key, part.open]), [['m:0.3', true]], 'another board starts with its own next release open');
    await pickProject(chrome, `[...document.querySelectorAll('[data-root]')].find((e) => e.dataset.root === ${JSON.stringify(alpha.repo)})`);
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    assert.deepEqual((await read()).parts.map((part) => [part.key, part.open]), [['m:0.3', false], ['m:0.4', true], ['m:Later', true], ['shipped', true]], 'returning to the board preserves this visit\'s disclosure choices');
    await chrome.send('Page.reload');
    await settled(chrome, "typeof data === 'object' && data?.project?.milestones?.length === 5 && !document.querySelector('[data-pane=roadmap]').hidden");
    assert.deepEqual((await read()).parts.map((part) => [part.key, part.open]), [['m:0.3', true], ['m:0.4', true], ['m:Later', true], ['shipped', false]], 'a new visit opens every upcoming milestone and folds Shipped again');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('the roadmap keeps every upcoming release open [N26]', {
  timeout: 90_000, //budget: real Chrome startup, two viewport layouts, and reload; test assertions bound each state.
}, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for roadmap disclosure checks.');
  const box = machine();
  const alpha = project(box, 'all-upcoming-open');
  for (const title of ['Shipped one', 'Shipped two', 'Next release', 'Later release']) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  for (const id of [1, 2]) { build(box, alpha, id, `page-${id}.html`); accept(box, alpha, id); landRoadmapItem(box, alpha, id); }
  box.run(alpha.repo, 'milestone', 'add', '0.1', '--reason', 'Arrange fixture release', '--items', '1');
  box.run(alpha.repo, 'milestone', 'add', '0.2', '--reason', 'Arrange fixture release', '--items', '2');
  box.run(alpha.repo, 'milestone', 'add', '0.3', '--note', 'Next out.', '--reason', 'Arrange fixture release', '--items', '3');
  box.run(alpha.repo, 'milestone', 'add', '0.4', '--note', 'Queued next.', '--reason', 'Arrange fixture release', '--items', '4');
  box.run(alpha.repo, 'milestone', 'add', 'Later', '--note', 'No work filed yet.');
  box.run(alpha.repo, 'milestone', 'ship', '0.1', '--next', '0.3');
  box.run(alpha.repo, 'milestone', 'ship', '0.2', '--next', '0.3', '--as', 'person', '--reason', 'Arrange fixture release'); // a second ship is the person's past the coordinator-actions ratchet
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-all-upcoming-open-chrome-'));
  let chrome;
  /** Read default disclosures, their visible content, status label, and viewport overflow. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const parts=[...document.querySelectorAll('#roadmap-list > [data-key]')];
    // A release with work left opens from the shared release header (0ab202b994).
    const readPart=part=>{const head=part.querySelector(':scope > .milestone-head, :scope > .release-header > .milestone-head'),body=part.querySelector(':scope > .milestone-body');
      const rows=[...body.querySelectorAll(':scope > ul .milestone-item')];
      return {key:part.dataset.key,open:head.getAttribute('aria-expanded')==='true',rows:rows.map(row=>row.querySelector('.id').textContent),visibleRows:rows.filter(row=>row.getBoundingClientRect().height>0).length,
        empty:body.querySelector('.milestone-empty')?.textContent??null,note:body.querySelector('.milestone-note')?.textContent??null,
        shipped:[...body.querySelectorAll(':scope > .shipped-one')].map(readPart)};};
    return {parts:parts.map(readPart),status:document.querySelector('[data-status=release]')?.textContent.replace(/\\s+/g,' ').trim()??null,
      viewport:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,body:document.body.scrollWidth};
  })())`));
  try {
    chrome = await openRoadmapChrome(executable, view.link.href, profile);
    await chrome.waitFor("data?.project?.milestones?.length === 5");
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: width === 375 ? 812 : 800, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      const initial = await read();
      assert.deepEqual(initial.parts.map(({ key, open }) => [key, open]), [['m:0.3', true], ['m:0.4', true], ['m:Later', true], ['shipped', false]], `${width}: every upcoming release opens while Shipped stays folded`);
      assert.deepEqual(initial.parts.slice(0, 2).map((part) => [part.rows, part.visibleRows]), [[['#3'], 1], [['#4'], 1]], `${width}: both upcoming item lists are visible`);
      assert.deepEqual([initial.parts[2].empty, initial.parts[2].note], ['No items yet.', 'No work filed yet.'], `${width}: the empty upcoming release shows its note`);
      assert.equal(initial.parts[3].shipped.length, 2, `${width}: both shipped releases are present`);
      assert.equal(initial.parts[3].shipped.every((part) => !part.open && part.visibleRows === 0), true, `${width}: both shipped releases remain folded`);
      assert.equal(initial.status, '0.3 0/1', `${width}: the status bar still names the next release`);
      assert.ok(initial.scroll <= initial.viewport && initial.body <= initial.viewport, `${width}: no sideways scrolling`);
      await proofShot(chrome, 'roadmap-upcoming-open', width);
      if (width === 375) {
        await press(chrome, "document.querySelector('[data-roadmap-key=\"m:0.4\"]')");
        await chrome.waitFor("document.querySelector('[data-roadmap-key=\"m:0.4\"]').getAttribute('aria-expanded') === 'false'");
        assert.equal((await read()).parts[1].open, false, 'the person can fold an upcoming release for this visit');
        await chrome.send('Page.reload');
        await settled(chrome, "data?.project?.milestones?.length === 5 && !document.querySelector('[data-pane=roadmap]').hidden");
        assert.deepEqual((await read()).parts.map(({ key, open }) => [key, open]), [['m:0.3', true], ['m:0.4', true], ['m:Later', true], ['shipped', false]], 'the next visit reopens upcoming releases and folds Shipped');
      }
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

/** Record target identity, geometry and native events without changing the Roadmap's input path. */
async function watchRoadmapPress(chrome, key) {
  await chrome.stable(`(() => {
    const selector = '#roadmap-panel [data-roadmap-jump=' + CSS.escape(${JSON.stringify(key)}) + ']';
    let original = document.querySelector(selector);
    const originalRender = window.render;
    const nodeIds = new WeakMap(); let nextNodeId = 0;
    const nodeId = node => { if (!node) return null; if (!nodeIds.has(node)) nodeIds.set(node, ++nextNodeId); return nodeIds.get(node); };
    const trace = window.__roadmapPress = { original, originalRender, samples:[], events:[] };
    /** Keep bounded observations of the live target and its original node. */
    const record = phase => {
      const current = document.querySelector(selector), box = current?.getBoundingClientRect();
      const panel = document.querySelector('#roadmap-panel'), list = document.querySelector('#roadmap-list');
      trace.samples.push({ phase, at:performance.now(), connected:original.isConnected, same:current === original,
        box:box ? [box.x,box.y,box.width,box.height] : null, scroll:[scrollX,scrollY],
        panelId:nodeId(panel), panelCount:panel?.querySelectorAll('[data-roadmap-jump]').length,
        listId:nodeId(list), listCount:list?.querySelectorAll(':scope > [data-key]').length,
        panelScroll:panel?.scrollTop, count:current?.querySelector('b')?.textContent, deferred:deferredClickRender });
      if (trace.samples.length > 8) trace.samples.shift();
    };
    trace.record = record;
    window.render = function(...args) { record('before render'); const result = originalRender.apply(this,args); record('after render'); return result; };
    trace.listeners = ['pointermove','pointerdown','pointerup','click'].map(type => {
      const listener = event => {
        const button = event.target.closest?.('[data-roadmap-jump]');
        if (type === 'pointerdown' && button?.dataset.roadmapJump === ${JSON.stringify(key)}) { original = button; trace.original = button; }
        record(type); trace.events.push({ type, key:button?.dataset.roadmapJump || null });
        if(trace.events.length > 8) trace.events.shift();
      };
      document.addEventListener(type, listener, true); return [type,listener];
    });
    record('watch');
  })()`);
  return {
    /** Read only bounded samples and event keys, never retain DOM objects in the host. */
    async snapshot() {
      return JSON.parse(await chrome.stable(`JSON.stringify((() => { const t=window.__roadmapPress; t.record('snapshot'); return {samples:t.samples,events:t.events}; })())`));
    },
    /** Restore the actual renderer and remove only this observer's event listeners. */
    async dispose() {
      await chrome.stable(`(() => { const t=window.__roadmapPress; if(!t)return; window.render=t.originalRender; for(const [type,listener] of t.listeners)document.removeEventListener(type,listener,true); delete window.__roadmapPress; })()`);
    },
  };
}

test('the roadmap panel jumps to each release [N26]', {
  timeout: 150_000, //budget: hang ceiling for real Chrome startup, fourteen jumps at two widths, and panel scrolling.
}, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for Roadmap panel navigation.');
  const box = machine();
  const alpha = project(box, 'roadmap-panel-jumps');
  for (const title of ['Shipped release item', 'Next release item']) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  build(box, alpha, 1, 'shipped.html');
  accept(box, alpha, 1);
  const shippedBranch = alpha.itemBranches.get(`${alpha.baseBranch}:1`);
  box.git(alpha.repo, 'merge', '--no-ff', '--no-edit', shippedBranch);
  box.run(alpha.repo, 'merged', '1', box.git(alpha.repo, 'rev-parse', 'HEAD'));
  box.run(alpha.repo, 'milestone', 'add', '0.8.6', '--note', 'Shipped first line.\nThis line stays in the expanded history.', '--reason', 'Arrange fixture release', '--items', '1');
  box.run(alpha.repo, 'milestone', 'add', '0.8.7', '--note', 'The next release.', '--reason', 'Arrange fixture release', '--items', '2');
  box.run(alpha.repo, 'milestone', 'ship', '0.8.6', '--next', '0.8.7');
  for (const name of ['0.8.8', '0.8.9', '0.8.10', '0.8.11', '0.8.12', '0.8.13', '0.8.14', '0.8.15', '0.8.16', '0.8.17', '0.8.18', '0.8.19']) {
    box.run(alpha.repo, 'milestone', 'add', name, '--note', 'Queued after the next release.');
  }
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-panel-jumps-'));
  let chrome;
  /** Read panel selection, list targets, and page overflow after the shared Chrome wait. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const panel = document.querySelector('#roadmap-panel'), list = document.querySelector('#roadmap-list');
    const buttons = [...panel.querySelectorAll('[data-roadmap-jump]')];
    const targets = [...list.querySelectorAll(':scope > [data-key]')];
    const rect = element => { const r = element.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:r.height}; };
    const bar = document.querySelector('.top').getBoundingClientRect();
    return {buttons:buttons.map(b=>({key:b.dataset.roadmapJump,name:b.querySelector('span').textContent,count:b.querySelector('b').textContent,current:b.getAttribute('aria-current'),height:rect(b).height})),
      targets:targets.map(e=>({key:e.dataset.key,rect:rect(e),arrival:e.classList.contains('roadmap-arrival'),expanded:e.querySelector(':scope > .milestone-head')?.getAttribute('aria-expanded')})),
      panel:rect(panel),bar:{top:bar.top,bottom:bar.bottom},strip:rect(panel.querySelector('.roadmap-releases')),
      stripWidth:panel.querySelector('.roadmap-releases').scrollWidth,stripClient:panel.querySelector('.roadmap-releases').clientWidth,
      viewport:document.documentElement.clientWidth,scrollY:window.scrollY,pageWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)};
  })())`));
  try {
    chrome = await openRoadmapChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.milestones?.length === 14');
    // The panel's breakpoint is below 900px, not at it: at 900 the panel stays on the right, sticky, with its own
    // Shipping; at 899 it is the chip row above the list, and the counts sit under the next release.
    for (const scheme of ['light', 'dark']) {
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await chrome.waitFor(`document.documentElement.dataset.scheme === '${scheme}'`);
      for (const width of [900, 899]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.waitFor(`innerWidth === ${width}`);
        await press(chrome, "document.querySelector('[data-tab=roadmap]')");
        const edge = JSON.parse(await chrome.stable(`JSON.stringify((() => {
          const panel = document.querySelector('#roadmap-panel'), list = document.querySelector('#roadmap-list');
          const shown = (e) => !!e && e.getClientRects().length > 0 && e.getBoundingClientRect().height > 0;
          return { position: getComputedStyle(panel).position, beside: panel.getBoundingClientRect().left >= list.getBoundingClientRect().right,
            chips: getComputedStyle(document.querySelector('#roadmap-releases')).display, desk: shown(panel.querySelector('.roadmap-desktop-shipping')), phone: shown(list.querySelector('.roadmap-summary')),
            page: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) };
        })())`));
        const at = `${width}/${scheme}`;
        if (width === 900) assert.deepEqual([edge.position, edge.beside, edge.desk, edge.phone], ['sticky', true, true, true], `${at}: the panel stays on the right alongside each release summary: ${JSON.stringify(edge)}`);
        else assert.deepEqual([edge.position, edge.beside, edge.chips, edge.desk, edge.phone], ['static', false, 'flex', false, true], `${at}: the chip row above the list, summary under each release: ${JSON.stringify(edge)}`);
        assert.ok(edge.page <= width, `${at}: no sideways scroll: ${JSON.stringify(edge)}`);
      }
    }
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      await press(chrome, "document.querySelector('[data-tab=roadmap]')");
      const initial = await read();
      if (width >= 900) {
        assert.ok(initial.buttons.every((button) => button.height >= tapTarget(width)), 'wide fine-pointer release jumps meet the 32px target');
        // Touch is turned off again below, and the wait is for the pointer the page started with, as demo.test.js
        // does: a Chrome with no mouse, as on Linux CI, starts at none, not fine (#453).
        const originalPointer = JSON.parse(await chrome.stable(`JSON.stringify({ fine:matchMedia('(pointer: fine)').matches, coarse:matchMedia('(pointer: coarse)').matches, none:matchMedia('(pointer: none)').matches })`));
        await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await chrome.waitFor("matchMedia('(pointer: coarse)').matches");
        const coarse = await read();
        assert.ok(coarse.buttons.every((button) => button.height >= 44), 'wide coarse-pointer release jumps meet the 44px target');
        await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await chrome.waitFor(`matchMedia('(pointer: fine)').matches === ${originalPointer.fine} && matchMedia('(pointer: coarse)').matches === ${originalPointer.coarse} && matchMedia('(pointer: none)').matches === ${originalPointer.none}`);
      }
      const keys = ['m:0.8.7', 'm:0.8.8', 'm:0.8.9', 'm:0.8.10', 'm:0.8.11', 'm:0.8.12', 'm:0.8.13', 'm:0.8.14', 'm:0.8.15', 'm:0.8.16', 'm:0.8.17', 'm:0.8.18', 'm:0.8.19', 'shipped'];
      assert.deepEqual(initial.buttons.map((button) => button.key), keys, `${width}: each upcoming release in order and one Shipped jump`);
      assert.deepEqual(initial.buttons.map(({ name, count }) => [name, count]), [['0.8.7', '0/1'], ...keys.slice(1, -1).map((key) => [key.slice(2), '0/0']), ['Shipped', '1']], `${width}: release names and done counts are visible`);
      assert.ok(initial.buttons.every((button) => button.height >= tapTarget(width)), `${width}: every release jump meets the target size`);
      assert.ok(initial.pageWidth <= initial.viewport, `${width}: the page never scrolls sideways`);
      if (width < 900) {
        assert.ok(initial.stripWidth > initial.stripClient, 'phone release chips scroll inside their own row');
        assert.ok(initial.panel.bottom <= initial.targets[0].rect.top, 'the phone panel sits above the release list');
        // A board refresh redraws the Roadmap; the chips stay where the person scrolled them.
        const kept = JSON.parse(await chrome.stable("(() => { const row = document.querySelector('#roadmap-releases'); row.scrollLeft = row.scrollWidth; const before = row.scrollLeft; render(); return JSON.stringify([before, document.querySelector('#roadmap-releases').scrollLeft]); })()"));
        assert.ok(kept[0] > 0 && kept[1] === kept[0], `375: a redraw keeps the chips where they were scrolled: ${JSON.stringify(kept)}`);
        await chrome.stable("(() => { document.querySelector('#roadmap-releases').scrollLeft = 0; return true; })()");
      }
      await proofShot(chrome, 'roadmap-panel-jumps', width);
      // The page marks a release it jumps to for a moment, then clears the mark. Record each mark as it is set,
      // so a busy machine that reads late still sees it (a fixed window is the #400 class of red). The list is redrawn
      // when the board refreshes, so the watch is on the document.
      await chrome.stable("(() => { window.__arrivals = []; if (!window.__arrivalWatch) { window.__arrivalWatch = new MutationObserver((changes) => { for (const change of changes) if (change.target.classList?.contains('roadmap-arrival') && change.target.closest('#roadmap-list')) window.__arrivals.push(change.target.dataset.key); }); window.__arrivalWatch.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] }); } return true; })()");
      for (const key of keys.slice(0, -1)) {
        await press(chrome, `document.querySelector('#roadmap-panel [data-roadmap-jump="${key}"]')`);
        const moved = await read();
        const target = moved.targets.find((entry) => entry.key === key);
        const marked = JSON.parse(await chrome.stable('JSON.stringify(window.__arrivals)')).includes(key);
        assert.ok(marked && target.rect.bottom > moved.bar.bottom && target.rect.top < 900, `${width}: selecting ${key} scrolls it into view and marks it: ${JSON.stringify({ ...target, marked })}`);
        const atTop = moved.targets.find((entry) => entry.rect.bottom > moved.bar.bottom + 8)?.key || moved.targets.at(-1).key;
        assert.equal(moved.buttons.find((button) => button.key === atTop).current, 'location', `${width}: the panel marks the release actually at the top of the list`);
      }
      await press(chrome, "document.querySelector('#roadmap-panel [data-roadmap-jump=shipped]')");
      assert.equal((await read()).targets.at(-1).expanded, 'true', `${width}: selecting Shipped opens it`);
      const beforeListScroll = await read();
      await chrome.stable("document.querySelector('#roadmap-list [data-key=\"m:0.8.12\"]').scrollIntoView({block:'start',behavior:'instant'})");
      const scrolled = await read();
      const atTop = scrolled.targets.find((entry) => entry.rect.bottom > scrolled.bar.bottom + 8)?.key || scrolled.targets.at(-1).key;
      assert.notEqual(scrolled.scrollY, beforeListScroll.scrollY, `${width}: scrolling to a middle release moves the list`);
      assert.notEqual(scrolled.buttons.find((button) => button.current === 'location')?.key, beforeListScroll.buttons.find((button) => button.current === 'location')?.key, `${width}: scrolling changes the active release`);
      assert.equal(scrolled.buttons.find((button) => button.key === atTop).current, 'location', `${width}: scrolling the list updates the marker for the release actually at the top`);
      assert.ok(scrolled.pageWidth <= scrolled.viewport, `${width}: navigation keeps the page within its width`);
      if (width >= 900) assert.ok(scrolled.panel.top >= scrolled.bar.bottom + 8 && scrolled.panel.top <= scrolled.bar.bottom + 24, `desktop panel stays beside the list while scrolling: ${JSON.stringify(scrolled.panel)}`);
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('a refresh between pointer down and up preserves a roadmap release click [N26,C7]', {
  timeout: 90_000, // budget: hang ceiling for real board setup, Chrome and two pointer-held board refreshes.
}, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the Roadmap refresh control.');
  const box = machine(), demo = project(box, 'roadmap-refresh-press');
  for (const name of ['0.8.7','0.8.8','0.8.9','0.8.10','0.8.11','0.8.12','0.8.13','0.8.14']) {
    box.run(demo.repo, 'milestone', 'add', name, '--note', 'Release navigation control.');
  }
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-refresh-press-'));
  let chrome, trace;
  try {
    chrome = await openRoadmapChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.milestones?.length === 8');
    for (const width of [375,1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height:900, deviceScaleFactor:1, mobile:false });
      await press(chrome, "document.querySelector('[data-tab=roadmap]')");
      const key = 'm:0.8.7';
      trace = await watchRoadmapPress(chrome, key);
      const message = `roadmap refresh while pointer held ${width}`;
      let held;
      await press(chrome, `document.querySelector('#roadmap-panel [data-roadmap-jump="${key}"]')`, {
        afterMouseDown: async () => {
          box.run(demo.repo, 'shout', 'person', message);
          await chrome.waitFor(`data.project.shouts.some(shout => shout.shout_text === ${JSON.stringify(message)})`);
          held = await trace.snapshot();
          t.diagnostic(`${width}: held refresh: ${JSON.stringify(held)}`);
        },
      });
      await chrome.waitFor(`!deferredClickRender && data.project.shouts.some(shout => shout.shout_text === ${JSON.stringify(message)})`);
      const released = await trace.snapshot();
      t.diagnostic(`${width}: released: ${JSON.stringify(released)}`);
      assert.ok(held.samples.some(sample => sample.phase === 'after render'), `${width}: the real board refresh attempted a render while held`);
      assert.ok(held.samples.at(-1).connected && held.samples.at(-1).same, `${width}: the pressed button survives the refresh`);
      assert.ok(held.samples.at(-1).deferred, `${width}: the render waits until the pointer release`);
      assert.ok(released.events.some(event => event.type === 'click' && event.key === key), `${width}: the release produces the intended native click`);
      const reached = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const target=document.querySelector('#roadmap-list [data-key="${key}"]'), r=target.getBoundingClientRect();
        return {top:r.top,bottom:r.bottom,bar:document.querySelector('.top').getBoundingClientRect().bottom,
          current:document.querySelector('#roadmap-panel [data-roadmap-jump="${key}"]').getAttribute('aria-current')};
      })())`));
      assert.ok(reached.bottom > reached.bar && reached.top < 900, `${width}: the selected release is visible: ${JSON.stringify(reached)}`);
      assert.equal(reached.current, 'location', `${width}: the panel marks the selected release`);
      await trace.dispose(); trace = null;
    }
  } finally {
    try { if (trace) await trace.dispose(); }
    finally {
      try { if(chrome) await closeSnapshotChrome(chrome); }
      finally { try { await view.stop(); } finally { rmSync(profile,{recursive:true,force:true}); } }
    }
  }
});

test('the roadmap chips keep their scroll through a redraw with wide fonts [N26]', async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the Roadmap chip row.');
  const box = machine();
  const alpha = project(box, 'roadmap-chips-wide');
  box.run(alpha.repo, 'add', 'web', 'Next release item', '--specs', 'G1', '--criterion', 'renders');
  box.run(alpha.repo, 'milestone', 'add', '0.8.7', '--note', 'The next release.', '--reason', 'Arrange fixture release', '--items', '1');
  for (const name of ['0.8.8', '0.8.9', '0.8.10', '0.8.11', '0.8.12', '0.8.13', '0.8.14', '0.8.15', '0.8.16', '0.8.17', '0.8.18', '0.8.19']) {
    box.run(alpha.repo, 'milestone', 'add', name, '--note', 'Queued after the next release.');
  }
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-chips-wide-'));
  let chrome;
  /** The chips' release names by their text's own width, measured from the glyphs, not the boxes. */
  const labels = async () => JSON.parse(await chrome.stable("JSON.stringify([...document.querySelectorAll('#roadmap-releases .roadmap-release > span')].map((e) => { const r = document.createRange(); r.selectNodeContents(e); return [e.textContent, r.getBoundingClientRect().width]; }))"));
  const widths = (list) => JSON.stringify(list.map(([name, width]) => [name, Math.round(width * 100) / 100]));
  try {
    chrome = await openRoadmapChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.milestones?.length === 13');
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 375');
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor("document.querySelector('#roadmap-releases [aria-current=location]')");
    const before = await labels();
    // The current release's chip is bold, so it is wider than when it is not marked, by an amount that depends on
    // the face: 2px on macOS, 4px on Linux CI (#452). A letter-spacing in em widens every label by the same share of its
    // face on every runner, as the toolbar's test does (#445); the forced face, where a machine has it, adds a wider bold.
    for (const face of ['', 'font-family: Verdana, "DejaVu Sans", "Bitstream Vera Sans", sans-serif !important; ']) {
      const at = `375/${face ? 'forced face' : 'own face'}`;
      await chrome.stable(`(() => { const sheet = document.styleSheets[0]; sheet.insertRule('.roadmap-release, .roadmap-release * { ${face}letter-spacing: .12em !important; }', sheet.cssRules.length); return true; })()`);
      const after = await labels();
      assert.deepEqual(after.map(([name]) => name), before.map(([name]) => name), `${at}: the same chips, widened`);
      assert.ok(after.every(([, width], i) => width >= before[i][1] * 1.1), `${at}: every chip's name is at least 10% wider: ${widths(before)} to ${widths(after)}`);
      // A board refresh redraws the Roadmap with the chips scrolled to their end, where a shorter row would clamp them.
      const kept = JSON.parse(await chrome.stable("(() => { const row = document.querySelector('#roadmap-releases'); row.scrollLeft = row.scrollWidth; const before = [row.scrollLeft, row.querySelector('[aria-current]')?.dataset.roadmapJump]; render(); const now = document.querySelector('#roadmap-releases'); return JSON.stringify([before, [now.scrollLeft, now.querySelector('[aria-current]')?.dataset.roadmapJump]]); })()"));
      assert.ok(kept[0][0] > 0 && kept[1][0] === kept[0][0], `${at}: a redraw keeps the chips exactly where they were scrolled: ${JSON.stringify(kept)}`);
      assert.equal(kept[1][1], kept[0][1], `${at}: the redraw keeps the same chip marked`);
      await chrome.stable("(() => { const sheet = document.styleSheets[0]; sheet.deleteRule(sheet.cssRules.length - 1); document.querySelector('#roadmap-releases').scrollLeft = 0; return true; })()");
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('the roadmap shows landed, accepted and past target [N26]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable(); assert.ok(executable, 'Chrome is required for the roadmap header check.');
  const box=machine(), alpha=project(box,'roadmap-truth',SPEC,{lanes:{web:{owns:['web/'],specs:['G']},ops:{owns:['ops/'],specs:['G']}}});
  const names=['Landed A','Accepted A','Waiting A','Shipped B','Landed C','Accepted C','In review C','Building C','Approve the release','Held C','Withdrawn C','Landed D','Withdrawn D'];
  names.forEach((name,index)=>box.run(alpha.repo,'add',index===9?'ops':'web',name,'--specs','G1','--criterion','The page renders.'));
  /** Land through real Git and the ordinary board receipt; acceptance alone stays unlanded. */
  function land(id) {
    box.git(alpha.repo,'merge','--no-ff','--no-edit',alpha.itemBranches.get(`${alpha.baseBranch}:${id}`));
    box.run(alpha.repo,'merged',String(id),box.git(alpha.repo,'rev-parse','HEAD'));
  }
  for(const id of [1,2,4,5,6]) {build(box,alpha,id,`item-${id}.txt`);accept(box,alpha,id);if([1,4,5].includes(id))land(id);}
  box.run(alpha.repo,'withdraw','11','Removed from this release');
  // A release that finished, every item landed or withdrawn, without milestone ship.
  build(box,alpha,12,'item-12.txt');accept(box,alpha,12);land(12);box.run(alpha.repo,'withdraw','13','Not needed after all');
  box.run(alpha.repo,'milestone','add','Finished unshipped','--reason', 'Arrange fixture release', '--items','12,13');
  box.run(alpha.repo,'milestone','add','Empty plan','--note','Nothing filed yet.');
  build(box,alpha,7,'item-7.txt');box.run(alpha.web,'claim','8');box.run(alpha.repo,'hold','ops','--reason','Waiting for the person');
  box.run(alpha.repo,'shout','person','#9 Approve the release','--decision');
  box.run(alpha.repo,'milestone','add','Past target','--reason', 'Arrange fixture release', '--items','1,2,3');
  box.run(alpha.repo,'milestone','edit','Past target','--target',new Date(Date.now()-86_400_000).toISOString());
  box.run(alpha.repo,'milestone','add','Shipped release','--reason', 'Arrange fixture release', '--items','4');
  // Deliberately shuffle the six states; display grouping must not inherit this order.
  box.run(alpha.repo,'milestone','add','State summary','--reason', 'Arrange fixture release', '--items','10,5,9,8,7,6,11');
  box.run(alpha.repo,'milestone','ship','Shipped release','--next','State summary');
  box.run(alpha.repo,'milestone','add','Empty shipped');
  box.run(alpha.repo,'milestone','ship','Empty shipped','--next','State summary','--as','person','--reason','Arrange fixture release');
  const shipped=box.git(alpha.repo,'rev-parse','HEAD');
  const rawRoadmap=JSON.parse(box.run(alpha.repo,'roadmap','--json'));
  assert.equal(rawRoadmap.milestones.find(m=>m.name==='State summary').total,6,'649: the milestone total leaves the withdrawn member out, like the summary');
  assert.deepEqual(rawRoadmap.milestones.find(m=>m.name==='State summary').summary,{total:6,left:5,landed:1,landing:1,review:1,building:1,waiting:1,held:1,needsYou:[9],pace:{last6h:4,last2h:4,last24h:4},estimate:{low:2.5,high:7.5},window:'6h',reason:null},'real roadmap JSON owns every header field');
  const view=await startView(box),profile=mkdtempSync(join(tmpdir(),'pullboard-roadmap-truth-'));let chrome;
  const milestone=name=>`document.querySelector('[data-key="m:${name}"]')`;
  try {
    chrome=await openRoadmapChrome(executable,view.link.href,profile);await chrome.waitFor('data?.project?.milestones?.length===6');
    const apiSummary=JSON.parse(await chrome.stable("JSON.stringify(data.project.milestones.find(m=>m.name==='State summary').summary)"));
    assert.deepEqual(apiSummary,rawRoadmap.milestones.find(m=>m.name==='State summary').summary,'the live API carries the real CLI summary unchanged');
    await press(chrome,"document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor(`${milestone('Past target')}?.querySelector('.milestone-head')`);
    const nativeForecast=JSON.parse(await chrome.stable(`JSON.stringify({rate:${milestone('State summary')}?.querySelector('.roadmap-estimate')?.textContent||'',pace:${milestone('State summary')}?.querySelector('.roadmap-pace')?.textContent||'',completion:${milestone('State summary')}?.querySelector('.roadmap-completion')?.textContent||''})`));
    assert.equal(nativeForecast.rate,'0.7 items an hour',`the native API supplies the six-hour rate: ${JSON.stringify(nativeForecast)}`);assert.equal(nativeForecast.pace,'4 landed in the last 6 h, 4 in the last 2 h',`the native API supplies both landed counts: ${JSON.stringify(nativeForecast)}`);assert.match(nativeForecast.completion,/^done in about 5 hours, [A-Za-z]+ (?:overnight|morning|afternoon|evening|night)$/u,`the native API estimate uses the browser's weekday part of day: ${JSON.stringify(nativeForecast)}`);
    // Exercise the requested 512/700 presentation independently of the live board data above.
    await chrome.stable("(()=>{const m=data.project.milestones.find(m=>m.name==='State summary');m.count=512;m.limit=700;m.summary={...m.summary,pace:{last6h:7,last2h:7},estimate:{low:71,high:212.5}};render();return true;})()");
    const truth=await chrome.stable(`${milestone('Past target')}.textContent`);
    assert.match(truth,/1 of 3 landed/u,'acceptance does not count as landed');assert.match(truth,/past target/u);
    const states=JSON.parse(await chrome.stable(`JSON.stringify([...${milestone('Past target')}.querySelectorAll('.milestone-item')].map(row=>[row.querySelector('.id').textContent,row.querySelector('.stage-word')?.textContent]))`));
    assert.deepEqual(Object.fromEntries(states),{'#1':'Merged','#2':'Verified','#3':'Ready'});
    await press(chrome,"document.querySelector('[data-key=shipped] > .milestone-head')");
    await chrome.waitFor(`${milestone('Shipped release')}?.querySelector('.milestone-head')`);
    assert.match(await chrome.stable(`${milestone('Shipped release')}.textContent`),new RegExp(shipped.slice(0,12)),'the shipped release names its actual commit');
    assert.equal(await chrome.stable(`${milestone('Empty shipped')}.closest('.shipped')!==null`),true,'an empty shipped milestone appears only under Shipped');
    assert.equal(await chrome.stable("document.querySelectorAll('[data-key=\"m:Empty shipped\"]').length"),1,'an empty shipment is not repeated among upcoming releases');
    // Finished without milestone ship: under Shipped, no summary header, never among upcoming releases; the page opens on the
    // first release with work left (Past target), and the Releases list starts with it.
    const finished=JSON.parse(await chrome.stable(`JSON.stringify({shipped:${milestone('Finished unshipped')}?.closest('.shipped')!==null,copies:document.querySelectorAll('[data-key="m:Finished unshipped"]').length,summary:Boolean(${milestone('Finished unshipped')}?.querySelector('.roadmap-summary,.roadmap-left')),zero:/0 (left|remaining)|About 0/u.test(${milestone('Finished unshipped')}?.textContent||''),releases:[...document.querySelectorAll('#roadmap-releases [data-roadmap-jump]')].map(b=>b.querySelector('span').textContent),status:document.querySelector('[data-status=release]')?.textContent.trim()||''})`));
    assert.deepEqual([finished.shipped,finished.copies,finished.summary,finished.zero],[true,1,false,false],`a finished release sits once under Shipped with no summary: ${JSON.stringify(finished)}`);
    assert.equal(finished.releases[0],'Past target','the Releases list starts with the first release with work left');
    assert.ok(!finished.releases.includes('Finished unshipped'),'a finished release is not listed as coming');
    assert.match(finished.status,/^Past target/u,'the page opens on the first release with work left');
    // An empty plan has nothing left either: no header, its No items yet reading as before the header (tests-28, 18 Oct).
    const empty=JSON.parse(await chrome.stable(`JSON.stringify({summary:Boolean(${milestone('Empty plan')}?.querySelector('.roadmap-summary,.roadmap-left')),zero:/0 (left|remaining)|0 of 0|About 0/u.test(${milestone('Empty plan')}?.textContent||''),empty:${milestone('Empty plan')}?.querySelector('.milestone-empty')?.textContent||''})`));
    assert.deepEqual(empty,{summary:false,zero:false,empty:'No items yet.'},`an empty plan shows no header: ${JSON.stringify(empty)}`);
    for(const width of [320,375,1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride',{width,height:950,deviceScaleFactor:1,mobile:false});
      for(const scheme of ['light','dark']) {
        await chrome.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:scheme}]});
        const read=JSON.parse(await chrome.stable(`JSON.stringify((()=>{const m=${milestone('State summary')},bar=m.querySelector('.roadmap-summary-bar');return {text:m.textContent,releaseCount:document.querySelector('[data-roadmap-jump=\"m:State summary\"] b').textContent,legend:[...m.querySelectorAll('[data-summary-state]')].map(x=>[x.dataset.summaryState,x.querySelector('b').textContent]),legendText:[...m.querySelectorAll('[data-summary-state]')].map(x=>x.textContent.trim()),segments:[...m.querySelectorAll('[data-summary-segment]')].map(x=>[x.dataset.summarySegment,Number(x.dataset.count),x.getBoundingClientRect().width]),bar:bar?.getBoundingClientRect().width,width:document.documentElement.scrollWidth,viewport:innerWidth};})())`));
        assert.match(read.text,/5 to go.*1 of 6 landed/u);assert.doesNotMatch(read.text,/ left|5 remaining/u,'the approved count reads to go');assert.equal(read.releaseCount,'1/6','the header and Releases list share the summary total');assert.match(read.text,/1\.2 items an hour · 7 landed in the last 6 h, 7 in the last 2 h · done in about 6 days, [A-Za-z]+ (?:overnight|morning|afternoon|evening|night)/u);assert.match(read.text,/Needs you:.*#9 Approve the release/u);
        assert.deepEqual(read.legend,[['landed','1'],['landing','1'],['review','1'],['building','1'],['waiting','1'],['held','1']]);
        // The legend's words since aaeff395a3, as roadmap-summary-card.test.js reads them.
        assert.deepEqual(read.legendText,['1 landed','1 accepted, landing','1 in review','1 building','1 waiting','1 held'],`${width}/${scheme}: every label is separated from its count by actual whitespace`);assert.equal(await chrome.stable(`${milestone('State summary')}.querySelector('.milestone-limit')?.textContent||''`),'',`${width}/${scheme}: the shared release header removes the extra total-and-limit line`);
        const legendLayout=JSON.parse(await chrome.stable(`JSON.stringify([...${milestone('State summary')}.querySelectorAll('[data-summary-state]')].map(entry=>{const nodes=[...entry.children],centers=nodes.map(node=>{const r=node.getBoundingClientRect();return r.top+r.height/2;});return {display:getComputedStyle(entry).display,align:getComputedStyle(entry).alignItems,color:getComputedStyle(entry).color,weight:getComputedStyle(nodes[1]).fontWeight,tags:nodes.map(node=>node.tagName),centers,height:entry.getBoundingClientRect().height};}))`));
        assert.ok(legendLayout.every(row=>row.display==='inline-flex'&&row.align==='center'&&Number(row.weight)>=600&&row.tags.join(',')==='I,B,SPAN'&&row.centers.every(center=>Math.abs(center-row.centers[0])<.75)),`${width}/${scheme}: every entry aligns its dot, bold count and label`);
        assert.equal(new Set(legendLayout.map(row=>row.color)).size,1,`${width}/${scheme}: the held control has the same text color as the other entries`);assert.ok(legendLayout.at(-1).height >= (width < 900 ? 44 : 32),`${width}/${scheme}: the held control keeps its ${width < 900 ? 44 : 32}px target`);
        const forecastLayout=JSON.parse(await chrome.stable(`JSON.stringify((()=>{const m=${milestone('State summary')},group=m.querySelector('.roadmap-forecast'),rate=m.querySelector('.roadmap-estimate'),pace=m.querySelector('.roadmap-pace'),completion=m.querySelector('.roadmap-completion');return {display:getComputedStyle(group).display,rate:rate.textContent,pace:pace.textContent,completion:completion.textContent,rateBold:rate.querySelectorAll('b').length,paceBold:pace.querySelectorAll('b').length};})())`));
        assert.equal(forecastLayout.display,'block',`${width}/${scheme}: the three facts stay in one flowing header line`);assert.equal(forecastLayout.rate,'1.2 items an hour');assert.equal(forecastLayout.pace,'7 landed in the last 6 h, 7 in the last 2 h');assert.match(forecastLayout.completion,/^done in about 6 days, [A-Za-z]+ (?:overnight|morning|afternoon|evening|night)$/u);assert.equal(forecastLayout.rateBold,0);assert.equal(forecastLayout.paceBold,0);
        assert.equal(read.segments.reduce((sum,row)=>sum+row[1],0),6,'the six supplied states sum to total');
        assert.ok(read.segments.every(row=>row[2]>0&&Math.abs(row[2]-read.bar/6)<1),`${width}/${scheme}: every supplied state occupies its share`);
        assert.ok(read.width<=read.viewport,`${width}/${scheme}: the header stays inside the viewport`);
        const emptyPlan=JSON.parse(await chrome.stable(`JSON.stringify({summary:Boolean(${milestone('Empty plan')}?.querySelector('.roadmap-summary,.roadmap-left')),empty:${milestone('Empty plan')}?.querySelector('.milestone-empty')?.textContent||''})`));
        assert.deepEqual(emptyPlan,{summary:false,empty:'No items yet.'},`${width}/${scheme}: an empty plan shows no header, only No items yet`);
      }
    }
    const ordered = JSON.parse(await chrome.stable(`JSON.stringify([...${milestone('State summary')}.querySelectorAll('.milestone-item .id')].map(row => row.textContent))`));
    assert.deepEqual(ordered, ['#6', '#7', '#8', '#9', '#10', '#5'], 'a milestone lists accepted, review, building, waiting, held, then landed despite shuffled membership');
    // Equal bounds read as one number, and the legend says waiting.
    await chrome.stable("(()=>{const m=data.project.milestones.find(m=>m.name==='State summary');m.summary={...m.summary,estimate:{low:2.5,high:2.5}};render();return true;})()");
    const single=await chrome.stable(`${milestone('State summary')}.querySelector('.roadmap-completion')?.textContent||''`);
    assert.match(single,/^done in about 3 hours, /u,`equal fractional bounds round to one whole hour: ${single}`);
    // A slow day reads the 24 h window, and too few landings say so in words, each beside the landed line (#853).
    const timeLine=async()=>JSON.parse(await chrome.stable(`JSON.stringify({rate:${milestone('State summary')}.querySelector('.roadmap-estimate')?.textContent||'',pace:${milestone('State summary')}.querySelector('.roadmap-pace')?.textContent||'',completion:${milestone('State summary')}.querySelector('.roadmap-completion')?.textContent||''})`));
    await chrome.stable("(()=>{const m=data.project.milestones.find(m=>m.name==='State summary');m.summary={...m.summary,estimate:{low:6,high:6},window:'24h',reason:null};render();return true;})()");
    const daily=await timeLine();
    assert.match(daily.completion,/^done in about 6 hours, /u,`the backend's six-hour completion estimate is shared on both surfaces: ${JSON.stringify(daily)}`);
    assert.match(daily.pace,/landed in the last 6 h/u,'the landed line stays beside the 24 h estimate');
    await chrome.stable("(()=>{const m=data.project.milestones.find(m=>m.name==='State summary');m.summary={...m.summary,estimate:null,window:null,reason:'few-landings'};render();return true;})()");
    const early=await timeLine();
    assert.equal(early.completion,'too few landings yet to estimate',`few landings say so instead of inventing a completion time: ${JSON.stringify(early)}`);
    assert.match(early.pace,/landed in the last 6 h/u,'the landed line stays beside the too-early words');
    await chrome.stable("(()=>{const m=data.project.milestones.find(m=>m.name==='State summary');m.summary={...m.summary,estimate:{low:2.5,high:2.5},window:'6h',reason:null};render();return true;})()");
    assert.equal(await chrome.stable(`${milestone('State summary')}.querySelector('[data-summary-state=waiting]').textContent.trim()`),'1 waiting','the legend says waiting');
    // The API owns counts: changing held item summaries cannot change the supplied milestone summary.
    await chrome.stable("window.__originalItems=data.project.items;window.__originalRoadmapItems=data.project.milestones.find(m=>m.name==='State summary').items;data.project.items=data.project.items.map(item=>({...item,status:'open',stage:'open',merged:null,claim:null}));data.project.milestones.find(m=>m.name==='State summary').items=window.__originalRoadmapItems.map(item=>({...item,status:'open',state:'open'}));render();true");
    assert.equal(await chrome.stable(`${milestone('State summary')}.querySelector('[data-summary-state=building] b').textContent`),'1');
    await chrome.stable("data.project.items=window.__originalItems;const m=data.project.milestones.find(m=>m.name==='State summary');m.items=window.__originalRoadmapItems;m.summary.estimate=null;m.summary.pace=null;m.summary.needsYou=[];render();true");
    // A hand-edited snapshot can contain malformed counts; those values must remain inert [C5].
    await chrome.stable(`(()=>{const m=data.project.milestones.find(m=>m.name==='State summary');const value='"><img src=x onerror="window.__badRoadmapCount=true">';m.summary={...m.summary,total:value,landed:value,left:value};m.total=value;m.landed=value;render();return true})()`);
    assert.equal(await chrome.stable("document.querySelectorAll('#roadmap img,[data-status=release] img').length"),0,'malformed supplied counts never become HTML');

    assert.deepEqual(chrome.exceptions,[]);
  } finally {if(chrome)await closeSnapshotChrome(chrome);rmSync(profile,{recursive:true,force:true});await view.stop();}

});

test('a blocked roadmap item shows its dot and expands to say why [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the roadmap blocker check.');
  const box = machine(), alpha = project(box, 'blocked-roadmap');
  box.run(alpha.repo, 'add', 'web', 'Base work', '--specs', 'G1', '--criterion', 'Base is ready.');
  box.run(alpha.repo, 'add', 'web', 'Waits on base', '--specs', 'G1', '--criterion', 'Use #1 and #3 <em>literally</em>. More detail stays in Items.', '--after', '1');
  box.run(alpha.repo, 'add', 'web', 'Free work', '--specs', 'G1', '--criterion', 'Ready.');
  box.run(alpha.repo, 'add', 'web', 'Sent back once', '--specs', 'G1', '--criterion', 'Ready.');
  build(box, alpha, 4, 'sent-back.html'); sendBack(box, alpha, 4, 'The heading is missing.');
  box.run(alpha.repo, 'edit', '4', '--after', '1', '--reason', 'Waits on the base.');
  box.run(alpha.repo, 'add', 'web', 'Landed work', '--specs', 'G1', '--criterion', 'The page renders.');
  build(box, alpha, 5, 'landed.html'); accept(box, alpha, 5);
  box.git(alpha.repo, 'merge', '--no-ff', '--no-edit', alpha.itemBranches.get(`${alpha.baseBranch}:5`));
  box.run(alpha.repo, 'merged', '5', box.git(alpha.repo, 'rev-parse', 'HEAD'));
  box.run(alpha.repo, 'add', 'web', 'Building work', '--specs', 'G1', '--criterion', 'The corrected page renders.');
  build(box, alpha, 6, 'building.html'); sendBack(box, alpha, 6, 'See #1 and #3 before accepting.\nMore detail stays in Items.');
  box.run(alpha.web, 'claim', '6');
  const second = join(box.dir, 'second-builder');
  box.git(alpha.repo, 'worktree', 'add', '-q', second, '-b', 'web/second');
  joinFixtureSeat(box, second, 'web'); box.run(second, 'claim', '1');
  const other = project(box, 'blocked-roadmap-other');
  box.run(other.repo, 'add', 'web', 'Remote base', '--specs', 'G1', '--criterion', 'Ready.');
  box.run(other.repo, 'add', 'web', 'Remote sent-back work', '--specs', 'G1', '--criterion', 'Remote renders.');
  build(box, other, 2, 'remote.html'); sendBack(box, other, 2, 'Remote latest finding\nMore detail stays in Items');
  box.run(other.repo, 'edit', '2', '--after', '1', '--reason', 'Waits on remote base.');
  box.run(other.repo, 'hold', 'web', '--reason', 'Review the remote dependency');
  box.run(alpha.repo, 'milestone', 'add', 'Next', '--reason', 'Arrange fixture release', '--items', '1,2,3,4,5,6,blocked-roadmap-other#2');
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-blocked-roadmap-chrome-'));
  let chrome;
  const row = id => `[...document.querySelectorAll('#roadmap .milestone-item')].find(x=>x.querySelector('.id')?.textContent===${JSON.stringify(id)})`;
  /** Read the visible detail only, after its optional first detail request settles. */
  async function opened(id) {
    await press(chrome, row(id));
    await chrome.waitFor(`${row(id)}?.getAttribute('aria-expanded')==='true' && !${row(id)}.parentElement.querySelector('.milestone-why[aria-busy]')`);
    return await chrome.stable(`${row(id)}.parentElement.querySelector('.milestone-why').textContent`);
  }
  /** Count item reads, excluding ordinary board polling. */
  async function reads() { return JSON.parse(await chrome.stable('JSON.stringify(window.__requests)')).filter(url => /\/items\/\d/.test(url)); }
  try {
    chrome = await openRoadmapChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.milestones?.length===1');
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    t.diagnostic('blocked fixture items ' + await chrome.stable("JSON.stringify(data.project.items.filter(i=>i.id<=2).map(i=>({id:i.id,status:i.status,blockedBy:i.blockedBy??null,after:i.after??null})))"));
    // Since the approved N26 Roadmap redesign (b83469ff53, #2056) a waiting row reads "after #1" beside its title.
    await chrome.waitFor(`${row('#2')}?.querySelector('.roadmap-after')`);
    assert.equal(await chrome.stable(`${row('#2')}.querySelector('.roadmap-after').textContent`), 'after #1');
    assert.equal(await chrome.stable(`${row('#2')}.querySelector('.roadmap-after a[data-go]').dataset.go`), 'item:1');
    assert.equal(await chrome.stable(`Boolean(${row('#3')}.querySelector('.roadmap-after, .block-dot'))`), false);
    await chrome.stable("window.__requests=[];window.__fetch=window.fetch;window.fetch=(url,options)=>{window.__requests.push(String(url));return window.__fetch(url,options);};true");
    const address = await chrome.stable('location.href');
    const blocked = await opened('#2');
    assert.match(blocked, /CriterionUse #1 and #3 <em>literally<\/em>\./u, 'the approved dense detail leads with the criterion');
    assert.doesNotMatch(blocked, /More detail stays in Items/u, 'only the first criterion sentence is shown');
    assert.deepEqual(JSON.parse(await chrome.stable(`JSON.stringify([...${row('#2')}.parentElement.querySelectorAll('.roadmap-criterion .roadmap-ref')].map(chip=>chip.textContent))`)), [], 'references inside Criterion stay plain text');
    assert.equal(await chrome.stable(`${row('#2')}.parentElement.querySelectorAll('.roadmap-criterion em').length`),0,'criterion markup stays escaped');
    assert.match(blocked, /Waits on#1 building.*web-2.*since/u, 'dependency includes state, holder and local time');
    assert.match(blocked, /History.*added/u); assert.match(blocked, /Release.*Next.*G1/u);
    // The other board also has an item #2, so only this board's reads count.
    const local = await chrome.stable('boardPath(view.root)');
    assert.ok((await reads()).filter(url => url.endsWith(local + '/items/2')).length <= 1, 'the first opened row reads its detail once, ahead or on expand');
    for (const id of ['#2', '#6', '#5']) {
      if (id !== '#2') await opened(id);
      const text = await chrome.stable(`${row(id)}.parentElement.querySelector('.milestone-why').textContent`);
      if (id === '#6') {
        assert.match(text, /Agents.*web-1.*building/u); assert.match(text, /Sent back.*coordinator.*See #1 and #3 before accepting/u);
        assert.match(text, /History.*claimed.*submitted.*sent back.*claimed again/u);
      }
      if (id === '#5') { assert.match(text, /Agents.*web-1.*built.*coordinator.*verified/u); assert.match(text, /History.*accepted.*landed/u); }
      const before = await reads();
      await press(chrome, row(id));
      await chrome.stable(`${row(id)}.focus();true`);
      await chrome.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13 });
      await chrome.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13 });
      await chrome.waitFor(`${row(id)}.getAttribute('aria-expanded')==='true'`);
      assert.deepEqual(await reads(), before, 'reopening keeps the shared item-detail cache');
      assert.equal(await chrome.stable('location.href'), address); assert.equal(await chrome.stable('view.tab'), 'roadmap');
      await press(chrome, row(id));
    }
    const base = await opened('#1');
    assert.match(base, /Blocks.*#2 unclaimed/u, 'the dense row names its open dependants');
    assert.match(base, /Blocks.*#4 sent back/u, 'a sent-back dependant keeps its status');
    assert.equal(await chrome.stable(`${row('#1')}.parentElement.querySelectorAll('.milestone-why a').length`), 1, 'references are chips; only the explicit Items link navigates');
    await press(chrome, row('#1'));
    for (const scheme of ['light', 'dark']) {
      await chrome.send('Emulation.setEmulatedMedia', { features:[{name:'prefers-color-scheme',value:scheme}] });
      await opened('#6');
      const style = JSON.parse(await chrome.stable(`JSON.stringify((()=>{const panel=${row('#6')}.parentElement.querySelector('.milestone-why');const label=panel.querySelector('dt'),value=label.nextElementSibling;return {icons:panel.querySelectorAll('dt svg').length, labels:panel.querySelectorAll('dt').length,top:getComputedStyle(label).alignSelf,chip:getComputedStyle(panel.querySelector('.roadmap-step.no')).backgroundColor,danger:getComputedStyle(panel.querySelector('.roadmap-return')).backgroundColor,labelTop:label.getBoundingClientRect().top,valueTop:value.getBoundingClientRect().top};})())`));
      assert.equal(style.icons, style.labels, `${scheme}: every label has an inline icon`);
      assert.equal(style.top, 'start', `${scheme}: labels stay at the first value line`);
      assert.ok(Math.abs(style.labelTop-style.valueTop)<2, `${scheme}: wrapped values keep their top-aligned label`);
      assert.notEqual(style.danger, 'rgba(0, 0, 0, 0)', `${scheme}: send-back reason is tinted`);
      const colors = JSON.parse(await chrome.stable(`JSON.stringify((()=>{const panel=${row('#6')}.parentElement.querySelector('.milestone-why');const probe=document.createElement('span');panel.append(probe);probe.style.color='var(--reject)';const danger=getComputedStyle(probe).color;probe.style.color='var(--accent)';const success=getComputedStyle(probe).color;probe.remove();return {danger,success,reject:getComputedStyle(panel.querySelector('.roadmap-step.no')).backgroundColor,reason:getComputedStyle(panel.querySelector('.roadmap-return')).color};})())`));
      assert.equal(colors.reject, colors.danger, `${scheme}: send-back history uses the danger token`);
      assert.equal(colors.reason, colors.danger, `${scheme}: the callout uses the danger token`);
      await press(chrome, row('#6'));
      await opened('#5');
      const landed = JSON.parse(await chrome.stable(`JSON.stringify((()=>{const r=${row('#5')},panel=r.parentElement.querySelector('.milestone-why');return {color:getComputedStyle(panel.querySelector('.roadmap-event:last-child .roadmap-step')).backgroundColor,stage:r.querySelector('.stage-word')?.textContent,icon:!!r.querySelector('.roadmap-landed svg')};})())`));
      assert.equal(landed.color, colors.success, `${scheme}: landing history uses the success token`);
      assert.equal(landed.stage, 'Merged'); assert.equal(landed.icon, false, 'a landed row reads Merged, with no checkmark');
      await press(chrome, row('#5'));
    }
    for (const width of [375,1280]) for (const scheme of ['light','dark']) {
      await chrome.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
      await chrome.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:scheme}]});
      for (const [id,field] of [['#2','.roadmap-criterion'],['#6','.roadmap-return']]) {
        await opened(id);
        const prose=JSON.parse(await chrome.stable(`JSON.stringify((()=>{const panel=${row(id)}.parentElement.querySelector('.milestone-why'),value=panel.querySelector(${JSON.stringify(field)});return {text:value.textContent,chips:value.querySelectorAll('.roadmap-ref').length,links:panel.querySelectorAll('a').length};})())`));
        assert.match(prose.text,/#1 and #3/u,`${width}/${scheme}: ${field} keeps its literal references`);
        assert.equal(prose.chips,0,'the clarified bar keeps prose references plain');assert.equal(prose.links,1,'only Open in Items is a link');
        assert.equal(await chrome.stable('location.href'),address);assert.equal(await chrome.stable('view.tab'),'roadmap');
        await press(chrome,row(id));
      }
    }
    await chrome.send('Emulation.setDeviceMetricsOverride', {width:375,height:900,deviceScaleFactor:1,mobile:false});
    const remote = await opened('blocked-roadmap-other#2');
    assert.match(remote, /Waits on#1 unclaimed/u); assert.match(remote, /Review the remote dependency/u);
    assert.match(remote, /Sent back.*Remote latest finding/u); assert.doesNotMatch(remote, /More detail stays in Items/u);
    const metrics = JSON.parse(await chrome.stable(`JSON.stringify((()=>{const r=${row('blocked-roadmap-other#2')},d=r.querySelector('.roadmap-after').getBoundingClientRect(),t=r.querySelector('.t').getBoundingClientRect();return {visible:d.width>0&&d.left>=t.left&&d.right<=t.right,width:document.documentElement.scrollWidth,viewport:innerWidth};})())`));
    assert.ok(metrics.visible, 'the remote blocker mark stays visible on a phone'); assert.ok(metrics.width<=metrics.viewport);
    await press(chrome, `${row('blocked-roadmap-other#2')}.parentElement.querySelector('.milestone-why a[data-go]')`);
    await chrome.waitFor("view.tab==='items' && document.querySelector('#detail h2')?.textContent.includes('Remote sent-back work')");
    assert.equal(await chrome.stable("document.querySelector('#proj-name').textContent"), 'blocked-roadmap-other');
    assert.deepEqual(chrome.exceptions, []);
  } finally { if(chrome) await closeSnapshotChrome(chrome); rmSync(profile,{recursive:true,force:true}); await view.stop(); }
});

test('the expanded row keeps send-backs short and names agents plainly [N26]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the roadmap send-back check.');
  const box = machine(), alpha = project(box, 'short-roadmap');
  const long = 'Evidence '.repeat(25).trim();
  box.run(alpha.repo, 'add', 'web', 'Several sentences', '--specs', 'G1', '--criterion', 'Ready.');
  build(box, alpha, 1, 'several.html');
  sendBack(box, alpha, 1, 'The heading is missing. The footer link is also broken.\nMore evidence stays in Items.');
  box.run(alpha.repo, 'add', 'web', 'One long sentence', '--specs', 'G1', '--criterion', 'Ready.');
  build(box, alpha, 2, 'long.html'); sendBack(box, alpha, 2, long);
  box.run(alpha.repo, 'milestone', 'add', 'Next', '--reason', 'Arrange fixture release', '--items', '1,2');
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-short-roadmap-chrome-'));
  let chrome;
  const row = id => `[...document.querySelectorAll('#roadmap .milestone-item')].find(x=>x.querySelector('.id')?.textContent===${JSON.stringify(id)})`;
  /** Expand a row, if it is not open yet, and read its detail once it has loaded. */
  async function opened(id) {
    if (await chrome.stable(`${row(id)}?.getAttribute('aria-expanded')`) !== 'true') await press(chrome, row(id));
    await chrome.waitFor(`${row(id)}?.getAttribute('aria-expanded')==='true' && !${row(id)}.parentElement.querySelector('.milestone-why[aria-busy]')`);
    return await chrome.stable(`${row(id)}.parentElement.querySelector('.milestone-why').textContent`);
  }
  try {
    chrome = await openRoadmapChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setLocaleOverride', { locale: 'en-US' });
    await chrome.send('Page.reload');
    await chrome.waitFor('data?.project?.milestones?.length===1');
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor(`Boolean(${row('#2')})`);
    const several = await opened('#1');
    const returned = await chrome.stable(`${row('#1')}.parentElement.querySelector('.roadmap-return').textContent`);
    assert.match(returned, /^\d{1,2}:\d{2}\s[AP]M by coordinator: The heading is missing\.…$/u, 'a multi-sentence send-back shows only its first sentence, then an ellipsis');
    assert.doesNotMatch(several, /footer link|More evidence/u, 'the rest of the note stays out of the row; Open in Items shows it');
    await opened('#2');
    const capped = await chrome.stable(`${row('#2')}.parentElement.querySelector('.roadmap-return').textContent`);
    assert.equal(capped.replace(/^.*?by coordinator: /u, ''), long.slice(0, 160).trimEnd() + '…', 'a sentence longer than 160 characters is cut there, with an ellipsis');
    const panel = await opened('#1');
    assert.match(panel, /Agents.*web-1 \(Fixture Model\) built/u, 'an agent with a known model keeps the model after its name');
    assert.doesNotMatch(panel, /\(unknown\)/u, 'the coordinator, whose model is unknown, is named alone with no placeholder');
    const times = JSON.parse(await chrome.stable(`JSON.stringify([...${row('#1')}.parentElement.querySelectorAll('.roadmap-history time')].map(t=>[t.getAttribute('datetime'),t.textContent]))`));
    assert.ok(times.length >= 3, 'the history lists its moves with times');
    for (const [, text] of times) assert.match(text, /^\d{1,2}:\d{2}\s[AP]M$/u, 'history times use the viewer locale, such as 7:09 PM');
    assert.equal(await chrome.stable(`[...${row('#1')}.parentElement.querySelectorAll('.roadmap-history time')].every(t=>t.textContent===new Date(t.getAttribute('datetime')).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}))`), true, 'history times match the locale formatter');
    assert.deepEqual(chrome.exceptions, []);
  } finally { if(chrome) await closeSnapshotChrome(chrome); rmSync(profile,{recursive:true,force:true}); await view.stop(); }
});

test('a release jump on a phone leaves its heading below the top bar [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for phone release-jump checks.');
  const box = machine();
  const alpha = project(box, 'roadmap-phone-release-jump');
  for (const title of ['First release item', 'Second release item']) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  box.run(alpha.repo, 'milestone', 'add', '0.9.0', '--reason', 'Arrange fixture release', '--items', '1');
  box.run(alpha.repo, 'milestone', 'add', '0.9.1', '--reason', 'Arrange fixture release', '--items', '2');
  for (const name of ['0.9.2', '0.9.3', '0.9.4', '0.9.5', '0.9.6', '0.9.7', '0.9.8', '0.9.9', '0.9.10', '0.9.11']) {
    box.run(alpha.repo, 'milestone', 'add', name, '--note', 'Later release.');
  }
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-phone-jump-'));
  let chrome;
  try {
    chrome = await openRoadmapChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.milestones?.length === 12');
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.stable(`(() => {
      window.__roadmapJump = [];
      const observer = new MutationObserver(records => {
        const target = document.querySelector('#roadmap-list [data-key="m:0.9.1"]');
        window.__roadmapJump.push({ arrival: target?.classList.contains('roadmap-arrival') ?? null,
          replaced: records.some(record => record.type === 'childList'), scrollY, pressed: window.__pressed });
        window.__roadmapJump = window.__roadmapJump.slice(-12);
      });
      observer.observe(document.querySelector('#roadmap'), { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    })()`);
    await press(chrome, `document.querySelector('#roadmap-panel [data-roadmap-jump="m:0.9.1"]')`);
    await chrome.waitFor(`document.querySelector('#roadmap-list [data-key="m:0.9.1"]')?.classList.contains('roadmap-arrival')`);
    await chrome.stable('render()');
    assert.equal(await chrome.stable(`document.querySelector('#roadmap-list [data-key="m:0.9.1"]')?.classList.contains('roadmap-arrival')`), true, 'a redraw keeps the actual release-jump mark');
    const position = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const bar = document.querySelector('.top').getBoundingClientRect();
      const target = document.querySelector('#roadmap-list [data-key="m:0.9.1"]').getBoundingClientRect();
      const heading = document.querySelector('#roadmap-list [data-key="m:0.9.1"] .milestone-head h2').getBoundingClientRect();
      const documentHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      const maxScroll = documentHeight - window.innerHeight;
      return { barTop:bar.top, barBottom:bar.bottom, barHeight:bar.height, targetTop:target.top, headingTop:heading.top,
        documentHeight, viewportHeight:window.innerHeight, scrollY:window.scrollY, maxScroll, remainingScroll:maxScroll-window.scrollY };
    })())`));
    console.log('phone release jump geometry', JSON.stringify(position));
    assert.ok(position.barHeight > 56, `the phone header must wrap beyond its desktop height: ${JSON.stringify(position)}`);
    assert.ok(position.remainingScroll > 300, `the jump is not clamped near the document bottom: ${JSON.stringify(position)}`);
    assert.ok(position.headingTop >= position.barBottom, `the entire release heading sits below the wrapped header: ${JSON.stringify(position)}`);
    assert.ok(position.scrollY > 0, `the release jump scrolls the page: ${JSON.stringify(position)}`);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 812, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 1280');
    await press(chrome, `document.querySelector('#roadmap-panel [data-roadmap-jump="m:0.9.1"]')`);
    const desktop = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const bar = document.querySelector('.top').getBoundingClientRect();
      const target = document.querySelector('#roadmap-list [data-key="m:0.9.1"]');
      const heading = target.querySelector('.milestone-head h2').getBoundingClientRect();
      return { margin:getComputedStyle(target).scrollMarginTop, barBottom:bar.bottom, headingTop:heading.top };
    })())`));
    console.log('desktop release jump geometry', JSON.stringify(desktop));
    assert.equal(desktop.margin, '72px', `desktop keeps today's scroll offset: ${JSON.stringify(desktop)}`);
    assert.ok(desktop.headingTop >= desktop.barBottom, `desktop heading stays below the top bar: ${JSON.stringify(desktop)}`);
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('the release chevron lines up with its title [N26]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the release chevron check.');
  const box = machine();
  const alpha = project(box, 'release-chevron');
  for (const title of ['Shipped work', 'Open work', 'More open work']) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  build(box, alpha, 1, 'shipped.html');
  accept(box, alpha, 1);
  box.run(alpha.repo, 'milestone', 'add', 'Old release', '--reason', 'Arrange fixture release', '--items', '1');
  box.run(alpha.repo, 'milestone', 'add', 'Next release with a longer name', '--reason', 'Arrange fixture release', '--items', '2,3');
  box.run(alpha.repo, 'milestone', 'ship', 'Old release', '--next', 'Next release with a longer name');
  box.run(alpha.repo, 'milestone', 'add', 'Later', '--note', 'Nothing filed yet.');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-release-chevron-chrome-'));
  let chrome;
  /** Each visible release head: its chevron's centre against the centre of its title's first line of text. */
  const offsets = async () => JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#roadmap-list .milestone-head')].filter((head) => head.getClientRects().length).map((head) => {
    // A release with a shared header (0ab202b994) carries its chevron beside the header, not inside the title.
    const caret = head.querySelector('h2 > .caret') || head.querySelector(':scope > .caret'), title = head.querySelector('h2');
    const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT, { acceptNode: (node) => node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP });
    const text = walker.nextNode(), range = document.createRange();
    range.selectNodeContents(text);
    const line = range.getClientRects()[0], mark = caret?.getBoundingClientRect();
    return { key: head.dataset.roadmapKey, open: head.getAttribute('aria-expanded'), svg: caret?.tagName.toLowerCase() || null, size: mark ? [Math.round(mark.width), Math.round(mark.height)] : null,
      offset: mark ? Math.round(((mark.top + mark.height / 2) - (line.top + line.height / 2)) * 10) / 10 : null };
  }))`));
  try {
    chrome = await openRoadmapChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.milestones?.length === 3');
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor("!document.querySelector('[data-pane=roadmap]').hidden && document.querySelector('[data-key=\"shipped\"] > .milestone-head')");
    for (const width of [1280, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      for (const pass of ['as opened', 'toggled']) {
        const heads = await offsets();
        assert.ok(heads.length >= 3, `${width} ${pass}: every release head is read: ${JSON.stringify(heads)}`);
        for (const head of heads) {
          assert.equal(head.svg, 'svg', `${width} ${pass} ${head.key}: the disclosure is the view's stroke chevron`);
          assert.ok(head.size[0] >= 15 && head.size[0] <= 17, `${width} ${pass} ${head.key}: the chevron is about 16px: ${head.size}`);
          assert.ok(Math.abs(head.offset) <= 2, `${width} ${pass} ${head.key} (${head.open}): the chevron centres on the title's first line: ${head.offset}px`);
        }
        // Flip every head, inner ones first so a folding Shipped never hides one still to press; each is measured both ways.
        for (const key of heads.map((head) => head.key).reverse()) await press(chrome, `document.querySelector('[data-roadmap-key=${JSON.stringify(key)}].milestone-head')`); // a shared-header release nests its head in .release-header
        await chrome.waitFor(`[...document.querySelectorAll('#roadmap-list .milestone-head')].filter((head) => head.getClientRects().length).length >= 3`);
      }
    }
    assert.deepEqual(chrome.exceptions, [], 'the roadmap raises no uncaught page exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('a roadmap case that times out names the page state and its waiting step [N26]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'the roadmap diagnostics need real Chrome');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-wait-'));
  let chrome;
  try {
    chrome = await openRoadmapChrome(executable, 'about:blank', profile);
    let failure = null;
    const neverArrives = ['fal', 'se'].join('');
    try { await chrome.waitFor(neverArrives, 1_500); } catch (error) { failure = error; } // budget: hang ceiling for the control's own wait that never arrives; no throughput claim.
    assert.ok(failure, 'a wait that never arrives times out');
    assert.match(failure.message, /waiting for step: false/u, 'the timeout names the step it waited on');
    assert.match(failure.message, /the roadmap showed \{/u, 'a wait that never arrives names the roadmap state it saw');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
  }
});

/** Every item-detail read the page makes answers 500 ms late; the page logs each path asked and each answered. */
const SLOW_DETAIL = `(() => {
  const fetched = window.fetch.bind(window);
  window.__asked = []; window.__answered = [];
  window.fetch = (url, options) => {
    const path = new URL(String(url), location.href).pathname;
    if (!/\\/items\\/\\d+$/u.test(path)) return fetched(url, options);
    window.__asked.push(path);
    return fetched(url, options).then((reply) => new Promise((done) => setTimeout(() => { window.__answered.push(path); done(reply); }, 500)));
  };
  /** Time one roadmap row's click to the frame it is drawn in, and read what that frame shows. */
  window.__armExpand = (key) => {
    window.__painted = new Promise((resolve) => addEventListener('click', () => {
      const started = performance.now();
      requestAnimationFrame(() => {
        const row = [...document.querySelectorAll('#roadmap .milestone-item')].find((each) => each.dataset.roadmapKey === key), why = row.parentElement.querySelector('.milestone-why');
        resolve({ ms: performance.now() - started, expanded: row.getAttribute('aria-expanded'), shown: !why.hidden, block: !!why.querySelector('.roadmap-detail'),
          title: row.querySelector('.t').textContent, state: row.querySelector('.dot').className, loading: !!why.querySelector('.roadmap-loading'),
          fields: [...why.querySelectorAll('dt')].map((dt) => dt.textContent) });
      });
    }, { capture: true, once: true }));
    return true;
  };
  window.__sawLoading = false;
  new MutationObserver(() => { if (document.querySelector('#roadmap .roadmap-loading')) window.__sawLoading = true; }).observe(document, { childList: true, subtree: true });
})()`;

/** Start a foreground view on a generated stress board and read its local link. */
async function startStressView(board) {
  const child = spawn(process.execPath, [BIN, 'view', '--no-open', '--port', '0'], { cwd: board.root, env: { ...board.env, PULLBOARD_VIEW_FOREGROUND: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise((done) => child.once('close', done));
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 30_000; // budget: hang ceiling for the generated board's view to print its link.
  while (Date.now() < deadline) {
    const link = /Pullboard view: (http:\/\/127\.0\.0\.1:\d+\/\?k=\S+)/u.exec(output);
    if (link) return { link: new URL(link[1]), stop: async () => { child.kill('SIGTERM'); await closed; } };
    await new Promise((done) => setTimeout(done, 25));
  }
  child.kill('SIGKILL');
  throw new Error('the stress board view printed no link');
}

test('expanding a roadmap row paints its detail within 100 ms [N26]', { timeout: 180_000 }, async (t) => {
  const began = performance.now();
  /** Name actual stage boundaries without changing either the hang ceiling or paint assertions. */
  const stage = phase => console.log('roadmap-expand-stage ' + JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - began) }));
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required to time a roadmap expand.');
  // A board our size: 1,038 items with their events, shouts and releases.
  stage('seed-start');
  const board = generateStressBoard({ seed: 'roadmap-expand-1039', size: 1_038 });
  stage('seed-end');
  stage('view-start');
  const view = await startStressView(board), profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-expand-chrome-'));
  stage('view-ready');
  const row = (key) => `[...document.querySelectorAll('#roadmap .milestone-item')].find((each) => each.dataset.roadmapKey === ${JSON.stringify(key)})`;
  const why = (key) => `${row(key)}.parentElement.querySelector('.milestone-why')`;
  /** Click one row and return what the frame after the click painted. */
  async function expand(key) {
    await chrome.stable(`window.__armExpand(${JSON.stringify(key)})`);
    await chrome.click(row(key));
    return chrome.stable('window.__painted');
  }
  const reads = async () => JSON.parse(await chrome.stable('JSON.stringify({ asked: window.__asked, answered: window.__answered })'));
  let chrome;
  try {
    stage('chrome-start');
    chrome = await openRoadmapChrome(executable, 'about:blank', profile);
    stage('chrome-ready');
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: SLOW_DETAIL });
    await chrome.send('Page.navigate', { url: view.link.href });
    await chrome.waitFor('data?.project?.items?.length === 1038', 30_000); // budget: hang ceiling for the first read of a board our size.
    stage('state-ready');
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor("view.tab === 'roadmap' && document.querySelectorAll('#roadmap .milestone-item').length > 100", 30_000); // budget: hang ceiling for the first roadmap draw.
    stage('roadmap-ready');
    // A row below the fold, never fetched ahead: its detail can only come from the delayed request.
    const far = await chrome.stable(`[...document.querySelectorAll('#roadmap .milestone-item[aria-expanded=false]')].filter((each) => /^i:#\\d+$/u.test(each.dataset.roadmapKey)
      && !each.closest('[hidden]') && each.getBoundingClientRect().top > innerHeight * 2).at(-1)?.dataset.roadmapKey`);
    assert.ok(far, 'the roadmap has a row below the fold');
    const farPath = '/items/' + far.slice(3);
    assert.equal((await reads()).asked.filter((path) => path.endsWith(farPath)).length, 0, 'the row below the fold was not read ahead');
    stage('first-expand-start');
    const painted = await expand(far);
    stage('first-expand-ready');
    t.diagnostic(`click to paint ${Math.round(painted.ms)} ms on ${far}`);
    assert.equal(painted.expanded, 'true'); assert.equal(painted.shown, true, 'the row opens in the frame after the click');
    assert.equal(painted.loading, false, 'no loading state shows'); assert.equal(painted.block, true, 'the row paints its block at once');
    assert.ok(painted.title.trim() && /\bdot\b/u.test(painted.state), 'the row keeps its title and state');
    assert.ok(painted.fields.includes('Release'), `the fields the summary holds paint at once: ${painted.fields}`);
    assert.ok(!painted.fields.includes('Criterion'), 'the criterion is still on its way');
    assert.ok(painted.ms < 100, `click to paint is under 100 ms: ${Math.round(painted.ms)} ms`);
    // The delayed fields fill the same block in place, with no loading flash between.
    await chrome.waitFor(`${why(far)}.querySelector('.roadmap-criterion') && ${why(far)}.textContent.includes('History')`, 10_000); // budget: hang ceiling for the 500 ms delayed read.
    assert.equal(await chrome.stable('window.__sawLoading'), false, 'no loading state showed at any point');
    // A second expand is instant: its detail is kept, so it paints whole and reads nothing.
    const asked = (await reads()).asked.length;
    await chrome.click(row(far));
    stage('repeat-expand-start');
    const again = await expand(far);
    stage('repeat-expand-ready');
    assert.ok(again.fields.includes('Criterion') && again.ms < 100, `a second expand paints whole at once: ${JSON.stringify(again)}`);
    // A row scrolled onto the screen is read ahead, so its first expand paints whole.
    const near = await chrome.stable(`[...document.querySelectorAll('#roadmap .milestone-item[aria-expanded=false]')].find((each) => /^i:#\\d+$/u.test(each.dataset.roadmapKey)
      && !each.closest('[hidden]') && each.dataset.roadmapKey !== ${JSON.stringify(far)})?.dataset.roadmapKey`);
    assert.ok(near, 'the roadmap has another folded row');
    await chrome.stable(`${row(near)}.scrollIntoView({ block: 'center', behavior: 'instant' }); true`);
    // Read ahead and drawn into the folded row once the queue drains.
    await chrome.waitFor(`window.__answered.some((path) => path.endsWith(${JSON.stringify('/items/' + near.slice(3))})) && !!${why(near)}.querySelector('.roadmap-criterion')`, 20_000); // budget: hang ceiling for the read ahead queue.
    stage('ahead-expand-start');
    const ahead = await expand(near);
    stage('ahead-expand-ready');
    assert.ok(ahead.fields.includes('Criterion') && !ahead.loading && ahead.ms < 100, `a row read ahead paints whole at once: ${JSON.stringify(ahead)}`);
    assert.equal((await reads()).asked.filter((path) => path.endsWith(farPath)).length, 1, 'the far row was read once');
    // A background refresh that moves no item reads no detail again.
    await chrome.waitFor('window.__asked.length === window.__answered.length', 30_000); // budget: hang ceiling for the reads ahead to drain.
    const settledReads = (await reads()).asked;
    assert.ok(settledReads.length >= asked, 'reads are counted');
    const shouted = spawnSync(process.execPath, [BIN, 'shout', 'all', 'A refresh that moves no item'], { cwd: board.root, env: board.env, encoding: 'utf8' });
    assert.equal(shouted.status, 0, shouted.stderr);
    await chrome.waitFor("data.project.shouts.some((each) => each.shout_text === 'A refresh that moves no item')", 20_000); // budget: hang ceiling for the next board poll.
    await chrome.waitFor('window.__asked.length === window.__answered.length', 10_000); // budget: hang ceiling for any read the refresh started.
    assert.deepEqual((await reads()).asked.slice(settledReads.length), [], 'the refresh fetched no detail of an item that has not moved');
    assert.deepEqual(chrome.exceptions, [], 'the roadmap raises no uncaught page exception');
    stage('body-end');
  } finally {
    stage('cleanup-start');
    if (chrome) await closeSnapshotChrome(chrome);
    stage('chrome-closed');
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
    stage('view-stopped');
    removeStressBoard(board);
    stage('cleanup-end');
  }
});
