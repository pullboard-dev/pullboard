// pullboard: browser
/** @pullboard-test-gui */
/** Real-input addresses, rendered places and browser history [N38,N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import {
  SPEC,
  machine,
  project,
  build,
  startView,
  boardOf,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
  travel,
  settled,
  serveFolder,
} from '../../tests/fixtures/cockpit/harness.js';
import {
  SCRIPT,
  assertPlace,
  openAddress,
  assertHeading,
  history,
  onePlace,
  addressBoard,
  withBrowser,
  assertShout,
} from '../../tests/fixtures/cockpit/addresses.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');
/** Create accepted and open items whose real prose, dependency and activity rows cite one another. */
function linkedItems(box, name) {
  const alpha = project(box, name, SPEC, { practice: 'DOCTRINE.md' });
  writeFileSync(join(alpha.repo, 'DOCTRINE.md'), `# Local rules\n\n## Team\n- PB1 [approved, must] ${name} practice rule. | gate: review\n`);
  box.run(alpha.repo, 'add', 'web', 'Address target', '--specs', 'G1', '--criterion', 'renders');
  box.run(alpha.repo, 'add', 'web', 'Text points to #1', '--specs', 'G1', '--criterion', 'criterion cites #1 and `#1`', '--brief', 'brief cites #1 and #999, with literal `#1`');
  box.run(alpha.repo, 'add', 'web', 'Waits on #2', '--specs', 'G1', '--criterion', 'waits', '--after', '2');
  box.run(alpha.repo, 'shout', 'all', 'Activity cites #1 and waits on #2.');
  build(box, alpha, 1, 'target.txt');
  box.git(alpha.repo, 'switch', '-q', '--detach', alpha.itemBranches.get(`${alpha.baseBranch}:1`));
  box.run(alpha.repo, 'verify', '1', 'accept', '--note', 'The notes cite #2 and literal `#2`.', '--as', 'coordinator');
  box.git(alpha.repo, 'switch', '-q', 'main');
  return alpha;
}

