// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** Cockpit activity checks, "timeline" group, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  join,
} from 'node:path';
import {
  test,
} from 'node:test';
import {
  MACHINE,
} from '../../../../../packages/state/index.js';
import {
  machine,
  project,
  build,
  sendBack,
  startView,
  openPage,
  timelineRows,
  drawing,
  textBoxes,
  meet,
  accept,
} from '../../../tests/fixtures/cockpit/harness.js';

const verifiedIsFinal = Boolean(MACHINE.states.find((state) => state.id === 'verified').final);

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
