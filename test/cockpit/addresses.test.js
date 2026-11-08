// pullboard: browser
/** @pullboard-test-gui */
/** Real-input addresses, rendered places and browser history [N38,N26]. */
import { main as nativeTestMain } from '../native-cli-fixture.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { stableChrome } from './stable.js';
import { relayClientFixture } from '../relay-client-fixture.js';
import { startChrome, relayWorkBudgetMs } from '../relay-browser-fixture.js';
import { runFixtureChild } from '../fixture-child.js';
import { chooseViewPort } from '../view-port-fixture.js';
import { SPEC, machine, project, build, startView, boardOf, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, press, travel, settled, serveFolder } from './fixture.js';

const BIN = resolve(import.meta.dirname, '../../bin/pullboard.js');
const SCRIPT = "typeof view === 'object' && typeof data === 'object' && !!data?.project && data.root === view.root && !document.body.classList.contains('loading')";
/** Read the actual rendered place without waiting for the expected answer. */
async function observed(chrome) {
  return JSON.parse(await chrome.stable(`JSON.stringify({ address:location.pathname + location.hash, root:view.root, tab:document.querySelector('.tab.on')?.dataset.tab, panes:[...document.querySelectorAll('[data-pane]')].filter(node => !node.hidden).map(node => node.dataset.pane) })`));
}
/** Check the address, repo and visible pane independently of internal selection state. */
async function assertPlace(chrome, address, pane, root) {
  assert.deepEqual(await observed(chrome), { address, root, tab: pane, panes: [pane] });
}
/** Navigate from a blank page and wait for the new document's script before reading its board. */
async function openAddress(chrome, server, address) {
  await chrome.send('Page.navigate', { url: 'about:blank' });
  await settled(chrome, "location.href === 'about:blank'");
  const target = new URL(address, server.link);
  target.search = server.link.search;
  await chrome.send('Page.navigate', { url: target.href });
  await settled(chrome, SCRIPT);
  // An item address opens its item; the view reads its detail then, and its heading arrives with it.
  if (/\/items\/\d+$/.test(target.pathname)) await settled(chrome, "!!document.querySelector('#detail h2, #detail .empty')");
}
/** Assert the detail itself, so suppressing row rendering produces an assertion failure. */
async function assertHeading(chrome, selector, id, text) {
  const heading = await chrome.stable(`document.querySelector(${JSON.stringify(selector + ' h2')})?.textContent ?? null`);
  assert.ok(heading?.includes(id) && heading.includes(text), `detail heading names ${id} ${text}: ${heading}`);
}
/** Read the real browser stack, including same-document pushState entries. */
async function history(chrome) {
  const { currentIndex, entries } = await chrome.send('Page.getNavigationHistory');
  return { currentIndex, length: entries.length };
}
/** Click once, await the normal rendering boundary, then assert exactly one new place entry. */
async function onePlace(chrome, selector, address, pane, root) {
  const before = await history(chrome);
  await press(chrome, selector);
  await settled(chrome, SCRIPT);
  await assertPlace(chrome, address, pane, root);
  const after = await history(chrome);
  assert.deepEqual(after, { currentIndex: before.currentIndex + 1, length: before.length + 1 }, `${address}: one entry per change`);
  return { address, pane, root };
}
/** Create distinct real rows without duplicate identifiers, and two real items. */
function addressBoard(box, name, group) {
  const spec = SPEC.replace(/^- G2 .*$/m, `- G2 [pending, must] ${name} distinct specification row. | gate: review`);
  const p = project(box, name, spec, { practice: 'DOCTRINE.md', ...(group ? { project: group } : {}) });
  writeFileSync(join(p.repo, 'DOCTRINE.md'), `# Local rules\n\n## Team\n- PB1 [approved, must] ${name} distinct practice rule. | gate: review\n`);
  box.run(p.repo, 'add', 'web', `${name} first address item`, '--specs', 'G1');
  box.run(p.repo, 'add', 'web', `${name} second address item`, '--specs', 'G1');
  box.run(p.repo, 'milestone', 'add', `${name} address milestone`, '--reason', 'Arrange fixture release', '--items', '1,2');
  return p;
}
/** Own one browser and server, with cleanup even if an assertion fails. */
async function withBrowser(box, run) {
  const executable = chromeExecutable();
  assert.ok(executable, 'real Chrome is required for address checks');
  const server = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-addresses-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, server.link.href, profile);
    await settled(chrome, SCRIPT);
    await run(chrome, server);
    assert.deepEqual(chrome.exceptions, [], 'new-document navigation causes no page exceptions');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await server.stop();
    rmSync(profile, { recursive: true, force: true });
  }
}

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