/** Poll Chrome's real target list until a modified anchor click opens its href in another tab. */
async function targetForHref(profile, href) {
  const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
  const deadline = Date.now() + 10_000; // budget: hang-only wait for Chrome to publish the native new-tab target.
  let targets = [];
  while (Date.now() < deadline) {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const match = targets.find((target) => target.type === 'page' && target.url === href);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Chrome did not open ${href}; page targets: ${JSON.stringify(targets.map(({ type, url }) => ({ type, url })))}`);
}

test('clause 1: item text links every item reference [N38,N26]', { timeout: 90_000 }, async () => { // budget: hang ceiling for the real API, Chrome navigation and linked prose checks.
  const box = machine(), alpha = linkedItems(box, 'item-text-links');
  await withBrowser(box, async (chrome, server) => {
    await openAddress(chrome, server, '/items/2');
    const refs = JSON.parse(await chrome.stable(`JSON.stringify({
      criterion:[...([...document.querySelectorAll('#detail h3')].find(node=>node.textContent==='Done when')?.closest('section').querySelectorAll('a.ref[data-go]')||[])].map(node=>[node.textContent,new URL(node.href).pathname]),
      brief:[...([...document.querySelectorAll('#detail h3')].find(node=>node.textContent==='Brief')?.closest('section').querySelectorAll('a.ref[data-go]')||[])].map(node=>[node.textContent,new URL(node.href).pathname])
    })`));
    assert.deepEqual(refs.criterion, [['#1', '/items/1']], 'criterion references are real same-board addresses');
    assert.deepEqual(refs.brief, [['#1', '/items/1'], ['#999', '/items/999']], 'known and unknown references are real same-board addresses');
    for (const heading of ['Done when', 'Brief']) {
      const literal = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const section = [...document.querySelectorAll('#detail h3')].find(node => node.textContent === ${JSON.stringify(heading)}).closest('section');
        return { code: [...section.querySelectorAll('code')].map(node => node.textContent), linkedCode: section.querySelectorAll('code a, a code').length };
      })())`));
      assert.deepEqual(literal, { code: ['#1'], linkedCode: 0 }, `${heading}: backticked references stay unlinked code`);
      const before = await history(chrome);
      await press(chrome, `[...document.querySelectorAll('#detail h3')].find(node => node.textContent === ${JSON.stringify(heading)}).closest('section').querySelector('code')`);
      assert.deepEqual(await history(chrome), before, `${heading}: clicking code leaves the browser address unchanged`);
    }
    await press(chrome, `document.querySelector('#detail a.ref[data-go="item:999"]')`);
    await settled(chrome, "document.querySelector('#detail .empty')?.textContent.includes('No item #999 exists here.')");
    assert.match(await chrome.stable("document.querySelector('#detail .empty')?.textContent"), /No item #999 exists here/,
      'an unknown reference opens its address and shows the missing-item detail');
    await openAddress(chrome, server, '/items/3');
    const waits = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#detail .waits-on a.ref[data-go]')].map(node=>[node.textContent,new URL(node.href).pathname]))`));
    assert.deepEqual(waits, [['#2', '/items/2']], 'waits-on references link to the waited item');
    await press(chrome, `document.querySelector('[data-tab="activity"]')`);
    const activity = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#activity a.ref[data-go]')].map(node=>[node.textContent,new URL(node.href).pathname]))`));
    const activityCites = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#activity .activity-event')]
      .filter(node=>node.textContent.includes('Activity cites #1 and waits on #2'))
      .flatMap(node=>[...node.querySelectorAll('a.ref[data-go]:not(.activity-about)')].map(link=>[link.textContent,new URL(link.href).pathname])))`));
    assert.deepEqual(activityCites, [['#1', '/items/1'], ['#2', '/items/2']], 'the Activity citation and wait prose link to their exact item targets');
    assert.ok(activity.some(([text, href]) => text === '#1' && href === '/items/1'), 'Activity item events also link to their item addresses');
    await openAddress(chrome, server, '/items/1');
    const verdict = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#detail .item-panel-latest .verdict .note a.ref[data-go]')].map(node=>[node.textContent,new URL(node.href).pathname]))`));
    assert.deepEqual(verdict, [['#2', '/items/2']], 'verdict notes link only their plain cited item');
    const verdictCode = JSON.parse(await chrome.stable(`JSON.stringify({
      code: [...document.querySelectorAll('#detail .item-panel-latest .verdict .note code')].map(node => node.textContent),
      linkedCode: document.querySelectorAll('#detail .item-panel-latest .verdict .note code a, #detail .item-panel-latest .verdict .note a code').length
    })`));
    assert.deepEqual(verdictCode, { code: ['#2'], linkedCode: 0 }, 'actual recorded verdict notes keep backticked references literal');
    const beforeCode = await history(chrome);
    await press(chrome, `document.querySelector('#detail .item-panel-latest .verdict .note code')`);
    assert.deepEqual(await history(chrome), beforeCode, 'plain click on verdict code does not navigate');
    await press(chrome, `document.querySelector('#detail .item-panel-latest .verdict .note a.ref[data-go]')`);
    assert.equal(await chrome.stable('location.pathname'), '/items/2', 'plain click stays in the page and opens the linked place');
    assert.equal(await chrome.stable("document.querySelector('#detail h2 > span')?.textContent"), '#2');
    assert.deepEqual(chrome.exceptions, [], 'the real view raises no page errors');
  });
});

