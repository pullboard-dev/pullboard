/** @pullboard-test-gui */
/** Cockpit activity checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IN_STATE, MACHINE, effectiveGuards } from '../../src/machine.js';
import { cockpitPage } from '../../src/cockpit.js';
import { machine, project, build, sendBack, fetchLive, startView, styleOf, element, storage, openPage, timelineRows, agentEntries, drawing, textBoxes, meet, accept, itemRow, chromeExecutable, openSnapshotChrome, closeSnapshotChrome } from './fixture.js';

const verifiedIsFinal = Boolean(MACHINE.states.find((state) => state.id === 'verified').final);


/** Verify a verified stay ends at its next state move, while a quiet merge remains untimed. */
test('the timeline times a verified item that goes back to open [N26, M1]', async () => {
  const box = machine();
  project(box, 'alpha');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const history = [
      ['add', '2026-10-12T12:00:00.000Z'],
      ['claim', '2026-10-12T12:01:00.000Z'],
      ['submit', '2026-10-12T12:02:00.000Z'],
      ['accept', '2026-10-12T12:03:00.000Z'],
      ['merged', '2026-10-12T12:03:30.000Z'],
      ['reopen', '2026-10-12T12:05:00.000Z'],
    ].map(([kind, at]) => ({ kind, by: 'coordinator', at }));
    const rendered = JSON.parse(page.run(`(() => {
      FLOW.moves.push({ verb: 'reopen', from: ['verified'], to: 'open', by: ['coordinator'], how: 'pullboard reopen <id>', checks: [] });
      const item = ${JSON.stringify({ status: 'open', history })};
      const finalVerified = timeline(item);
      FLOW.states.find((state) => state.id === 'verified').final = false;
      return JSON.stringify([finalVerified, timeline(item)]);
    })()`));
    const [finalRows, nonFinalRows] = rendered.map(timelineRows);
    for (const rows of [finalRows, nonFinalRows]) {
      assert.equal(rows.find((row) => row.event.startsWith('accept ')).stay, 'verified for 2m');
      assert.equal(rows.find((row) => row.event.startsWith('merged ')).stay, '', 'a quiet event does not end the verified stay');
      assert.equal(rows.find((row) => row.event.startsWith('reopen ')).dot, 'tl-open');
    }
  } finally {
    await view.stop();
  }
});

/** Verify a fixture lifecycle draws and labels an outgoing route from a below-row state. */
test('the activity lifecycle draws a move out of a state below the row [N26, M1]', async () => {
  const box = machine();
  project(box, 'alpha');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const fixture = {
      initial: 'open',
      states: [
        { id: 'open', means: 'waiting', final: false, entry: [] },
        { id: 'claimed', means: 'building', final: false, entry: [] },
        { id: 'submitted', means: 'waiting for review', final: false, entry: [] },
        { id: 'verified', means: 'accepted', final: false, entry: [] },
        { id: 'withdrawn', means: 'closed', final: true, entry: [] },
        { id: 'deferred', means: 'waiting for another decision', final: false, entry: [] },
      ],
      moves: [
        { verb: 'claim', from: ['open'], to: 'claimed', by: ['agent'], how: 'claim', checks: [] },
        { verb: 'submit', from: ['claimed'], to: 'submitted', by: ['agent'], how: 'submit', checks: [] },
        { verb: 'accept', from: ['submitted'], to: 'verified', by: ['coordinator'], how: 'accept', checks: [] },
        { verb: 'withdraw', from: ['submitted'], to: 'withdrawn', by: ['coordinator'], how: 'withdraw', checks: [] },
        { verb: 'reopen', from: ['verified'], to: 'open', by: ['coordinator'], how: 'reopen', checks: [] },
        { verb: 'pause', from: ['open'], to: 'deferred', by: ['coordinator'], how: 'pause', checks: [] },
        { verb: 'resume', from: ['deferred'], to: 'verified', by: ['coordinator'], how: 'resume', checks: [] },
      ],
    };
    const svg = page.run(`(() => {
      FLOW.initial = ${JSON.stringify(fixture.initial)};
      FLOW.states.splice(0, FLOW.states.length, ...${JSON.stringify(fixture.states)});
      FLOW.moves.splice(0, FLOW.moves.length, ...${JSON.stringify(fixture.moves)});
      return flowSvg(data.project);
    })()`);
    const diagram = drawing(svg);
    const route = diagram.routes.find((entry) => entry.pair === 'verified>open');
    assert.ok(route, 'the fixture machine declares verified > open');
    assert.equal(route.label, 'reopen (none yet)');
    assert.ok(route.points.length >= 4, 'the outgoing route has a path from the below-row state to open');
    const pairs = fixture.moves.flatMap((move) => move.from.map((from) => `${from}>${move.to}`));
    assert.deepEqual(diagram.routes.map((entry) => entry.pair).sort(), pairs.sort(),
      'each move pair is drawn once, including between two below-row states');
    /** Read a fixture state's box top to verify the selected longest path stays above it. */
    const stateY = (state) => Number(new RegExp(`<g class="s-${state}"><title>[\\s\\S]*?<rect class="box" x="[\\d.]+" y="([\\d.]+)"`).exec(svg)?.[1]);
    assert.ok(stateY('verified') > stateY('open'), 'verified is below the longest path to a final state');
    assert.equal(stateY('deferred'), stateY('verified'), 'the fixture also includes a move between below-row states');
    const segments = diagram.routes.flatMap((entry) => entry.points.slice(1).map(([x, y], index) => ({
      left: Math.min(x, entry.points[index][0]),
      right: Math.max(x, entry.points[index][0]) + 0.01,
      top: Math.min(y, entry.points[index][1]),
      bottom: Math.max(y, entry.points[index][1]) + 0.01,
    })));
    for (const words of ['reopen', 'resume']) {
      const label = textBoxes(svg).find((entry) => entry.words === words);
      assert.ok(label, `${words}: the outgoing move is labelled`);
      assert.ok(segments.every((segment) => !meet(label, segment, 2)), `${words}: its label clears every route`);
    }
  } finally {
    await view.stop();
  }
});


