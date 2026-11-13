// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** Cockpit activity checks, "lifecycle" group, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  createServer,
} from 'node:http';
import {
  join,
} from 'node:path';
import {
  test,
} from 'node:test';
import {
  IN_STATE,
  MACHINE,
  effectiveGuards,
} from '../../../../../packages/state/index.js';
import {
  machine,
  project,
  build,
  sendBack,
  startView,
  styleOf,
  element,
  storage,
  openPage,
  drawing,
  textBoxes,
  meet,
  accept,
} from '../../../tests/fixtures/cockpit/harness.js';

const verifiedIsFinal = Boolean(MACHINE.states.find((state) => state.id === 'verified').final);

test('the activity tab draws the lifecycle from the declaration, as the README does, with live counts [N26, M1]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  for (const title of ['Greeting', 'Farewell', 'Header', 'Footer', 'Sidebar', 'Banner', 'Menu', 'Search']) await box.inProcess(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  build(box, alpha, 1, 'greeting.html');
  accept(box, alpha, 1);
  build(box, alpha, 2, 'farewell.html');
  sendBack(box, alpha, 2, 'no farewell');
  // Withdrawn from claimed twice, from submitted once and from open once, so each route has its count.
  for (const id of ['6', '8']) {
    await box.inProcess(alpha.web, 'claim', id);
    await box.inProcess(alpha.repo, 'withdraw', id, 'not this release');
  }
  build(box, alpha, 7, 'menu.html');
  await box.inProcess(alpha.repo, 'withdraw', '7', 'the menu moved to the next release');
  await box.inProcess(alpha.web, 'claim', '3');
  await box.inProcess(alpha.web, 'claim', '3');
  await box.inProcess(alpha.repo, 'withdraw', '4', 'the footer moved to the next release');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    assert.doesNotMatch(page.html, /id="metrics"/, 'the drawing replaces the metric cards');
    assert.ok(!page.html.includes('pullboard claim <id>'), 'the declaration is embedded with < escaped');
    await page.click({ tab: 'activity' });
    const svg = page.run('flowSvg(data.project)');
    const { boxes, routes, sentBack } = drawing(svg);

    const esc = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    assert.deepEqual(boxes.map((entry) => entry.state), MACHINE.states.map((state) => state.id), 'a box for every declared state');
    for (const state of MACHINE.states) assert.ok(boxes.find((entry) => entry.state === state.id).title.startsWith(esc(`${state.id}: ${state.means}`)), `${state.id} says what it means`);
    assert.match(boxes.find((entry) => entry.state === 'verified').title, /Every way in checks:\n {2}the caller&#39;s checkout contains the submitted commit\n {2}the decision’s verifier did not build it, and its agent session did not build or submit it under any seat/);
    assert.deepEqual(Object.fromEntries(boxes.map((entry) => [entry.state, entry.count])), { open: 2, claimed: 1, submitted: 0, verified: 1, withdrawn: 4 });
    assert.equal(sentBack, '1 sent back');
    assert.deepEqual(boxes.filter((entry) => entry.double).map((entry) => entry.state), MACHINE.states.filter((state) => state.final).map((state) => state.id), 'a final state has a double border');

    // The moves that keep a state are written in its box, not drawn as loops.
    const keeping = MACHINE.states.filter((state) => MACHINE.moves.some((move) => move.to === state.id && move.from.includes(state.id))).map((state) => state.id);
    assert.deepEqual(Object.fromEntries(boxes.filter((entry) => entry.keeps).map((entry) => [entry.state, entry.keeps])), {
      open: '↻ release · escalate · refreeze (none yet)',
      claimed: '↻ claim 1',
      submitted: '↻ patch · reserve (none yet)',
      verified: '↻ accept (none yet)',
    });
    assert.deepEqual(boxes.filter((entry) => entry.keeps).map((entry) => entry.state), keeping, 'each state a move keeps');

    const pairs = new Set(MACHINE.moves.flatMap((move) => move.from.filter((from) => from !== move.to).map((from) => `${from}>${move.to}`)));
    assert.deepEqual(routes.map((route) => route.pair).sort(), [...pairs].sort(), 'one route per pair of states a move joins');
    for (const move of MACHINE.moves) {
      for (const from of move.from.filter((from) => from !== move.to)) assert.ok(routes.find((route) => route.pair === `${from}>${move.to}`).title.includes(`${move.verb}, ${from} to ${move.to}, by the ${move.by.join(' or ')}: `), `${move.verb} from ${from} is on its route`);
    }
    const claimMove = MACHINE.moves.find((move) => move.verb === 'claim');
    assert.ok(claimMove, 'the claim move is declared');
    const claimChecks = effectiveGuards(claimMove).map((id) => {
      if (id === IN_STATE) return `the item is ${claimMove.from.join(' or ')} (${claimMove.refuse})`;
      const guard = MACHINE.guards.find((entry) => entry.id === id);
      assert.ok(guard, `${id} is a declared guard`);
      return `${guard.rule} (${guard.refuse})`;
    });
    assert.ok(routes.some((route) => route.title.includes(`claim, open to claimed, by the agent or coordinator: pullboard claim &lt;id&gt;. Made 6 times.\nChecks, in order:\n  ${claimChecks.map(esc).join('\n  ')}`)), 'each check in order, escaped');
    // The moves made along a route and how often, or its moves when none was; the routes into the
    // state below the row join into one, labelled once with their total.
    // Each declared route retains its own move label and observed count.
    assert.deepEqual(Object.fromEntries(routes.map((route) => [route.pair, route.label])), {
      'open>claimed': 'claim 6',
      'claimed>open': 'patch-objected · release · lapse · escalate · refreeze (none yet)',
      'claimed>submitted': 'submit 3',
      'claimed>verified': 'submit-merge (none yet)',
      'open>verified': 'rehomeImport (none yet)',
      'open>submitted': 'intake (none yet)',
      'submitted>verified': 'accept 1',
      'verified>submitted': 'patch (none yet)',
      'submitted>open': 'reject 1',
      'open>withdrawn': verifiedIsFinal ? 'withdraw 4' : 'withdraw 1',
      'claimed>withdrawn': verifiedIsFinal ? null : 'withdraw 2',
      'submitted>withdrawn': verifiedIsFinal ? null : 'withdraw 1',
      ...(!verifiedIsFinal ? { 'verified>open': 'reject · reopen · refreeze (none yet)' } : {}),
    });

    // Every route is square, and the ones back to an earlier state are dashed, each at its own height.
    for (const route of routes) {
      route.points.slice(1).forEach(([x, y], n) => assert.ok(x === route.points[n][0] || y === route.points[n][1], `${route.pair} runs square: ${JSON.stringify(route.points)}`));
    }
    const backs = routes.filter((route) => route.back);
    const row = ['open', 'claimed', 'verified', 'submitted', 'withdrawn'];
    const rowBoxes = [...svg.matchAll(/<g class="s-([^"]+)"><title>[^<]*<\/title><rect class="box" x="([\d.]+)" y="([\d.]+)"/g)]
      .map(([, state, x, y]) => ({ state, x: Number(x), y: Number(y) }));
    assert.deepEqual(rowBoxes.toSorted((a, b) => a.x - b.x).map((box) => box.state), row,
      'the declared longest path orders every state on the main row');
    assert.equal(new Set(rowBoxes.map((box) => box.y)).size, 1, 'all main-row boxes align');
    assert.deepEqual(backs.map((route) => route.pair).sort(),
      ['claimed>open', 'submitted>open', 'submitted>verified', 'verified>open'],
      'every return to an earlier main-row state is dashed');
    const lanes = backs.map((route) => {
      const [from, to] = route.pair.split('>');
      return { span: row.indexOf(from) - row.indexOf(to), y: route.points[1][1] };
    });
    for (const one of lanes) for (const other of lanes) {
      if (one.span === other.span) assert.equal(one.y, other.y, 'equal-span returns share their declared level');
      else if (one.span > other.span) assert.ok(one.y < other.y, 'longer returns clear shorter return levels');
    }
    assert.match(await styleOf(view), /\n\.flow \.edge\.back \{ stroke: var\(--mark-back\); stroke-dasharray: 5 4; \}/, 'dashed');

    // No word comes within two units of another, a box it is not in, or a route.
    const texts = textBoxes(svg);
    const rects = [...svg.matchAll(/<rect class="box" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)].map(([, x, y, w, h]) => ({ left: Number(x), top: Number(y), right: Number(x) + Number(w), bottom: Number(y) + Number(h) }));
    const segments = routes.flatMap((route) => route.points.slice(1).map(([x, y], n) => ({ left: Math.min(x, route.points[n][0]), right: Math.max(x, route.points[n][0]) + 0.01, top: Math.min(y, route.points[n][1]), bottom: Math.max(y, route.points[n][1]) + 0.01 })));
    if (!verifiedIsFinal) {
      const verifiedReturn = routes.find((route) => route.pair === 'verified>open');
      assert.ok(verifiedReturn, 'the non-final verified state has a route back to open');
      assert.equal(verifiedReturn.label, 'reject · reopen · refreeze (none yet)', 'the verified return route carries its label');
      assert.equal(verifiedReturn.back, true, 'the main-row verified return is an above-row back route');
      assert.equal(verifiedReturn.points[1][1], verifiedReturn.points[2][1], 'the verified return runs through a horizontal back lane');
      assert.ok(verifiedReturn.points[1][1] < Math.min(...rects.map((rect) => rect.top)) - 2, 'the back lane clears every state box');
    }
    texts.forEach((one, n) => {
      for (const other of texts.slice(n + 1)) assert.ok(!meet(one, other, 2), `"${one.words}" and "${other.words}" overlap`);
      const home = rects.filter((rect) => meet(one, rect, one.inside ? 0 : 2));
      assert.deepEqual(home.length, one.inside ? 1 : 0, `"${one.words}" sits ${one.inside ? 'in its box' : 'clear of every box'}`);
      if (one.inside) assert.ok(one.left >= home[0].left && one.right <= home[0].right && one.top >= home[0].top && one.bottom <= home[0].bottom, `"${one.words}" fits inside its box`);
      for (const segment of segments) assert.ok(!meet(one, segment, 2), `"${one.words}" is clear of every route`);
    });

    // The clock's lapse is never logged: an item that reads open after its claim, and a claim logged
    // on an item the replay holds claimed, each mean the clock moved first.
    const counts = JSON.parse(page.run(`JSON.stringify([...moveCounts([
      { status: 'open', history: [{ kind: 'add' }, { kind: 'claim' }] },
      { status: 'claimed', history: [{ kind: 'add' }, { kind: 'claim' }, { kind: 'renew' }, { kind: 'claim' }] },
    ])])`));
    assert.deepEqual(counts, [['open>claimed:claim', 3], ['claimed>open:lapse', 2], ['claimed>claimed:claim', 1]]);
  } finally {
    await view.stop();
  }
});