test('item text links every item reference [N38,N26]', { timeout: 90_000 }, async () => { // budget: hang ceiling for the real API, Chrome navigation and linked prose checks.
  const box = machine(), alpha = linkedItems(box, 'item-text-links');
  await withBrowser(box, async (chrome, server) => {
    await openAddress(chrome, server, '/items/2');
    const refs = JSON.parse(await chrome.stable(`JSON.stringify({
      criterion:[...([...document.querySelectorAll('#detail h3')].find(node=>node.textContent==='Done when')?.parentElement.querySelectorAll('a.ref[data-go]')||[])].map(node=>[node.textContent,new URL(node.href).pathname]),
      brief:[...([...document.querySelectorAll('#detail h3')].find(node=>node.textContent==='Brief')?.parentElement.querySelectorAll('a.ref[data-go]')||[])].map(node=>[node.textContent,new URL(node.href).pathname])
    })`));
    assert.deepEqual(refs.criterion, [['#1', '/items/1']], 'criterion references are real same-board addresses');
    assert.deepEqual(refs.brief, [['#1', '/items/1'], ['#999', '/items/999']], 'known and unknown references are real same-board addresses');
    for (const heading of ['Criterion', 'Brief']) {
      const literal = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const section = [...document.querySelectorAll('#detail h3')].find(node => node.textContent === ${JSON.stringify(heading)}).parentElement;
        return { code: [...section.querySelectorAll('code')].map(node => node.textContent), linkedCode: section.querySelectorAll('code a, a code').length };
      })())`));
      assert.deepEqual(literal, { code: ['#1'], linkedCode: 0 }, `${heading}: backticked references stay unlinked code`);
      const before = await history(chrome);
      await press(chrome, `[...document.querySelectorAll('#detail h3')].find(node => node.textContent === ${JSON.stringify(heading)}).parentElement.querySelector('code')`);
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
      .flatMap(node=>[...node.querySelectorAll('a.ref[data-go]')].map(link=>[link.textContent,new URL(link.href).pathname])))`));
    assert.deepEqual(activityCites, [['#1', '/items/1'], ['#2', '/items/2']], 'the Activity citation and wait prose link to their exact item targets');
    assert.ok(activity.some(([text, href]) => text === '#1' && href === '/items/1'), 'Activity item events also link to their item addresses');
    await openAddress(chrome, server, '/items/1');
    const verdict = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#detail .verdict .note a.ref[data-go]')].map(node=>[node.textContent,new URL(node.href).pathname]))`));
    assert.deepEqual(verdict, [['#2', '/items/2']], 'verdict notes link only their plain cited item');
    const verdictCode = JSON.parse(await chrome.stable(`JSON.stringify({
      code: [...document.querySelectorAll('#detail .verdict .note code')].map(node => node.textContent),
      linkedCode: document.querySelectorAll('#detail .verdict .note code a, #detail .verdict .note a code').length
    })`));
    assert.deepEqual(verdictCode, { code: ['#2'], linkedCode: 0 }, 'actual recorded verdict notes keep backticked references literal');
    const beforeCode = await history(chrome);
    await press(chrome, `document.querySelector('#detail .verdict .note code')`);
    assert.deepEqual(await history(chrome), beforeCode, 'plain click on verdict code does not navigate');
    await press(chrome, `document.querySelector('#detail .verdict .note a.ref[data-go]')`);
    assert.equal(await chrome.stable('location.pathname'), '/items/2', 'plain click stays in the page and opens the linked place');
    assert.equal(await chrome.stable("document.querySelector('#detail h2 > span')?.textContent"), '#2');
    assert.deepEqual(chrome.exceptions, [], 'the real view raises no page errors');
  });
});