test("the history is a timeline of the item's states [N26]", async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  build(box, alpha, 1, 'greeting.html');
  sendBack(box, alpha, 1, 'no greeting');
  build(box, alpha, 1, 'greeting-again.html');
  accept(box, alpha, 1);
  box.git(alpha.repo, 'merge', '--no-ff', '-m', 'chore: merge fixture item', alpha.branch);
  const trunkCommit = box.git(alpha.repo, 'rev-parse', 'HEAD');
  assert.notEqual(trunkCommit, box.git(alpha.repo, 'rev-parse', alpha.branch), 'the receipt names the trunk merge commit');
  box.run(alpha.repo, 'merged', '1', trunkCommit);
  box.run(alpha.web, 'claim', '2');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ go: 'item:1' });
    const done = timelineRows(page.show('detail'));
    assert.deepEqual(done.map((row) => [row.dot, row.event]), [
      ['tl-open', 'add coordinator (unknown)'],
      ['tl-claimed', 'claim web-1 (Test Model)'],
      ['tl-claimed tl-quiet', 'proof-run web-1 (Test Model)'],
      ['tl-submitted', 'submit web-1 (Test Model)'],
      ['tl-open tl-back', 'reject coordinator (unknown)'],
      ['tl-claimed', 'claim web-1 (Test Model)'],
      ['tl-claimed tl-quiet', 'proof-run web-1 (Test Model)'],
      ['tl-submitted', 'submit web-1 (Test Model)'],
      ['tl-verified', 'accept coordinator (unknown)'],
      ['tl-verified tl-quiet', 'merged coordinator (unknown)'],
    ], 'a dot per event in the colour of the state it led to; a merge moves nothing');
    assert.deepEqual(done.map((row) => row.stay.replace(/ for .*/, ' for')), ['open for', 'claimed for', '', 'submitted for', 'sent back for', 'claimed for', '', 'submitted for', verifiedIsFinal ? '' : 'verified for', ''], 'each stay until the next move; a final state has none and quiet proof receipts and merge stay untimed');
    assert.ok(done.filter(row => !row.dot.includes('tl-quiet')).slice(0, 6).every((row) => / for (under a minute|\d+m)$/.test(row.stay)), done.map((row) => row.stay).join(', '));
    assert.ok(done.every((row) => /^\d\d:\d\d$/.test(row.time)), 'every event keeps its time');

    await page.click({ go: 'item:2' });
    assert.deepEqual(timelineRows(page.show('detail')).map((row) => [row.dot, row.stay]).slice(1), [['tl-claimed', 'claimed for now so far']]);
    const later = await openPage(view, { later: 1 });
    await later.click({ go: 'item:2' });
    assert.deepEqual(timelineRows(later.show('detail')).map((row) => row.stay).slice(1), ['claimed for 24h so far'], 'the stay so far counts on');

    // A claim logged on an item the replay holds claimed: the clock lapsed the first claim between.
    const at = (minute) => new Date(Date.UTC(2026, 9, 6, 12, minute)).toISOString();
    const item = { status: 'claimed', history: [{ kind: 'add', by: 'web-1', at: at(0) }, { kind: 'claim', by: 'web-1', at: at(5) }, { kind: 'claim', by: 'web-2', at: at(200) }] };
    const lapsed = timelineRows(page.run(`timeline(${JSON.stringify(item)})`));
    assert.deepEqual(lapsed.map((row) => [row.dot, row.event, row.time === '']), [
      ['tl-open', 'add web-1 (Test Model)', false],
      ['tl-claimed', 'claim web-1 (Test Model)', false],
      ['tl-open', 'lapse the clock', true],
      ['tl-claimed', 'claim web-2', false],
    ]);
    assert.deepEqual(lapsed.map((row) => row.stay.replace(/ for .*/, ' for')), [
      'open for',
      'claimed until the lapse, length not logged',
      'open after the lapse, length not logged',
      'claimed for',
    ], 'a stay that ends or begins at an untimed lapse says its length was not logged');
    assert.equal(lapsed[0].stay, 'open for 5m');

    // A lease that ran out with nothing after it: the item reads open, and has been since the lapse.
    const idle = { status: 'open', history: [{ kind: 'add', by: 'web-1', at: at(0) }, { kind: 'claim', by: 'web-1', at: at(5) }] };
    assert.deepEqual(timelineRows(page.run(`timeline(${JSON.stringify(idle)})`)).map((row) => [row.event, row.stay]), [
      ['add web-1 (Test Model)', 'open for 5m'],
      ['claim web-1 (Test Model)', 'claimed until the lapse, length not logged'],
      ['lapse the clock', 'open so far since the lapse, length not logged'],
    ]);
  } finally {
    await view.stop();
  }
});

