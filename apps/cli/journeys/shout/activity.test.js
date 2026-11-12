// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** Cockpit activity checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { activityModel } from '../../../view/index.js';
import { activityHtml } from '../../../view/index.js';
import {
  IN_STATE,
  MACHINE,
  effectiveGuards,
} from '../../../../packages/state/index.js';
import { cliCockpitRenderer$cockpitPage as cockpitPage } from '../../index.js';
import { openBoard } from '../../../lib/index.js';
import {
  closeBoard,
  logEvent,
} from '../../../../packages/store/index.js';
import {
  machine,
  project,
  build,
  sendBack,
  fetchLive,
  startView,
  styleOf,
  element,
  storage,
  openPage,
  timelineRows,
  agentEntries,
  drawing,
  textBoxes,
  meet,
  accept,
  itemRow,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
} from '../../tests/fixtures/cockpit/harness.js';

const verifiedIsFinal = Boolean(MACHINE.states.find((state) => state.id === 'verified').final);

test('activity shows each submit note and verdict with landing evidence [N26]', { timeout: 120_000 }, async () => {
  const box = machine(), alpha = project(box, 'activity-evidence');
  await box.inProcess(alpha.repo, 'add', 'web', 'Readable evidence', '--specs', 'G1', '--criterion', 'Evidence is readable.');
  // @pullboard-board-file journey: native event records are served to the real Activity browser view.
  const board = openBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    logEvent(board, 'web-1', 'submit', 1, { note: 'Builder note <safe>', gateGreen: true, submissionProof: { files: ['test/example.test.js'], reason: 'Focused evidence' } });
    logEvent(board, 'reviewer', 'reject', 1, { reason: 'RIGOR', note: 'Rejection note <safe>' });
    logEvent(board, 'reviewer', 'accept', 1, { note: 'Reviewer note <safe>' });
    logEvent(board, 'coordinator', 'merged', 1, { commit: 'a'.repeat(40) });
    logEvent(board, 'coordinator', 'main-moved', null, { sha: 'b'.repeat(40), items: [1] });
  } finally { closeBoard(board); }
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-activity-evidence-'));
  let chrome;
  try {
    const executable = chromeExecutable();
    assert.ok(executable, 'real Chrome is required');
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('!!data?.project');
    await press(chrome, "document.querySelector('[data-tab=activity]')");
    await chrome.waitFor("document.querySelector('#activity [data-activity-kind=main-moved]')");
    for (const width of [1440, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const result = JSON.parse(await chrome.stable(`JSON.stringify({ text: document.querySelector('#activity').innerText, html: document.querySelector('#activity').innerHTML, overflow: document.documentElement.scrollWidth > innerWidth })`));
      assert.match(result.text, /Builder note <safe>[\s\S]*Checks: test\/example\.test\.js[\s\S]*Focused evidence[\s\S]*Check passed/u);
      assert.match(result.text, /Reviewer note <safe>/u);
      assert.match(result.text, /Reason: rigor[\s\S]*Rejection note <safe>/u);
      assert.match(result.text, /Landed at a{12}/u);
      assert.match(result.text, /Items: #1[\s\S]*Main at b{12}/u);
      assert.doesNotMatch(result.html, /<safe>/u, 'event prose is escaped');
      assert.equal(result.overflow, false, `${width}px stays within the viewport`);
    }
    assert.deepEqual(chrome.exceptions, []);
  } finally { if (chrome) await closeSnapshotChrome(chrome); await view.stop(); rmSync(profile, { recursive: true, force: true }); }
});


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
      assert.equal(rows.find((row) => row.event === 'coordinator passed it').stay, 'verified for 2m');
      assert.equal(rows.find((row) => row.event === 'coordinator landed it').stay, '', 'a quiet event does not end the verified stay');
      assert.equal(rows.find((row) => row.event === 'coordinator sent it back').dot, 'tl-open');
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
    assert.equal(route.back, false, 'the lower-lane return is not an above-row back route');
    assert.equal(route.points[1][1], route.points[2][1], 'the return runs through a horizontal lower lane');
    const fixtureBottoms = [...svg.matchAll(/<rect class="box" x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)"/g)]
      .map(([, y, height]) => Number(y) + Number(height));
    assert.ok(route.points[1][1] > Math.max(...fixtureBottoms), 'the lower lane clears every state box');
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
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  build(box, alpha, 1, 'greeting.html');
  sendBack(box, alpha, 1, 'no greeting');
  build(box, alpha, 1, 'greeting-again.html');
  accept(box, alpha, 1);
  box.git(alpha.repo, 'merge', '--no-ff', '-m', 'chore: merge fixture item', alpha.branch);
  const trunkCommit = box.git(alpha.repo, 'rev-parse', 'HEAD');
  assert.notEqual(trunkCommit, box.git(alpha.repo, 'rev-parse', alpha.branch), 'the receipt names the trunk merge commit');
  await box.inProcess(alpha.repo, 'merged', '1', trunkCommit);
  await box.inProcess(alpha.web, 'claim', '2');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ go: 'item:1' });
    const done = timelineRows(page.show('detail')).reverse();
    assert.deepEqual(done.map((row) => [row.dot, row.event]), [
      ['tl-open', 'coordinator added this work'],
      ['tl-claimed', 'web-1 claimed it'],
      ['tl-claimed tl-quiet', 'web-1 continued building'],
      ['tl-claimed tl-quiet', 'web-1 ran the proof'],
      ['tl-fact', 'web-1 recorded a measurement'],
      ['tl-submitted', 'web-1 submitted it for review'],
      ['tl-open tl-back', 'coordinator sent it back'],
      ['tl-claimed', 'web-1 claimed it'],
      ['tl-claimed tl-quiet', 'web-1 continued building'],
      ['tl-claimed tl-quiet', 'web-1 ran the proof'],
      ['tl-fact', 'web-1 recorded a measurement'],
      ['tl-submitted', 'web-1 submitted it for review'],
      ['tl-verified', 'coordinator passed it'],
      ['tl-verified tl-quiet', 'coordinator landed it'],
    ], 'a dot per event in the colour of the state it led to; a merge moves nothing');
    assert.deepEqual(done.map((row) => row.stay.replace(/ for .*/, ' for')), ['open for', 'claimed for', '', '', 'now', 'submitted for', 'sent back for', 'claimed for', '', '', 'now', 'submitted for', verifiedIsFinal ? '' : 'verified for', ''], 'each stay until the next move; a final state has none and quiet proof receipts and merge stay untimed');
    assert.ok(done.filter(row => !row.dot.includes('tl-quiet') && !row.dot.includes('tl-fact')).slice(0, 6).every((row) => / for (under a minute|\d+m)$/.test(row.stay)), done.map((row) => row.stay).join(', '));
    assert.ok(done.every((row) => /^\d{1,2}:\d\d [AP]M$/.test(row.time)), 'every event keeps its time');

    await page.click({ go: 'item:2' });
    assert.deepEqual(timelineRows(page.show('detail')).reverse().map((row) => [row.dot, row.stay]).slice(1), [['tl-claimed', 'claimed for now so far']]);
    const later = await openPage(view, { later: 1 });
    await later.click({ go: 'item:2' });
    assert.deepEqual(timelineRows(later.show('detail')).reverse().map((row) => row.stay).slice(1), ['claimed for 24h so far'], 'the stay so far counts on');

    // A claim logged on an item the replay holds claimed: the clock lapsed the first claim between.
    const at = (minute) => new Date(Date.UTC(2026, 9, 6, 12, minute)).toISOString();
    const item = { status: 'claimed', history: [{ kind: 'add', by: 'web-1', at: at(0) }, { kind: 'claim', by: 'web-1', at: at(5) }, { kind: 'claim', by: 'web-2', at: at(200) }] };
    const lapsed = timelineRows(page.run(`timeline(${JSON.stringify(item)})`));
    assert.deepEqual(lapsed.map((row) => [row.dot, row.event, row.time === '']), [
      ['tl-open', 'web-1 added this work', false],
      ['tl-claimed', 'web-1 claimed it', false],
      ['tl-open', 'the clock released an expired lease', true],
      ['tl-claimed', 'web-2 claimed it', false],
    ]);
    assert.deepEqual(lapsed.map((row) => row.stay.replace(/ for .*/, ' for')), [
      'open for',
      'claimed until the lease expiry, length not logged',
      'open after the lease expiry, length not logged',
      'claimed for',
    ], 'a stay that ends or begins at an untimed lapse says its length was not logged');
    assert.equal(lapsed[0].stay, 'open for 5m');

    // A lease that ran out with nothing after it: the item reads open, and has been since the lapse.
    const idle = { status: 'open', history: [{ kind: 'add', by: 'web-1', at: at(0) }, { kind: 'claim', by: 'web-1', at: at(5) }] };
    assert.deepEqual(timelineRows(page.run(`timeline(${JSON.stringify(idle)})`)).map((row) => [row.event, row.stay]), [
      ['web-1 added this work', 'open for 5m'],
      ['web-1 claimed it', 'claimed until the lease expiry, length not logged'],
      ['the clock released an expired lease', 'open so far since the lease expiry, length not logged'],
    ]);
  } finally {
    await view.stop();
  }
});

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
test('ages stay true while the board is quiet [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'greeting.html');
  await box.inProcess(alpha.repo, 'shout', 'person', 'Ship the greeting today?', '--kind', 'decision', '--decision');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ tab: 'items' });
    await page.click({ tab: 'shouts' });
    const ages = () => ({
      row: /<time data-ago="[^"]+">([^<]*)<\/time>/.exec(itemRow(page.show('chain'), 1))?.[1],
      needs: /<span class="needs-age"><time data-ago="[^"]+">([^<]*)<\/time>/.exec(page.show('needs'))?.[1],
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
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'greeting.html');
  await box.inProcess(alpha.repo, 'shout', 'web', '#1 is in');
  const view = await startView(box);
  try {
    const days = (html) => [...html.matchAll(/<h4 class="day">([^<]*)<\/h4>|<div class="day-rule" role="separator"><span>([^<]*)<\/span><\/div>/g)].map((match) => match[1] ?? match[2]);
    // A shout says how long ago it was, with its clock time on hover.
    const ages = (html) => [...html.matchAll(/<time class="long" data-ago="[^"]+" title="([^"]*)">([^<]*)<\/time>/g)].map((match) => [match[2], match[1]]);
    const times = (html) => [...html.matchAll(/<time>([^<]*)<\/time>/g)].map((match) => match[1]);
    const bare = (list) => list.length > 0 && list.every((time) => /^\d{1,2}:\d\d [AP]M$/.test(time));

    const now = await openPage(view);
    await now.click({ tab: 'shouts' });
    await now.click({ tab: 'items' });
    await now.click({ tab: 'activity' });
    assert.deepEqual([days(now.show('feed')), days(now.show('activity'))], [[], ['Today']], 'shouts from today need no rule above them');
    assert.deepEqual(ages(now.show('feed')).map(([age, clock]) => [age, /^\d{1,2}:\d\d [AP]M$/.test(clock)]), [['now', true]], 'a shout from today says now, its clock time on hover');
    assert.ok(bare(times(now.show('detail'))), 'a history from today shows bare times');

    const tomorrow = await openPage(view, { later: 1 });
    await tomorrow.click({ tab: 'shouts' });
    await tomorrow.click({ tab: 'activity' });
    assert.deepEqual([days(tomorrow.show('feed')), days(tomorrow.show('activity'))], [['Yesterday'], ['Yesterday']]);

    const weekday = new Date().toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    const date = new Date().toLocaleDateString([], { month: 'short', day: 'numeric' });
    const later = await openPage(view, { later: 2 });
    await later.click({ tab: 'shouts' });
    await later.click({ tab: 'items' });
    await later.click({ tab: 'activity' });
    assert.deepEqual([days(later.show('feed')), days(later.show('activity'))], [[weekday], [weekday]], 'two days on, the feeds name the day');
    assert.ok(times(later.show('activity')).length > 0 && times(later.show('activity')).every(time => /^\d{1,2}:\d\d [AP]M$/.test(time)), 'Activity uses the approved person-clock format');
    assert.deepEqual(ages(later.show('feed')).map(([age, clock]) => [age, new RegExp(`^${date} \\d{1,2}:\\d\\d [AP]M$`).test(clock)]), [['2d ago', true]], 'a shout says how long ago, with its date and time on hover');
    const history = times(later.show('detail'));
    assert.ok(history.length === 6 && history.every((time) => new RegExp(`^${date} \\d{1,2}:\\d\\d [AP]M$`).test(time)), `the history dates every move including its proof receipt: ${history}`);

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
  await box.inProcess(demo.repo, 'add', 'web', 'Greet the visitor', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(demo.repo, 'shout', 'web', 'The oldest note, from before the forty shouts the view loads');
  for (let n = 1; n <= 40; n++) await box.inProcess(demo.repo, 'shout', 'web', `Filler ${n}`);
  const long = 'Please take #1 next, run `pullboard next` in your worktree, and keep going until the greeting reads right on every width the view supports';
  await box.inProcess(demo.repo, 'shout', 'web', `${long}\nA second line the row leaves out.`);
  await box.inProcess(demo.repo, 'shout', 'all', 'The private news release is ready.', '--news');
  await box.inProcess(demo.repo, 'lanes', 'lead', 'web', 'web-1');
  await box.inProcess(demo.web, 'shout', 'coordinator', 'Ship the greeting today?', '--kind', 'decision', '--decision');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-said-chrome-'));
  let chrome;
  try {
    const headers = { 'x-pullboard-key': view.key };
    const [board] = (await (await fetchLive(`${view.base}/api/v1/boards`, { headers })).json()).boards;
    const state = (await (await fetchLive(`${view.base}/api/v1/boards/${encodeURIComponent(board.id)}/state`, { headers })).json()).state;
    const ask = state.asked.find((row) => row.shout_text === 'Ship the greeting today?');
    await box.inProcess(demo.repo, 'answer', String(ask.shout_id), 'Yes, ship it once the phone width reads right too');
    const asker = ask.shout_from;

    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('!!document.querySelector(\'[data-tab="activity"]\')');
    await chrome.waitFor("typeof data === 'object' && !!data && !!data.project");
    await chrome.click('document.querySelector(\'[data-tab="activity"]\')');
    await chrome.waitFor(`[...document.querySelectorAll('#activity .activity-say')].some(row => row.textContent.includes('Yes, ship it once'))`);
    await press(chrome, "document.querySelector('#flow-show')");
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      // Measure only laid-out previews: on Activity, at this width, each preview with a box of its own.
      const laidOut = `innerWidth === ${width} && !document.querySelector('[data-pane="activity"]').hidden && [...document.querySelectorAll('#activity .activity-quote')].every((said) => said.getBoundingClientRect().height > 0)`;
      await chrome.waitFor(laidOut).catch(async (error) => { throw new Error(`${error.message}; showing ${await chrome.stable("[...document.querySelectorAll('[data-pane]')].filter((pane) => !pane.hidden).map((pane) => pane.dataset.pane).join()")}`); });
      await chrome.waitFor("document.querySelectorAll('#flow [data-lifecycle-route] text.tag').length === 6");
      const labels = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#flow svg text.tag')].map(node => {
        const box = node.getBoundingClientRect();
        return { words: node.textContent, left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      }))`));
      assert.equal(labels.length, 7, 'six ordinary move labels and the withdrawn total are visible');
      for (const [index, label] of labels.entries()) {
        assert.ok(label.right > label.left, `${width}: ${label.words} has a visible label`);
        for (const other of labels.slice(index + 1)) {
          assert.ok(label.right <= other.left || label.left >= other.right || label.bottom <= other.top || label.top >= other.bottom,
            `${width}: ${label.words} stays clear of ${other.words} in the actual browser layout`);
        }
      }
      const rows = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#activity .activity-say')].map(row => {
        const quote = row.querySelector('.activity-quote');
        const sentence = row.querySelector('p'), about = sentence?.querySelector('.activity-about'), plain = sentence?.cloneNode(true);
        plain?.querySelector('.activity-about')?.remove();
        return { sentence: plain?.textContent.trim(), fullSentence: sentence?.textContent, about: about ? { text: about.textContent, target: about.dataset.go, last: about === sentence.lastElementChild } : null, text: row.textContent, said: quote?.textContent ?? null,
          refs: quote ? quote.querySelectorAll('a.ref[data-go]').length : 0,
          code: quote ? [...quote.querySelectorAll('code')].map(code => code.textContent) : [],
          fullQuote: quote ? getComputedStyle(quote).whiteSpace === 'pre-wrap' : null,
          model: row.querySelector('.activity-who')?.title ?? '' };
      }))`));
      const find = (sentence, said) => rows.find(row => row.sentence === sentence && row.said?.startsWith(said));
      const told = find('The coordinator told web', 'Please take');
      assert.ok(told, `${width}: sender, recipient and original words remain visible`);
      assert.equal(told.fullSentence, 'The coordinator told web about #1', `${width}: the related item follows the original sentence`);
      assert.deepEqual(told.about, { text: 'about #1', target: 'item:1', last: true }, `${width}: the approved item chip remains an inline navigation target`);
      assert.equal(told.said, long.replaceAll('`', '') + '\nA second line the row leaves out.', `${width}: the approved quote retains every line`);
      assert.equal(told.fullQuote, true, 'full quotes wrap rather than hiding the second line');
      assert.deepEqual([told.refs, told.code], [1, ['pullboard next']], `${width}: item links and inline code still work`);
      assert.ok(find('The coordinator told all', 'The private news release is ready.'), 'typed news retains its actual words');
      assert.ok(find(asker + ' asked the coordinator', 'Ship the greeting today?'), 'a question retains its sender, recipient and words with the approved verb');
      assert.equal(find(asker + ' asked the coordinator', 'Ship the greeting today?').model, 'Test Model', 'the model is a hover title');
      assert.ok(find('The coordinator told ' + asker, 'Yes, ship it once'), 'the answer retains both addresses and its words');
      assert.ok(rows.some(row => row.sentence === 'The coordinator told web' && row.said === null), 'older unloaded shout words are not invented');
      assert.ok(rows.some(row => row.sentence === 'The coordinator added work' && row.text.includes('#1Greet the visitor')), 'other work has a sentence and item underneath');
      assert.ok(rows.every(row => !row.sentence?.includes('(unknown)')), 'unknown models are omitted');
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
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting <b>bold</b>', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(alpha.web, 'claim', '1');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ tab: 'activity' });
    const rows = page.show('activity').split('<li class="activity-event"').slice(1);
    const about = rows.filter(row => row.includes('data-go="item:1"'));
    assert.equal(about.length, 2, 'the add and the claim');
    for (const row of about) assert.match(row, /data-go="item:1">#1<\/a>Greeting &lt;b&gt;bold&lt;\/b&gt;/, 'the escaped title follows its real item link');
    assert.ok(rows.every(row => !row.includes('>join<')), 'subjectless join bookkeeping is hidden');
    assert.match(await styleOf(view), /\.activity-item \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/, 'the approved item title uses one line with ellipsis');
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
  await box.inProcess(streaming.repo, 'add', 'web', 'Greet the visitor', '--criterion', 'greets');
  await box.inProcess(streaming.repo, 'shout', 'web', 'The oldest shout, read once the feed reaches its end');
  for (let n = 1; n <= 41; n++) await box.inProcess(streaming.repo, 'shout', 'web', `Filler ${n}`);
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

    // The compact conversation list may already expose its end; prove the initial window before opening it.
    assert.equal(await chrome.stable(`data.project.shouts.some(shout => shout.shout_text.includes('The oldest shout'))`), false, 'the oldest shout is not among the forty on hand');
    assert.equal(reads.some((path) => /\/shouts\/\d+$/.test(path)), false, 'no older shout was requested before Shouts opens');
    // Streaming: the feed ends in the line, with how far along it is, and its end reads ten older shouts at a time.
    await chrome.click(`document.querySelector('[data-tab="shouts"]')`);
    await chrome.waitFor(`${note('shouts')} === 'Older shouts are still loading (30%).'`);
    await chrome.click(`document.querySelector('[data-shout-thread="none"]')`);
    await chrome.waitFor('!!document.querySelector("#feed .shout")');
    assert.equal(await chrome.stable(`document.querySelector('#feed').lastElementChild.dataset.historyNote`), 'shouts', 'the line ends the feed');
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
    await chrome.click(`document.querySelector('[data-item-panel-tab=history]')`);
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

test('clause 1: Activity collapses consecutive continued-building rows by one seat for one item [N26]', () => {
  const at = minute => new Date(Date.UTC(2026, 10, 4, 12, minute)).toISOString();
  const event = (id, kind, by, item, minute) => ({ event_id: id, event_kind: kind, event_by: by, item_id: item, event_at: at(minute), event_detail: '{}' });
  const project = { items: [{ id: 7, title: 'Seven' }, { id: 8, title: 'Eight' }], agents: [], shouts: [], events: [
    event(1, 'claim', 'web-1', 7, 0), event(2, 'renew', 'web-1', 7, 10), event(3, 'renew', 'web-1', 7, 20), event(4, 'renew', 'web-1', 7, 30),
    event(5, 'renew', 'web-2', 8, 31), event(6, 'renew', 'web-1', 7, 40)] };
  const rows = activityModel(project).rows;
  const renewals = rows.filter(row => row.kind === 'renew');
  assert.deepEqual(renewals.map(row => [row.by, row.item.id, row.verb, row.at]), [
    ['web-1', 7, 'continued building', at(40)],
    ['web-2', 8, 'continued building', at(31)],
    ['web-1', 7, 'continued building · 3 updates', at(30)],
  ], 'three adjacent updates by web-1 on #7 become one row with the latest time; another seat or item breaks the run');
  const html = activityHtml(activityModel(project), { controls: false });
  assert.match(html, /continued building · 3 updates/u);
  assert.equal([...html.matchAll(/continued building · \d+ updates/gu)].length, 1, 'only the collapsed run carries a count');
});

test('clause 2: item-number links on Activity are not underlined and read in mono, as in the mockup [N26]', () => {
  const project = { items: [{ id: 7, title: 'Seven' }], agents: [], shouts: [], events: [{ event_id: 1, event_kind: 'claim', event_by: 'web-1', item_id: 7, event_at: new Date(Date.UTC(2026, 10, 4, 12)).toISOString(), event_detail: '{}' }] };
  assert.match(activityHtml(activityModel(project), { controls: false }), /<ol class="activity-events">.*<span class="activity-item"[^>]*><a class="ref" href="[^"]*" data-go="item:7">#7<\/a>/su, 'the item number is an a.ref[data-go] inside the Activity list, which the rules below style');
  const css = readFileSync(new URL('../../../view/src/io/main.css', import.meta.url), 'utf8');
  assert.match(css, /\.activity-events a\.ref\[data-go\] \{ text-decoration: none; \}/u, 'item-number links on Activity, in a row or a shout, are not underlined');
  assert.match(css, /\.activity-item a\.ref\[data-go\], \.activity-quote a\.ref\[data-go\] \{ font: 500 var\(--text-xs\) var\(--mono\); \}/u, 'an item number in a row or a shout reads as mono, as in the mockup');
});