test('a modified click opens a new tab [N38,N26]', { timeout: 90_000 }, async () => { // budget: hang ceiling for Chrome startup and native modified-click targets.
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
    for (const heading of ['Criterion', 'Brief']) {
      const selector = `[...document.querySelectorAll('#detail h3')].find(node => node.textContent === ${JSON.stringify(heading)}).parentElement.querySelector('code')`;
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
    const verdictSelector = `document.querySelector('#detail .verdict .note a.ref[data-go="item:2"]')`;
    assert.equal(await chrome.stable(`document.querySelector('#detail .verdict .note code')?.textContent ?? null`), '#2', 'modified-click control has a literal verdict code token');
    const verdictHref = await chrome.stable(`${verdictSelector}?.href`);
    assert.equal(new URL(verdictHref).pathname, '/items/2', 'recorded verdict prose exposes its real href');
    for (const input of [{ button: 'middle' }, { modifiers }]) {
      const beforeTargets = (await chrome.send('Target.getTargets')).targetInfos.filter(row => row.type === 'page').map(row => row.targetId).sort();
      await press(chrome, `document.querySelector('#detail .verdict .note code')`, input);
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

test('the snapshot keeps its addresses under a sub-path [N38,A10]', { timeout: 90_000 }, async () => { // budget: hang ceiling for export, replay, click and reload.
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
/** Wait only for the addressed lookup to finish, then inspect the real target and its viewport box. */
async function assertShout(chrome, id, text) {
  await settled(chrome, `${SCRIPT} && !document.querySelector('#shout-address-status')?.textContent.startsWith('Loading')`);
  const result = JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const node=document.getElementById('shout-${id}'), rect=node?.getBoundingClientRect();
    return { text:node?.querySelector('.text')?.textContent ?? null, heading:node?.querySelector('h2')?.textContent ?? null, marked:node?.classList.contains('found') ?? false, top:rect?.top, bottom:rect?.bottom, bar:document.querySelector('.top').getBoundingClientRect().bottom, height:innerHeight };
  })())`));
  assert.equal(result.text, text, 'the addressed shout body is rendered');
  assert.equal(result.heading, `Shout #${id}`, 'the addressed shout has its own heading');
  assert.equal(result.marked, true, 'the addressed shout stays marked');
  assert.ok(result.top >= result.bar && result.bottom <= result.height, `the shout is visible below the tab bar: ${JSON.stringify(result)}`);
}

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

test('a shout address opens an old shout [N38,N26]', { timeout: 180_000 }, async () => { // budget: hang-only ceiling for real writes and both viewport journeys.
  const box = machine(), alpha = addressBoard(box, 'old-shout-alpha');
  box.run(alpha.repo, 'shout', 'person', 'OLD ADDRESSED SHOUT, unique body.');
  await withBrowser(box, async (chrome, server) => {
    const target = (await boardOf(server, alpha.repo)).shouts.find(one => one.shout_text === 'OLD ADDRESSED SHOUT, unique body.');
    assert.ok(target?.shout_id);
    for (let index = 0; index < 46; index += 1) box.run(alpha.repo, 'shout', 'person', `Later shout ${index + 1}.`);
    const state = await boardOf(server, alpha.repo);
    assert.equal(state.shouts.length, 40);
    assert.equal(state.shouts.some(one => one.shout_id === target.shout_id), false, 'the target is outside the actual public state window');
    for (const width of [1280, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await openAddress(chrome, server, `/shouts/${target.shout_id}`);
      await assertPlace(chrome, `/shouts/${target.shout_id}`, 'shouts', alpha.repo);
      await assertShout(chrome, target.shout_id, 'OLD ADDRESSED SHOUT, unique body.');
    }
  });
});

/** Read stable document-space boxes and the accessible heading for one addressed shout. */
async function shoutLayout(chrome, id) {
  return JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const card = document.querySelector('#shout-${id}');
    /** Convert one rendered node to stable document-space geometry. */
    const box = node => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { left: rect.left + scrollX, top: rect.top + scrollY, width: rect.width, height: rect.height };
    };
    const heading = card?.querySelector('h2');
    return { card: box(card), avatar: box(card?.querySelector('.avatar')), text: box(card?.querySelector('.text')), header: box(card?.querySelector('header')),
      heading: heading ? { tag: heading.tagName, text: heading.textContent } : null,
      found: card?.classList.contains('found') ?? false };
  })())`));
}

test('an addressed shout is highlighted without changing its layout [N26,N38]', { timeout: 180_000 }, async (t) => { // budget: hang-only ceiling for four real Chrome viewport and theme checks.
  const box = machine(), alpha = addressBoard(box, 'shout-layout');
  const text = 'Shout whose address must not change its layout.';
  box.run(alpha.repo, 'shout', 'person', text);
  await withBrowser(box, async (chrome, server) => {
    const shout = (await boardOf(server, alpha.repo)).shouts.find(one => one.shout_text === text);
    assert.ok(shout?.shout_id, 'the real board contains the addressed shout');
    for (const scheme of ['light', 'dark']) {
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      assert.equal(await chrome.stable(`matchMedia('(prefers-color-scheme: ${scheme})').matches`), true, `${scheme} media is active`);
      for (const width of [375, 1280]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.waitFor(`innerWidth === ${width}`);
        await openAddress(chrome, server, '/shouts');
        await assertPlace(chrome, '/shouts', 'shouts', alpha.repo);
        await press(chrome, 'document.querySelector(\'[data-shout-thread="none"]\')');
        await settled(chrome, `!!document.querySelector('#shout-${shout.shout_id} .text')`);
        const before = await shoutLayout(chrome, shout.shout_id);
        assert.ok(before.card && before.text && before.header, `${width}px ${scheme}: the opened conversation has its message layout boxes`);
        assert.equal(before.avatar, null, 'the approved conversation has no avatar');
        assert.equal(before.heading, null, `${width}px ${scheme}: the unaddressed shout has no detail heading`);
        await openAddress(chrome, server, `/shouts/${shout.shout_id}`);
        await assertPlace(chrome, `/shouts/${shout.shout_id}`, 'shouts', alpha.repo);
        await assertShout(chrome, shout.shout_id, text);
        const after = await shoutLayout(chrome, shout.shout_id);
        t.diagnostic('515-layout-geometry ' + JSON.stringify({ width, scheme, before, after }));
        assert.equal(after.heading?.tag, 'H2', `${width}px ${scheme}: address keeps its semantic heading`);
        assert.equal(after.heading?.text, `Shout #${shout.shout_id}`, `${width}px ${scheme}: heading names the shout`);
        assert.equal(after.found, true, `${width}px ${scheme}: addressed card is highlighted`);
        assert.deepEqual(after.card, before.card, `${width}px ${scheme}: addressed card keeps its document-space box`);
        assert.equal(after.avatar, null, 'addressing never adds an avatar');
        assert.deepEqual(after.text, before.text, `${width}px ${scheme}: the native message text stays in place`);
        assert.deepEqual(after.header, before.header, `${width}px ${scheme}: header stays in place`);
      }
    }
  });
});