test('the activity tab draws the lifecycle from the declaration, as the README does, with live counts [N26, M1]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  for (const title of ['Greeting', 'Farewell', 'Header', 'Footer', 'Sidebar', 'Banner', 'Menu', 'Search']) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  build(box, alpha, 1, 'greeting.html');
  accept(box, alpha, 1);
  build(box, alpha, 2, 'farewell.html');
  sendBack(box, alpha, 2, 'no farewell');
  // Withdrawn from claimed twice, from submitted once and from open once, so each route has its count.
  for (const id of ['6', '8']) {
    box.run(alpha.web, 'claim', id);
    box.run(alpha.repo, 'withdraw', id, 'not this release');
  }
  build(box, alpha, 7, 'menu.html');
  box.run(alpha.repo, 'withdraw', '7', 'the menu moved to the next release');
  box.run(alpha.web, 'claim', '3');
  box.run(alpha.web, 'claim', '3');
  box.run(alpha.repo, 'withdraw', '4', 'the footer moved to the next release');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    assert.doesNotMatch(page.html, /id="metrics"/, 'the drawing replaces the metric cards');
    assert.ok(!page.html.includes('pullboard claim <id>'), 'the declaration is embedded with < escaped');
    const svg = page.show('flow');
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
      submitted: '↻ reserve (none yet)',
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
    // The claimed-to-verified shortcut carries the ordinary routes' shared accept count;
    // an unused import-only route cannot take that label. Each title still pins its own verb.
    assert.deepEqual(Object.fromEntries(routes.map((route) => [route.pair, route.label])), {
      'open>claimed': 'claim 6',
      'claimed>open': 'release · lapse · escalate · refreeze (none yet)',
      'claimed>submitted': 'submit 3',
      'claimed>verified': 'accept 1',
      'open>verified': null,
      'open>submitted': 'intake (none yet)',
      'submitted>verified': null,
      'submitted>open': 'reject 1',
      'open>withdrawn': verifiedIsFinal ? 'withdraw 4' : 'withdraw 1',
      'claimed>withdrawn': verifiedIsFinal ? null : 'withdraw 2',
      'submitted>withdrawn': verifiedIsFinal ? null : 'withdraw 1',
      ...(!verifiedIsFinal ? { 'verified>open': 'reject · reopen (none yet)' } : {}),
    });

    // Every route is square, and the ones back to an earlier state are dashed, each at its own height.
    for (const route of routes) {
      route.points.slice(1).forEach(([x, y], n) => assert.ok(x === route.points[n][0] || y === route.points[n][1], `${route.pair} runs square: ${JSON.stringify(route.points)}`));
    }
    const backs = routes.filter((route) => route.back);
    assert.deepEqual(backs.map((route) => route.pair).sort(), ['claimed>open', 'submitted>open'], 'the routes back are the ones to an earlier state');
    assert.equal(new Set(backs.map((route) => route.points[1][1])).size, backs.length, 'each at its own height');
    assert.match(await styleOf(view), /\n\.flow \.edge\.back \{ stroke: var\(--reject\); stroke-dasharray: 5 4; \}/, 'dashed');

    // No word comes within two units of another, a box it is not in, or a route.
    const texts = textBoxes(svg);
    const rects = [...svg.matchAll(/<rect class="box" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)].map(([, x, y, w, h]) => ({ left: Number(x), top: Number(y), right: Number(x) + Number(w), bottom: Number(y) + Number(h) }));
    const segments = routes.flatMap((route) => route.points.slice(1).map(([x, y], n) => ({ left: Math.min(x, route.points[n][0]), right: Math.max(x, route.points[n][0]) + 0.01, top: Math.min(y, route.points[n][1]), bottom: Math.max(y, route.points[n][1]) + 0.01 })));
    if (!verifiedIsFinal) {
      const verifiedReturn = routes.find((route) => route.pair === 'verified>open');
      assert.ok(verifiedReturn, 'the non-final verified state has a route back to open');
      assert.equal(verifiedReturn.label, 'reject · reopen (none yet)', 'the verified return route carries its label');
      assert.equal(verifiedReturn.back, false, 'the lower-lane return is not an above-row back route');
      assert.equal(verifiedReturn.points[1][1], verifiedReturn.points[2][1], 'the verified return runs through a horizontal lower lane');
      assert.ok(verifiedReturn.points[1][1] > Math.max(...rects.map((rect) => rect.bottom)), 'the lower lane clears every state box');
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
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  const first = await startView(box);
  const store = storage();
  let port;
  try {
    port = first.link.port;
    const page = await openPage(first, { store });
    await page.click({ tab: 'activity' });
    assert.match(page.show('flow'), /^<svg /, 'the figure shows at first');
    assert.deepEqual([page.element('flow-panel').hidden, page.element('flow-show').hidden], [false, true]);
    await page.fire('flow-hide', 'click');
    assert.deepEqual([page.element('flow-panel').hidden, page.element('flow-show').hidden], [true, false], 'closed, with a way to show it again');

    const reloaded = await openPage(first, { store });
    assert.deepEqual([reloaded.element('flow-panel').hidden, reloaded.element('flow-show').hidden], [true, false], 'a reload keeps it closed');
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
    assert.deepEqual([page.element('flow-panel').hidden, page.element('flow-show').hidden], [false, true], 'shown again on request');
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
test('ages stay true while the board is quiet [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'greeting.html');
  box.run(alpha.repo, 'shout', 'person', 'Ship the greeting today?', '--decision');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const ages = () => ({
      row: /<time data-ago="[^"]+">([^<]*)<\/time>/.exec(itemRow(page.show('chain'), 1))?.[1],
      needs: /data-go="decide:[^"]*"[^]*?<span class="row-age"><time data-ago="[^"]+">([^<]*)<\/time>/.exec(page.show('needs'))?.[1],
      agent: agentEntries(page.show('agents')).find((agent) => agent.id === 'web-1')?.age,
      shout: /<time class="long" data-ago="[^"]+" title="[^"]*">([^<]*)<\/time>/.exec(page.show('feed'))?.[1],
    });
    assert.deepEqual(ages(), { row: 'now', needs: 'now', agent: 'now', shout: 'now' });
    const rebuilds = () => ['chain', 'needs', 'agents', 'feed'].map((id) => page.element(id).writes);
    const before = rebuilds();

    // Three hours pass, nothing on the board changes, and the minute timer fires.
    page.run('const D = Date; globalThis.Date = class extends D { constructor(...a) { super(...(a.length ? a : [D.now() + 3 * 3600e3])); } static now() { return D.now() + 3 * 3600e3; } };');
    page.run('tickAges()');
    assert.deepEqual(ages(), { row: '3h', needs: '3h', agent: '3h', shout: '3h ago' }, 'a shout says how long ago in words');
    assert.deepEqual(rebuilds(), before, 'each age moved where it stands; nothing was rebuilt');
  } finally {
    await view.stop();
  }
});
test('times say which day they were [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'greeting.html');
  box.run(alpha.repo, 'shout', 'web', '#1 is in');
  const view = await startView(box);
  try {
    const days = (html) => [...html.matchAll(/<h4 class="day">([^<]*)<\/h4>|<div class="day-rule" role="separator"><span>([^<]*)<\/span><\/div>/g)].map((match) => match[1] ?? match[2]);
    // A shout says how long ago it was, with its clock time on hover.
    const ages = (html) => [...html.matchAll(/<time class="long" data-ago="[^"]+" title="([^"]*)">([^<]*)<\/time>/g)].map((match) => [match[2], match[1]]);
    const times = (html) => [...html.matchAll(/<time>([^<]*)<\/time>/g)].map((match) => match[1]);
    const bare = (list) => list.length > 0 && list.every((time) => /^\d\d:\d\d$/.test(time));

    const now = await openPage(view);
    assert.deepEqual([days(now.show('feed')), days(now.show('activity'))], [[], ['Today']], 'shouts from today need no rule above them');
    assert.deepEqual(ages(now.show('feed')).map(([age, clock]) => [age, /^\d\d:\d\d$/.test(clock)]), [['now', true]], 'a shout from today says now, its clock time on hover');
    assert.ok(bare(times(now.show('detail'))), 'a history from today shows bare times');

    const tomorrow = await openPage(view, { later: 1 });
    assert.deepEqual([days(tomorrow.show('feed')), days(tomorrow.show('activity'))], [['Yesterday'], ['Yesterday']]);

    const weekday = new Date().toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    const date = new Date().toLocaleDateString([], { month: 'short', day: 'numeric' });
    const later = await openPage(view, { later: 2 });
    assert.deepEqual([days(later.show('feed')), days(later.show('activity'))], [[weekday], [weekday]], 'two days on, the feeds name the day');
    assert.ok(bare(times(later.show('activity'))), 'activity rows keep the clock time');
    assert.deepEqual(ages(later.show('feed')).map(([age, clock]) => [age, new RegExp(`^${date} \\d\\d:\\d\\d$`).test(clock)]), [['2d ago', true]], 'a shout says how long ago, with its date and time on hover');
    const history = times(later.show('detail'));
    assert.ok(history.length === 4 && history.every((time) => new RegExp(`^${date} \\d\\d:\\d\\d$`).test(time)), `the history dates every move including its proof receipt: ${history}`);

    // A heading wherever the day changes, and only there.
    const at = (day, hour) => new Date(2026, 9, day, hour).toISOString();
    const rows = JSON.stringify([at(6, 15), at(6, 9), at(5, 20), at(3, 12)].map((iso) => ({ iso })));
    const html = now.run(`byDay(${rows}, (x) => x.iso, () => '<div></div>')`);
    assert.equal(html.replace(/<h4 class="day">[^<]*<\/h4>/g, 'H').replaceAll('<div></div>', 'r'), 'HrrHrHr');
    // Shouts get a rule only where the day changes, and none above today's.
    const rule = (list) => now.run(`dayRules(${JSON.stringify(list.map((iso) => ({ iso })))}, (x) => x.iso, () => '<div></div>')`).replace(/<div class="day-rule" role="separator"><span>[^<]*<\/span><\/div>/g, 'H').replaceAll('<div></div>', 'r');
    assert.equal(rule([at(6, 15), at(6, 9), at(5, 20), at(3, 12)]), 'HrrHrHr', 'an older first day still gets its rule');
    assert.equal(rule([new Date().toISOString(), at(6, 9)]), 'rHr', 'today has no rule; the first earlier day does');
  } finally {
    await view.stop();
  }
});
test('activity rows say what each shout and answer said [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for activity checks.');

  const box = machine();
  const demo = project(box, 'said');
  box.run(demo.repo, 'add', 'web', 'Greet the visitor', '--specs', 'G1', '--criterion', 'greets');
  box.run(demo.repo, 'shout', 'web', 'The oldest note, from before the forty shouts the view loads');
  for (let n = 1; n <= 40; n++) box.run(demo.repo, 'shout', 'web', `Filler ${n}`);
  const long = 'Please take #1 next, run `pullboard next` in your worktree, and keep going until the greeting reads right on every width the view supports';
  box.run(demo.repo, 'shout', 'web', `${long}\nA second line the row leaves out.`);
  box.run(demo.repo, 'shout', 'all', 'The private news release is ready.', '--news');
  box.run(demo.web, 'shout', 'coordinator', 'Ship the greeting today?', '--decision');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-said-chrome-'));
  let chrome;
  try {
    const headers = { 'x-pullboard-key': view.key };
    const [board] = (await (await fetchLive(`${view.base}/api/v1/boards`, { headers })).json()).boards;
    const state = (await (await fetchLive(`${view.base}/api/v1/boards/${encodeURIComponent(board.id)}/state`, { headers })).json()).state;
    const ask = state.asked.find((row) => row.shout_text === 'Ship the greeting today?');
    box.run(demo.repo, 'answer', String(ask.shout_id), 'Yes, ship it once the phone width reads right too');
    const asker = ask.shout_from;

    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('!!document.querySelector(\'[data-tab="activity"]\')');
    await chrome.waitFor("typeof data === 'object' && !!data && !!data.project");
    await chrome.click('document.querySelector(\'[data-tab="activity"]\')');
    await chrome.waitFor(`[...document.querySelectorAll('#activity .act')].some((row) => row.textContent.startsWith('coordinator (unknown) answered'))`);
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      // Measure only laid-out previews: on Activity, at this width, each preview with a box of its own.
      const laidOut = `innerWidth === ${width} && !document.querySelector('[data-pane="activity"]').hidden && [...document.querySelectorAll('#activity .said')].every((said) => said.getBoundingClientRect().height > 0)`;
      await chrome.waitFor(laidOut).catch(async (error) => { throw new Error(`${error.message}; showing ${await chrome.stable("[...document.querySelectorAll('[data-pane]')].filter((pane) => !pane.hidden).map((pane) => pane.dataset.pane).join()")}`); });
      await chrome.waitFor("[...document.querySelectorAll('#flow svg text.tag')].some(node => node.textContent === 'intake' && node.getBoundingClientRect().width > 0)");
      const labels = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#flow svg text.tag')].map(node => {
        const box = node.getBoundingClientRect();
        return { words: node.textContent, left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      }))`));
      const intake = labels.find(label => label.words === 'intake');
      assert.ok(intake && intake.right > intake.left, `${width}: the intake route has a visible label`);
      for (const other of labels.filter(label => label !== intake)) {
        assert.ok(intake.right <= other.left || intake.left >= other.right || intake.bottom <= other.top || intake.top >= other.bottom,
          `${width}: intake stays clear of ${other.words} in the actual browser layout`);
      }
      const rows = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#activity .act')].map((row) => {
        const said = row.querySelector('.said');
        const lines = said ? Math.round(said.getBoundingClientRect().height / parseFloat(getComputedStyle(said).lineHeight)) : 0;
        return { text: row.textContent, said: said?.textContent ?? null, tip: said?.title ?? null, lines, refs: said ? said.querySelectorAll('a.ref[data-go]').length : 0,
          code: said ? [...said.querySelectorAll('code')].map((code) => code.textContent) : [], ellipsis: said ? getComputedStyle(said).textOverflow === 'ellipsis' : null,
          cut: said ? said.scrollWidth > said.clientWidth : null };
      }))`));
      const find = (start) => rows.find((row) => row.text.startsWith(start) && (row.said ?? '').length > 0);
      const told = find('coordinator (unknown) shouted to web' + 'Please take');
      assert.ok(told, `${width}: a shout reads sender, shouted to, recipient, then what it said: ${JSON.stringify(rows.slice(0, 4))}`);
      assert.deepEqual([told.said, told.tip], [long.replaceAll("`", ""), long], `${width}: its first line, as written in the tooltip and rendered in the row, never its second`);
      assert.ok(told.lines === 1 && told.ellipsis, `${width}: on one line, set to end in an ellipsis: ${JSON.stringify(told)}`);
      if (width === 375) assert.ok(told.cut, `${width}: cut on a phone, so the ellipsis shows`);
      assert.deepEqual([told.refs, told.code], [1, ['pullboard next']], `${width}: keeping the item link and the inline code`);
      assert.ok(find('coordinator (unknown) shouted to all' + 'The private news release is ready.'), `${width}: typed news retains its actual text in activity`);
      assert.ok(find(`${asker} (Test Model) asked coordinator (unknown)` + 'Ship the greeting today?'), `${width}: a decision reads asked`);
      assert.ok(find(`coordinator (unknown) answered ${asker} (Test Model)` + 'Yes, ship it once'), `${width}: an answer reads who answered whom, then the answer`);
      const oldest = rows.filter((row) => row.text.startsWith('coordinator (unknown) shouted to web')).at(-1);
      assert.deepEqual([oldest.text, oldest.said], ['coordinator (unknown) shouted to web', null], `${width}: a shout older than the forty on hand still names who it went to`);
      assert.ok(rows.some((row) => row.text === 'coordinator (unknown) add #1 Greet the visitor'), `${width}: other rows read as before`);
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('activity names the item each event moved [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'add', 'web', 'Greeting <b>bold</b>', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.web, 'claim', '1');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const rows = page.show('activity').split('<div><time>').slice(1);
    const about = rows.filter((row) => row.includes('data-go="item:1"'));
    assert.equal(about.length, 2, 'the add and the claim');
    for (const row of about) assert.match(row, /data-go="item:1">#1<\/a> <span class="what">Greeting &lt;b&gt;bold&lt;\/b&gt;<\/span><\/div>/, 'the escaped title follows the link');
    const joins = rows.filter((row) => /<\/b> join<\/div>/.test(row));
    assert.ok(joins.length > 0 && joins.every((row) => !row.includes('class="what"')), 'an event about no item names none');
    assert.match(await styleOf(view), /\.feed \.act \.what \{ flex: 1 1 auto; min-width: 0; overflow-wrap: break-word;/, 'activity titles wrap at words and permit an overflowing token to break');
  } finally {
    await view.stop();
  }
});

