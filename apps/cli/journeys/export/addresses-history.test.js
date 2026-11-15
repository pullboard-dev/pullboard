// pullboard: browser
/** @pullboard-test-gui */
/** Browser back, forward and reload keep the place [N38,N26]; split from addresses.test.js for its file budget. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  machine,
  boardOf,
  press,
  travel,
  settled,
} from '../../tests/fixtures/cockpit/harness.js';
import {
  SCRIPT,
  assertPlace,
  openAddress,
  assertHeading,
  history,
  onePlace,
  addressBoardLocal,
  withBrowser,
  assertShout,
} from '../../tests/fixtures/cockpit/addresses.js';

test('back, forward and reload keep the place [N38,N26]', { timeout: 180_000 }, async () => { // budget: hang-only ceiling for real clicks, stack traversal and fresh-document reloads.
  const box = machine();
  const alpha = await addressBoardLocal(box, 'history-alpha');
  await box.inProcess(alpha.repo, 'shout', 'person', 'History journey shout.');
  await withBrowser(box, async (chrome, server) => {
    const shout = (await boardOf(server, alpha.repo)).shouts.find(one => one.shout_text === 'History journey shout.');
    await openAddress(chrome, server, '/items');
    const journey = [{ address: '/items', pane: 'items', root: alpha.repo }];
    const steps = [
      ['#chain .row[data-item="1"]', '/items/1', 'items'], ['[data-page-ctl="view"][data-value="pipeline"]', '/items/pipeline', 'items'],
      ['[data-tab="shouts"]', '/shouts', 'shouts'], [`#feed #shout-${shout.shout_id} .sx-tx`, `/shouts/${shout.shout_id}`, 'shouts'],
      ['[data-tab="spec"]', '/spec', 'spec'], ['[data-row="spec:G2"]', '/spec/G2', 'spec'],
      ['[data-tab="doctrine"]', '/doctrine', 'doctrine'], ['[data-row="doctrine:PB1"]', '/doctrine/PB1', 'doctrine'],
      ['[data-tab="activity"]', '/activity', 'activity'], ['[data-tab="roadmap"]', '/roadmap', 'roadmap'],
      ['[data-tab="items"]', '/items/pipeline', 'items'], ['[data-page-ctl="view"][data-value="list"]', '/items', 'items'],
      ['#chain .row[data-item="2"]', '/items/2', 'items'],
    ];
    for (const [selector, address, pane] of steps) {
      if (selector === `#feed #shout-${shout.shout_id} .sx-tx`) {
        // A thread opens in place and the address keeps it, by replacing the entry: no new entry is pushed.
        const beforeConversation = await history(chrome);
        await press(chrome, 'document.querySelector(\'[data-shout-thread="none"]\')');
        await settled(chrome, `!!document.querySelector('#feed #shout-${shout.shout_id} .sx-tx')`);
        assert.deepEqual(await history(chrome), beforeConversation, 'opening a thread keeps its place in the address without adding an entry');
        await assertPlace(chrome, address, pane, alpha.repo);
        journey[journey.length - 1] = { address, pane, root: alpha.repo };
        continue;
      }
      journey.push(await onePlace(chrome, `document.querySelector(${JSON.stringify(selector)})`, address, pane, alpha.repo));
    }
    const unchanged = await history(chrome);
    await press(chrome, 'document.querySelector(\'#chain .row[data-item="2"]\')');
    await settled(chrome, SCRIPT);
    assert.deepEqual(await history(chrome), unchanged, 'selecting the same item never pushes a duplicate');
    await onePlace(chrome, 'document.querySelector(\'[data-tab="shouts"]\')', '/shouts', 'shouts', alpha.repo);
    const sameTab = await history(chrome);
    for (let repeat = 0; repeat < 2; repeat += 1) {
      await press(chrome, 'document.querySelector(\'[data-tab="shouts"]\')');
      await settled(chrome, SCRIPT);
      assert.deepEqual(await history(chrome), sameTab, 'selecting the current tab never pushes a duplicate');
    }
    await travel(chrome, -1);
    await settled(chrome, SCRIPT);
    for (const direction of [-1, 1]) {
      const indices = direction < 0 ? Array.from({ length: journey.length - 1 }, (_, index) => journey.length - 2 - index) : Array.from({ length: journey.length - 1 }, (_, index) => index + 1);
      for (const index of indices) {
        await travel(chrome, direction);
        await settled(chrome, SCRIPT);
        const step = journey[index];
        await assertPlace(chrome, step.address, step.pane, step.root);
        if (step.address === '/spec/G2') await assertHeading(chrome, '#spec-detail', 'G2', 'history-alpha distinct specification row');
        if (step.address === '/doctrine/PB1') await assertHeading(chrome, '#doctrine-detail', 'PB1', 'history-alpha distinct practice rule');
        if (/\/items\/\d+$/.test(step.address)) await assertHeading(chrome, '#detail', `#${step.address.split('/').at(-1)}`, 'address item');
        if (step.address.startsWith('/shouts/')) await assertShout(chrome, shout.shout_id, 'History journey shout.');
      }
    }
    for (const step of journey.slice(0, -2)) {
      await openAddress(chrome, server, step.address);
      const before = await chrome.stable('performance.timeOrigin');
      await chrome.send('Page.reload');
      await settled(chrome, `performance.timeOrigin !== ${before} && ${SCRIPT}`);
      await assertPlace(chrome, step.address, step.pane, alpha.repo);
      if (step.address === '/spec/G2') await assertHeading(chrome, '#spec-detail', 'G2', 'history-alpha distinct specification row');
      if (step.address === '/doctrine/PB1') await assertHeading(chrome, '#doctrine-detail', 'PB1', 'history-alpha distinct practice rule');
      if (step.address === '/items/1') await assertHeading(chrome, '#detail', '#1', 'history-alpha first address item');
      if (step.address.startsWith('/shouts/')) await assertShout(chrome, shout.shout_id, 'History journey shout.');
    }
  });
});