test('grouped repos each get their own address [N38,N26]', { timeout: 180_000 }, async () => { // budget: hang-only ceiling for grouped repo switching and a separate one-repo machine.
  const box = machine(), alpha = addressBoard(box, 'alpha', 'same-suite'), beta = addressBoard(box, 'beta', 'same-suite');
  await withBrowser(box, async (chrome, server) => {
    for (const [repo, name] of [[alpha, 'alpha'], [beta, 'beta']]) {
      for (const [suffix, pane, selector, id, text] of [
        ['/items/1', 'items', '#detail', '#1', `${name} first address item`],
        ['/spec/G2', 'spec', '#spec-detail', 'G2', `${name} distinct specification row`],
        ['/doctrine/PB1', 'doctrine', '#doctrine-detail', 'PB1', `${name} distinct practice rule`],
      ]) {
        await openAddress(chrome, server, `/${name}${suffix}`);
        await assertPlace(chrome, `/${name}${suffix}`, pane, repo.repo);
        await assertHeading(chrome, selector, id, text);
      }
      await onePlace(chrome, 'document.querySelector(\'[data-tab="shouts"]\')', `/${name}/shouts`, 'shouts', repo.repo);
    }
    await openAddress(chrome, server, '/alpha/items/1');
    if (await chrome.stable("getComputedStyle(document.querySelector('#side .side-body')).display === 'none'")) await press(chrome, "document.querySelector('#proj-switch')");
    await onePlace(chrome, 'document.querySelector(\'[data-root="' + beta.repo + '"]\')', '/beta/items', 'items', beta.repo);
    await travel(chrome, -1);
    await settled(chrome, `${SCRIPT} && view.root === ${JSON.stringify(alpha.repo)}`);
    await assertPlace(chrome, '/alpha/items/1', 'items', alpha.repo);
    await assertHeading(chrome, '#detail', '#1', 'alpha first address item');
  });
  const singleBox = machine(), single = addressBoard(singleBox, 'single');
  await withBrowser(singleBox, async (chrome, server) => {
    await openAddress(chrome, server, '/items/1');
    await assertPlace(chrome, '/items/1', 'items', single.repo);
    await assertHeading(chrome, '#detail', '#1', 'single first address item');
    await onePlace(chrome, 'document.querySelector(\'[data-tab="spec"]\')', '/spec', 'spec', single.repo);
    await onePlace(chrome, 'document.querySelector(\'[data-row="spec:G2"]\')', '/spec/G2', 'spec', single.repo);
    await assertHeading(chrome, '#spec-detail', 'G2', 'single distinct specification row');
  });
});