/** Verify a phone board whose older history still streams says so on each list, pages on demand, then reads as complete. */
test('older history says it is still loading until the stream completes [N26,H5]', { timeout: 120_000 }, async (t) => { // budget: hang ceiling for one real board, 43 CLI runs and one owned Chrome, not a throughput assertion.
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the history-loading proof.');
  const box = machine();
  const streaming = project(box, 'streaming');
  box.run(streaming.repo, 'add', 'web', 'Greet the visitor', '--criterion', 'greets');
  box.run(streaming.repo, 'shout', 'web', 'The oldest shout, read once the feed reaches its end');
  for (let n = 1; n <= 41; n++) box.run(streaming.repo, 'shout', 'web', `Filler ${n}`);
  const live = await startView(box);
  const reads = [];
  // The relay transport's shape (#903): board reads, plus historyProgress(boardId) the test moves by hand.
  const moduleSource = `/** Read the real private board, reporting history progress the test sets. */
export async function createTransport({ onUpdate }) {
  window.__history = { loaded: 120, total: 400, complete: false, sequence: 1 };
  window.__transportUpdate = onUpdate;
  return {
    historyProgress: () => ({ ...window.__history }),
    async request(path, body) {
      if (body != null) throw new Error('The stand-in permits board reads only.');
      const response = await fetch('/fixture' + path);
      const document = await response.json();
      if (!response.ok) throw new Error(document.error ? '[' + document.error.code + '] ' + document.error.message : 'read failed: ' + response.status);
      return document;
    },
  };
}`;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/') return response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(cockpitPage('', { readOnly: true, transportModule: '/transport.js', stylesheet: '/view.css' }));
    if (url.pathname === '/transport.js') return response.writeHead(200, { 'content-type': 'text/javascript' }).end(moduleSource);
    // The stylesheet and board reads come from the real view, so the case reads no source file itself.
    const forward = url.pathname === '/view.css' ? '/view.css' : url.pathname.slice('/fixture'.length) + url.search;
    if ((url.pathname !== '/view.css' && !url.pathname.startsWith('/fixture/')) || request.method !== 'GET') return response.writeHead(404).end();
    reads.push(url.pathname);
    fetchLive(live.base + forward, { headers: { 'x-pullboard-key': live.key } })
      .then(async (reply) => response.writeHead(reply.status, { 'content-type': reply.headers.get('content-type') ?? 'application/json' }).end(await reply.text()))
      .catch(() => response.writeHead(502).end());
  });
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-history-loading-'));
  let chrome;
  try {
    await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
    chrome = await openSnapshotChrome(executable, `http://127.0.0.1:${server.address().port}/`, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await chrome.waitFor(`data?.project?.items.some((item) => item.title === 'Greet the visitor')`);
    const note = (kind) => `(document.querySelector('[data-history-note="${kind}"]')?.textContent ?? null)`;

    // Streaming: the feed ends in the line, with how far along it is, and its end reads ten older shouts at a time.
    await chrome.click(`document.querySelector('[data-tab="shouts"]')`);
    await chrome.waitFor(`${note('shouts')} === 'Older shouts are still loading (30%).'`);
    assert.equal(await chrome.stable(`document.querySelector('#feed').lastElementChild.dataset.historyNote`), 'shouts', 'the line ends the feed');
    assert.equal(await chrome.stable(`document.querySelector('#feed').textContent.includes('The oldest shout')`), false, 'the oldest shout is not among the forty on hand');
    await chrome.stable(`document.querySelector('[data-history-note="shouts"]').scrollIntoView({ block: 'end' })`);
    await chrome.waitFor(`document.querySelector('#feed').textContent.includes('The oldest shout, read once the feed reaches its end')`);
    assert.ok(reads.some((path) => /\/shouts\/\d+$/.test(path)), 'the next page came from addressed shout reads');
    assert.equal(await chrome.stable(`document.querySelector('#feed').lastElementChild.dataset.historyNote`), 'shouts', 'the line still ends the longer feed');
    assert.equal(await chrome.stable('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, 'no sideways scroll at 390px');

    // Activity: the same line; its end asks the transport for the board again, and the count moves in place.
    await chrome.click(`document.querySelector('[data-tab="activity"]')`);
    await chrome.waitFor(`${note('activity')} === 'Older activity is still loading (30%).'`);
    await chrome.stable(`(() => { const read = refresh; window.__pages = 0; refresh = (...args) => { if (new Error().stack.includes('historyNextPage')) window.__pages += 1; return read(...args); }; return true; })()`);
    await chrome.stable(`document.querySelector('[data-history-note="activity"]').scrollIntoView({ block: 'end' })`);
    await chrome.waitFor('window.__pages >= 1');
    await chrome.stable('window.__history.loaded = 300');
    await chrome.waitFor(`${note('activity')} === 'Older activity is still loading (75%).'`);

    // An item's thread ends its history with the line.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.click(`document.querySelector('[data-tab="items"]')`);
    await chrome.click(`document.querySelector('#chain [data-item]')`);
    await chrome.waitFor(`${note('item')} === 'Older entries are still loading (75%).'`);

    // Complete: every line goes, and a redraw brings none back.
    await chrome.stable('window.__history = { loaded: 400, total: 400, complete: true, sequence: 1 }');
    await chrome.waitFor(`document.querySelectorAll('[data-history-note]').length === 0`);
    await chrome.stable('render()');
    for (const tab of ['shouts', 'activity', 'items']) {
      await chrome.click(`document.querySelector('[data-tab="${tab}"]')`);
      assert.equal(await chrome.stable(`document.querySelectorAll('[data-history-note]').length`), 0, `${tab} reads as complete`);
    }
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await new Promise((closed) => server.close(closed));
    await live.stop();
  }
});