test('a closed lifecycle stays closed, across a reload and a restart of the view [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  const first = await startView(box);
  const store = storage();
  let port;
  try {
    port = first.link.port;
    const page = await openPage(first, { store });
    await page.click({ tab: 'activity' });
    assert.equal(page.element('flow-panel').hidden, true, 'Activity starts with its feed');
    assert.equal(page.element('flow').writes, 0, 'the default-hidden chart is not rendered');
    await page.fire('flow-show', 'click');
    assert.equal(page.element('flow-panel').hidden, false, 'the ghost button opens the chart');
    await page.fire('flow-show', 'click');
    assert.equal(page.element('flow-panel').hidden, true, 'the same ghost button closes it');

    const reloaded = await openPage(first, { store });
    assert.equal(reloaded.element('flow-panel').hidden, true, 'a reload keeps it closed');
    assert.equal(reloaded.element('flow').writes, 0, 'and a closed figure is not drawn');
  } finally {
    await first.stop();
  }
  // The browser keeps the choice per address, so the view comes back on the port it last used.
  const second = await startView(box);
  try {
    assert.equal(second.link.port, port, 'a restarted view serves from the same port, where the browser kept the choice');
    const page = await openPage(second, { store });
    assert.equal(page.element('flow-panel').hidden, true, 'still closed');
    await page.fire('flow-show', 'click');
    assert.equal(page.element('flow-panel').hidden, false, 'shown again on request');
    assert.match(page.show('flow'), /^<svg /, 'and drawn');
    assert.equal(store.getItem('pb.flow'), 'shown');
  } finally {
    await second.stop();
  }
  // With its last port taken, the view takes any free one rather than failing.
  const taken = await new Promise((done) => { const server = createServer(); server.listen(Number(port), '127.0.0.1', () => done(server)); });
  try {
    const third = await startView(box);
    try {
      assert.notEqual(third.link.port, port, 'a busy port is passed over');
    } finally {
      await third.stop();
    }
  } finally {
    await new Promise((done) => taken.close(done));
  }
});