test('an older relay shout keeps its address and explains retained history [N38,H5]', {
  // budget: three fixture work ceilings bound setup, browser pairing and the addressed read; no speed assertion.
  timeout: relayWorkBudgetMs() * 3,
}, async t => {
  const box = await relayClientFixture(t);
  const text = 'OLD RELAY ADDRESS TARGET 187';
  for (let index = 0; index < 46; index += 1) {
    const reply = await box.cli('shout', 'person', index === 0 ? text : `Later relay address shout ${index}`);
    assert.equal(reply.code, 0, 'real CLI appends each fixture shout');
  }
  const exported = await box.cli('export');
  assert.equal(exported.code, 0);
  const target = exported.document.tables.shout.find(one => one.shout_text === text);
  assert.ok(target?.shout_id);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const encoded = readFileSync(box.keyFile, 'utf8').trim();
  const chrome = await stableChrome(await startChrome());
  t.after(() => chrome.close());
  assert.equal((await chrome.send('Network.setCookie', {
    name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  })).success, true, 'the actual paired person session authenticates this browser');
  await chrome.send('Page.navigate', { url: box.origin + '/#board=' + link.board + '&key=' + encoded });
  await settled(chrome, SCRIPT);
  assert.equal(await chrome.stable('location.hash.includes("key=")'), false, 'pairing removes its secret before ordinary address navigation');
  assert.equal(await chrome.stable(`data.project.shouts.some(one => one.shout_id === ${target.shout_id})`), false, 'the old shout is absent from the actual relay state projection');
  const address = '/#shouts/' + target.shout_id;
  await chrome.send('Page.navigate', { url: box.origin + address });
  await settled(chrome, SCRIPT);
  for (let visit = 0; visit < 2; visit += 1) {
    await settled(chrome, `${SCRIPT} && !document.querySelector('#shout-address-status')?.textContent.startsWith('Loading')`);
    await assertPlace(chrome, address, 'shouts', link.board);
    const body = await chrome.stable(`document.querySelector('#feed #shout-${target.shout_id} .text')?.textContent ?? null`);
    if (body === text) await assertShout(chrome, target.shout_id, text);
    else assert.match(await chrome.stable("document.querySelector('#shout-address-status')?.textContent ?? ''"), /older than the relay holds/i,
      'an unsupported old read explains the relay retention limit in the Shouts pane');
    if (visit === 0) {
      const before = await chrome.stable('performance.timeOrigin');
      await chrome.send('Page.reload');
      await settled(chrome, `performance.timeOrigin !== ${before} && ${SCRIPT}`);
    }
  }
});

/** Write a preload that makes every listen fail as a sandbox does, so no real port is touched. */
function sandboxListenStub(dir, code) {
  const file = join(dir, `listen-${code}.mjs`);
  writeFileSync(file, `import { Server } from 'node:net';
Server.prototype.listen = function (port, host) {
  const error = Object.assign(new Error(\`listen ${code}: operation not permitted \${host}:\${port}\`), { code: '${code}', errno: -1, syscall: 'listen', address: host, port });
  process.nextTick(() => this.emit('error', error));
  return this;
};
`);
  return file;
}