test('clause 1: a modified click opens a new tab [N38,N26]', { timeout: 90_000 }, async () => { // budget: hang ceiling for Chrome startup and native modified-click targets.
  const box = machine(), alpha = linkedItems(box, 'modified-item-link');
  const server = await startView(box);
  const executable = chromeExecutable();
  assert.ok(executable, 'real Chrome is required to prove native modified-click behavior');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-modified-link-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, server.link.href, profile);
    await settled(chrome, SCRIPT);
    await openAddress(chrome, server, '/items/2');
    for (const heading of ['Done when', 'Brief']) {
      const selector = `[...document.querySelectorAll('#detail h3')].find(node => node.textContent === ${JSON.stringify(heading)}).closest('section').querySelector('code')`;
      for (const input of [{ button: 'middle' }, { modifiers: process.platform === 'darwin' ? 4 : 2 }]) {
        const beforeTargets = (await chrome.send('Target.getTargets')).targetInfos.filter(row => row.type === 'page').map(row => row.targetId).sort();
        await press(chrome, selector, input);
        const afterTargets = (await chrome.send('Target.getTargets')).targetInfos.filter(row => row.type === 'page').map(row => row.targetId).sort();
        assert.deepEqual(afterTargets, beforeTargets, `${heading}: modified code clicks open no tab`);
        assert.equal(await chrome.stable('location.pathname'), '/items/2', `${heading}: modified code clicks leave this tab in place`);
      }
    }
    const href = await chrome.stable(`document.querySelector('#detail a.ref[data-go="item:1"]')?.href`);
    assert.equal(new URL(href).pathname, '/items/1', 'the anchor exposes the target before input');
    await press(chrome, `document.querySelector('#detail a.ref[data-go="item:1"]')`, { button: 'middle' });
    const target = await targetForHref(profile, href);
    assert.equal(await chrome.stable('location.pathname'), '/items/2', 'the original tab remains at its current place');
    assert.equal(target.url, href, 'Chrome opens the anchor destination in another page target');
    await openAddress(chrome, server, '/items/3');
    const modifierHref = await chrome.stable(`document.querySelector('#detail a.ref[data-go="item:2"]')?.href`);
    const modifiers = process.platform === 'darwin' ? 4 : 2;
    await press(chrome, `document.querySelector('#detail a.ref[data-go="item:2"]')`, { modifiers });
    const modifierTarget = await targetForHref(profile, modifierHref);
    assert.equal(await chrome.stable('location.pathname'), '/items/3', 'the platform modifier leaves the original tab at its current place');
    assert.equal(modifierTarget.url, modifierHref, 'Chrome opens a platform-modified anchor in another page target');
    await chrome.send('Target.closeTarget', { targetId: target.id });
    await chrome.send('Target.closeTarget', { targetId: modifierTarget.id });
    await openAddress(chrome, server, '/items/1');
    const verdictSelector = `document.querySelector('#detail .item-panel-latest .verdict .note a.ref[data-go="item:2"]')`;
    assert.equal(await chrome.stable(`document.querySelector('#detail .item-panel-latest .verdict .note code')?.textContent ?? null`), '#2', 'modified-click control has a literal verdict code token');
    const verdictHref = await chrome.stable(`${verdictSelector}?.href`);
    assert.equal(new URL(verdictHref).pathname, '/items/2', 'recorded verdict prose exposes its real href');
    for (const input of [{ button: 'middle' }, { modifiers }]) {
      const beforeTargets = (await chrome.send('Target.getTargets')).targetInfos.filter(row => row.type === 'page').map(row => row.targetId).sort();
      await press(chrome, `document.querySelector('#detail .item-panel-latest .verdict .note code')`, input);
      const afterTargets = (await chrome.send('Target.getTargets')).targetInfos.filter(row => row.type === 'page').map(row => row.targetId).sort();
      assert.deepEqual(afterTargets.filter(id => !beforeTargets.includes(id)), [], 'modified click on literal verdict code opens no tab');
      assert.equal(await chrome.stable('location.pathname'), '/items/1', 'literal code leaves the original tab in place');
      await press(chrome, verdictSelector, input);
      const opened = await targetForHref(profile, verdictHref);
      assert.equal(await chrome.stable('location.pathname'), '/items/1', 'modified verdict prose leaves the original tab in place');
      assert.equal(opened.url, verdictHref, 'modified verdict prose opens the real item address');
      await chrome.send('Target.closeTarget', { targetId: opened.id });
    }
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await server.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('clause 1: the snapshot keeps its addresses under a sub-path [N38,A10]', { timeout: 90_000 }, async () => { // budget: hang ceiling for export, replay, click and reload.
  const executable = chromeExecutable();
  assert.ok(executable, 'real Chrome is required to prove exported address reloads');
  const box = machine(), alpha = linkedItems(box, 'snapshot-item-address');
  const folder = join(box.dir, 'snapshot');
  box.run(alpha.repo, 'view', '--export', folder);
  const host = await serveFolder(folder, '/demo/');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-snapshot-address-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, `${host.base}/demo/`, profile);
    await settled(chrome, "document.body.classList.contains('snapshot') && !!data?.project");
    await settled(chrome, 'snapshotReplay.index === snapshotReplay.events.length');
    // A fresh board opens on the first-run Dashboard (0de17112c6); set it aside so the tabs under test render.
    await chrome.stable("(() => { keep('pb.firstrun.' + view.root, 'hidden'); render(); return true; })()");
    await press(chrome, `document.querySelector('[data-tab="items"]')`);
    await chrome.waitFor(`!!document.querySelector('#chain [data-item="2"]')`);
    await press(chrome, `document.querySelector('#chain [data-item="2"]')`);
    assert.equal(await chrome.stable('location.pathname + location.hash'), '/demo/#items/2', 'a plain snapshot selection records its own address before any reload');
    const reference = `document.querySelector('#detail a.ref[data-go="item:1"]')`;
    await chrome.waitFor(`!!${reference}`);
    const href = await chrome.stable(`${reference}.href`);
    assert.equal(new URL(href).pathname, '/demo/', 'snapshot item links retain the export sub-path');
    assert.equal(new URL(href).hash, '#items/1', 'snapshot item links address the item in the fragment');
    const outsideInitialRefs = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#detail a.ref[data-go^="item:"]')]
      .filter(link=>new URL(link.href).pathname !== '/demo/').map(link=>link.href))`));
    assert.deepEqual(outsideInitialRefs, [], 'item detail references also remain under the exported sub-path');
    await press(chrome, reference);
    await settled(chrome, "location.pathname === '/demo/' && location.hash === '#items/1' && document.querySelector('#detail h2 > span')?.textContent === '#1'");
    await chrome.send('Page.reload');
    await settled(chrome, "location.pathname === '/demo/' && location.hash === '#items/1' && document.querySelector('#detail h2 > span')?.textContent === '#1'");

    /** Reload an exported address and verify both its selected detail and its contained references. */
    const checkPlace = async (hash, ready) => {
      assert.equal(await chrome.stable('location.hash'), hash, 'the selected place is encoded in the snapshot address');
      await chrome.send('Page.reload');
      await settled(chrome, `location.pathname === '/demo/' && location.hash === ${JSON.stringify(hash)} && data?.project && snapshotReplay.final && snapshotReplay.index === snapshotReplay.events.length && (${ready})`);
      assert.equal(await chrome.stable('location.pathname'), '/demo/', 'reload keeps the exported page path');
      const outside = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('a.ref[data-go^="item:"]')]
        .filter(link=>new URL(link.href).pathname !== '/demo/').map(link=>link.href))`));
      assert.deepEqual(outside, [], `${hash} keeps every item address under the exported sub-path`);
    };
    await press(chrome, `document.querySelector('[data-items-view="pipeline"]')`);
    await checkPlace('#items/pipeline', "view.tab === 'items' && view.itemsView === 'pipeline' && !document.querySelector('[data-pane=items]').hidden");
    const oldest = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const link = document.querySelector('#pipeline .pipeline-oldest a.ref[data-go]');
      return { href: link?.href, id: Number(link?.textContent.slice(1)) };
    })())`));
    assert.ok(oldest.href && oldest.id > 0, 'the exported Pipeline shows its oldest-item address');
    await press(chrome, `document.querySelector('#pipeline .pipeline-oldest a.ref[data-go]')`);
    await checkPlace(new URL(oldest.href).hash, `view.tab === 'items' && view.item === ${oldest.id}`);
    await press(chrome, `document.querySelector('[data-tab="shouts"]')`);
    await checkPlace('#shouts', "view.tab === 'shouts' && !document.querySelector('[data-pane=shouts]').hidden");
    // The Shouts tab lists conversations; open the first one so its message cards render.
    await press(chrome, `document.querySelector('#feed .conversation-row')`);
    await chrome.waitFor(`!!document.querySelector('#feed [data-shout-id]')`);
    const shoutId = await chrome.stable(`document.querySelector('#feed [data-shout-id]')?.dataset.shoutId`);
    await press(chrome, `document.querySelector('#feed [data-shout-id]')`);
    await checkPlace('#shouts/' + shoutId, `view.tab === 'shouts' && view.shout === Number(${JSON.stringify(shoutId)}) && document.querySelector('#feed article.found')?.dataset.shoutId === ${JSON.stringify(shoutId)}`);
    await press(chrome, `document.querySelector('[data-tab="spec"]')`);
    await press(chrome, `document.querySelector('[data-rows="spec:all"]')`);
    const specId = await chrome.stable(`document.querySelector('#spec-list [data-row]')?.dataset.row.split(':')[1]`);
    await press(chrome, `document.querySelector('#spec-list [data-row]')`);
    await checkPlace('#spec/' + specId, `view.tab === 'spec' && view.row.spec === ${JSON.stringify(specId)} && document.querySelector('#spec-detail h2 > span')?.textContent === ${JSON.stringify(specId)}`);
    await press(chrome, `document.querySelector('[data-tab="doctrine"]')`);
    const doctrineId = await chrome.stable(`document.querySelector('#doctrine-list [data-row]')?.dataset.row.split(':')[1]`);
    await press(chrome, `document.querySelector('#doctrine-list [data-row]')`);
    await checkPlace('#doctrine/' + doctrineId, `view.tab === 'doctrine' && view.row.doctrine === ${JSON.stringify(doctrineId)} && document.querySelector('#doctrine-detail h2 > span')?.textContent === ${JSON.stringify(doctrineId)}`);
    await press(chrome, `document.querySelector('[data-tab="activity"]')`);
    await checkPlace('#activity', "view.tab === 'activity' && !document.querySelector('[data-pane=activity]').hidden");
    await press(chrome, `document.querySelector('[data-tab="roadmap"]')`);
    await checkPlace('#roadmap', "view.tab === 'roadmap' && !document.querySelector('[data-pane=roadmap]').hidden");
    assert.ok(host.requests.length > 0 && host.requests.every((request) => request.path.startsWith('/demo/')), 'click and reload stay under the exported sub-path');
    assert.deepEqual(chrome.exceptions, [], 'the exported page raises no page errors');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await host.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
test('every place in the view has its own address [N38,N26]', { timeout: 180_000 }, async () => { // budget: hang-only ceiling for the complete direct-address matrix.
  const box = machine(), alpha = addressBoard(box, 'alpha');
  box.run(alpha.repo, 'shout', 'person', 'Address target shout.');
  await withBrowser(box, async (chrome, server) => {
    const shout = (await boardOf(server, alpha.repo)).shouts.find(one => one.shout_text === 'Address target shout.');
    assert.ok(shout?.shout_id);
    const direct = [
      ['/items/1', 'items', '#detail', '#1', 'alpha first address item'],
      ['/items/pipeline', 'items'], ['/shouts', 'shouts'], [`/shouts/${shout.shout_id}`, 'shouts'],
      ['/spec', 'spec'], ['/spec/G2', 'spec', '#spec-detail', 'G2', 'alpha distinct specification row'],
      ['/doctrine', 'doctrine'], ['/doctrine/PB1', 'doctrine', '#doctrine-detail', 'PB1', 'alpha distinct practice rule'],
      ['/activity', 'activity'], ['/roadmap', 'roadmap'],
    ];
    for (const [address, pane, selector, id, text] of direct) {
      await openAddress(chrome, server, address);
      await assertPlace(chrome, address, pane, alpha.repo);
      if (selector) await assertHeading(chrome, selector, id, text);
      if (address === '/items/pipeline') assert.equal(await chrome.stable("document.querySelector('#pipeline').hidden"), false);
      if (address.startsWith('/shouts/')) await assertShout(chrome, shout.shout_id, 'Address target shout.');
      assert.equal((await history(chrome)).length > 0, true);
    }
    for (const [address, pane, selector, id] of [
      ['/items/9999', 'items', '#detail', '9999'], ['/spec/NO_SUCH_ROW', 'spec', '#spec-detail', 'NO_SUCH_ROW'],
      ['/doctrine/NO_SUCH_ROW', 'doctrine', '#doctrine-detail', 'NO_SUCH_ROW'], ['/shouts/999999', 'shouts', '#feed', '999999'],
    ]) {
      await openAddress(chrome, server, address);
      await assertPlace(chrome, address, pane, alpha.repo);
      if (pane === 'shouts') await settled(chrome, "!document.querySelector('#shout-address-status')?.textContent.startsWith('Loading')");
      const text = await chrome.stable(`document.querySelector(${JSON.stringify(selector)}).innerText`);
      assert.match(text, /No (?:item|shout|Spec row|Doctrine row).*exists here/i, 'missing targets say so');
      assert.ok(text.includes(id), 'missing-target message identifies the target');
      assert.equal(await chrome.stable(`!!document.querySelector(${JSON.stringify(selector + ' h2')})`), false, 'no unrelated default detail');
    }
    await openAddress(chrome, server, '/#items/pipeline');
    await assertPlace(chrome, '/items/pipeline', 'items', alpha.repo);
    assert.equal(await chrome.stable("document.querySelector('#pipeline').hidden"), false, 'the legacy Pipeline fragment still opens Pipeline');
    await openAddress(chrome, server, '/#roadmap');
    await assertPlace(chrome, '/roadmap', 'roadmap', alpha.repo);
    assert.equal((await fetch(new URL('/items/1', server.link))).status, 403, 'direct places retain the secret boundary');
  });
});

test('back, forward and reload keep the place [N38,N26]', { timeout: 180_000 }, async () => { // budget: hang-only ceiling for real clicks, stack traversal and fresh-document reloads.
  const box = machine(), alpha = addressBoard(box, 'history-alpha');
  box.run(alpha.repo, 'shout', 'person', 'History journey shout.');
  await withBrowser(box, async (chrome, server) => {
    const shout = (await boardOf(server, alpha.repo)).shouts.find(one => one.shout_text === 'History journey shout.');
    await openAddress(chrome, server, '/items');
    const journey = [{ address: '/items', pane: 'items', root: alpha.repo }];
    const steps = [
      ['#chain .row[data-item="1"]', '/items/1', 'items'], ['[data-items-view="pipeline"]', '/items/pipeline', 'items'],
      ['[data-tab="shouts"]', '/shouts', 'shouts'], [`#feed #shout-${shout.shout_id} .text`, `/shouts/${shout.shout_id}`, 'shouts'],
      ['[data-tab="spec"]', '/spec', 'spec'], ['[data-row="spec:G2"]', '/spec/G2', 'spec'],
      ['[data-tab="doctrine"]', '/doctrine', 'doctrine'], ['[data-row="doctrine:PB1"]', '/doctrine/PB1', 'doctrine'],
      ['[data-tab="activity"]', '/activity', 'activity'], ['[data-tab="roadmap"]', '/roadmap', 'roadmap'],
      ['[data-tab="items"]', '/items/pipeline', 'items'], ['[data-items-view="list"]', '/items', 'items'],
      ['#chain .row[data-item="2"]', '/items/2', 'items'],
    ];
    for (const [selector, address, pane] of steps) {
      if (selector === `#feed #shout-${shout.shout_id} .text`) {
        const beforeConversation = await history(chrome);
        await press(chrome, 'document.querySelector(\'[data-shout-thread="none"]\')');
        await settled(chrome, `!!document.querySelector('#feed #shout-${shout.shout_id} .text')`);
        assert.deepEqual(await history(chrome), beforeConversation, 'opening a conversation preserves the current Shouts address');
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