test('a sandbox-blocked view port names the fix [I1,L3,P4]', { timeout: 120_000 }, async (t) => { // budget: hang ceiling for six short CLI refusals.
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-view-sandbox-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const port = await chooseViewPort();
  const terminal = 'or start pullboard view from a normal terminal';
  const harnesses = [
    { name: 'Claude Code', env: { CLAUDECODE: '1' },
      next: `allow local network for Claude Code: set sandbox.network.allowLocalBinding to true in .claude/settings.json, ${terminal}` },
    { name: 'Codex', env: { CODEX_SANDBOX: 'seatbelt' },
      next: `allow local network for Codex in its sandbox settings in ~/.codex/config.toml, ${terminal}` },
    { name: 'another agent tool', env: {},
      next: `allow local network in your agent tool's sandbox settings, ${terminal}` },
  ];
  // The view's own refusal, in process: the stub replaces listen only for this call.
  const { serveView } = await import('../../apps/cli/src/shell/commands/view.js');
  const { Server } = await import('node:net');
  const listen = Server.prototype.listen;
  const saved = { CLAUDECODE: process.env.CLAUDECODE, CODEX_SANDBOX: process.env.CODEX_SANDBOX, CODEX_SANDBOX_NETWORK_DISABLED: process.env.CODEX_SANDBOX_NETWORK_DISABLED };
  t.after(() => { Server.prototype.listen = listen; for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : process.env[name] = value; });
  for (const code of ['EPERM', 'EACCES']) {
    Server.prototype.listen = function (asked, host) {
      process.nextTick(() => this.emit('error', Object.assign(new Error(`listen ${code}: operation not permitted ${host}:${asked}`), { code, syscall: 'listen' })));
      return this;
    };
    for (const name of Object.keys(saved)) delete process.env[name];
    process.env.CLAUDECODE = '1';
    await assert.rejects(serveView({ port, runCommand: nativeTestMain }), (error) => {
      assert.equal(error.code, 'SANDBOX_BLOCKED');
      assert.equal(error.message, `[SANDBOX_BLOCKED] the sandbox around this command refused to let pullboard view listen on 127.0.0.1:${port} (${code})\nnext: ${harnesses[0].next}`);
      return true;
    });
  }
  Server.prototype.listen = listen;

  // The CLI, in the background launch an agent gets and in the foreground, plain and --json.
  const stub = sandboxListenStub(dir, 'EPERM');
  for (const harness of harnesses) {
    for (const foreground of [false, true]) {
      const env = { ...process.env, HOME: join(dir, 'home'), PULLBOARD_HOME: join(dir, 'home', '.pullboard'),
        PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'), PULLBOARD_VIEW_PORT: String(port),
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', NODE_OPTIONS: `--import=${pathToFileURL(stub).href}`, ...harness.env };
      for (const name of ['CLAUDECODE', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'AI_AGENT', 'PULLBOARD_VIEW_FOREGROUND']) if (!(name in harness.env)) delete env[name];
      if (foreground) env.PULLBOARD_VIEW_FOREGROUND = '1';
      const run = (...extra) => runFixtureChild(process.execPath, [BIN, 'view', '--no-open', ...extra], { cwd: dir, env, encoding: 'utf8', timeout: 40_000 });
      const where = `${harness.name}, ${foreground ? 'foreground' : 'background'}`;
      const plain = run();
      assert.equal(plain.status, 1, `${where}: ${plain.failure ?? plain.stderr}`);
      const json = run('--json');
      assert.equal(json.status, 1, `${where}: ${json.failure ?? json.stderr}`);
      const refusal = JSON.parse(json.stdout).error;
      assert.equal(refusal.code, 'SANDBOX_BLOCKED', where);
      assert.equal(refusal.next, harness.next, `${where}: the step names the fix for this harness`);
      assert.equal(plain.stderr.trim(), `pullboard: [SANDBOX_BLOCKED] the sandbox around this command refused to let pullboard view listen on 127.0.0.1:${port} (EPERM)\nnext: ${harness.next}`, where);
      for (const text of [plain.stderr, json.stdout]) assert.doesNotMatch(text, /service owner/iu, `${where}: the step points somewhere real`);
    }
  }
});
