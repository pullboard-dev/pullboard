// pullboard: browser
/** @pullboard-test-gui */
/** @pullboard-view-test journey
 * The agent floor's approved fixes in real Chrome: grouped number band, wider Now column, equal queue cards, more ways in [N26,N38]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { before } from 'node:test';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { accept } from '../../tests/fixtures/cockpit/harness.js';
import { boardId } from '../../tests/fixtures/cockpit/harness.js';
import { build } from '../../tests/fixtures/cockpit/harness.js';
import { chromeExecutable } from '../../tests/fixtures/cockpit/harness.js';
import { closeSnapshotChrome } from '../../tests/fixtures/cockpit/harness.js';
import { earlier } from '../../tests/fixtures/cockpit/harness.js';
import { fetchLive } from '../../tests/fixtures/cockpit/harness.js';
import { machine } from '../../tests/fixtures/cockpit/harness.js';
import { openSnapshotChrome } from '../../tests/fixtures/cockpit/harness.js';
import { press } from '../../tests/fixtures/cockpit/harness.js';
import { project } from '../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../tests/fixtures/cockpit/harness.js';

const MINUTE = 60_000;
/** The seeded board, its running view, and the exact API reads the page itself makes. */
const seeded = {};

/** Read the board's state and complete event history through the same API the Dashboard reads. */
async function boardInput(view, root) {
  const id = await boardId(view, root), headers = { 'x-pullboard-key': view.key };
  const base = `${view.base}/api/v1/boards/${id}`;
  const [stateResponse, eventsResponse] = await Promise.all([
    fetchLive(`${base}/state`, { headers }), fetchLive(`${base}/events?after=0`, { headers }),
  ]);
  assert.equal(stateResponse.status, 200);
  assert.equal(eventsResponse.status, 200);
  const [{ state }, { events }] = await Promise.all([stateResponse.json(), eventsResponse.json()]);
  return { project: { ...state, root }, events };
}

// One real board for every case: two landed, one accepted, two in review, one sent back, three ready, one building.
before(async () => {
  const box = machine();
  const alpha = project(box, 'agent-floor', undefined, {
    lease: '2h', reviewLease: '3h',
    lanes: { web: { owns: ['web/'], specs: ['G'] }, tests: { owns: [], specs: ['G'] }, quiet: { owns: [], specs: ['G'] } },
  });
  const titles = ['Landed one', 'Landed two', 'Accepted, waiting to land', 'In review with a reviewer', 'In review, nobody yet',
    'Sent back once', 'Ready one', 'Ready two', 'Ready three'];
  for (const title of titles) {
    box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'The fixture row shows on the agent floor.',
      '--check', 'test -d web/', '--wait');
  }
  for (const id of [1, 2]) {
    build(box, alpha, id, `landed-${id}.txt`);
    accept(box, alpha, id);
    box.git(alpha.repo, 'merge', '--no-ff', '-m', `chore: land floor item ${id}`, alpha.itemBranches.get(`${alpha.baseBranch}:${id}`));
    box.run(alpha.repo, 'merged', String(id), box.git(alpha.repo, 'rev-parse', 'HEAD'));
  }
  build(box, alpha, 3, 'accepted.txt');
  accept(box, alpha, 3);
  build(box, alpha, 4, 'review-4.txt');
  build(box, alpha, 5, 'review-5.txt');
  build(box, alpha, 6, 'sent-back.txt');
  const reviewer = join(box.dir, 'agent-floor-reviewer');
  box.git(alpha.repo, 'worktree', 'add', '-q', '-b', 'tests/agent-floor-reviewer', reviewer, 'main');
  box.run(reviewer, 'join', 'tests', '--model', 'Floor reviewer');
  // The reviewer sends #6 back from its submitted commit, so the red mark sits on the reviewer's own line.
  box.git(reviewer, 'switch', '-q', '--detach', alpha.itemBranches.get(`${alpha.baseBranch}:6`));
  box.run(reviewer, 'verify', '6', 'reject', '--reason', 'BEHAVIOR_MISMATCH', '--clause', 'shows on the agent floor', '--note', 'the floor fixture sends it back');
  box.git(reviewer, 'switch', '-q', '--detach', 'main');
  earlier(alpha.repo, Date.now(), board => store.reserveReview(board, 4, { agentId: 'tests-1', leaseMs: 3 * 60 * MINUTE, policy: 'any' }));
  // web-1 claims its next ready item, which it is building now.
  box.run(alpha.web, 'claim', '7');
  for (const index of [1, 2]) {
    const path = join(box.dir, `agent-floor-quiet-${index}`);
    box.git(alpha.repo, 'worktree', 'add', '-q', '-b', `tests/agent-floor-quiet-${index}`, path, 'main');
    box.run(path, 'join', 'quiet', '--model', `Floor seat ${index}`);
    seeded[`quiet${index}`] = path;
  }
  const clockBase = Date.now();
  earlier(alpha.repo, clockBase + 10 * MINUTE, board => store.shout(board, { from: 'quiet-1', to: 'all', text: 'Between items on the floor.', lanes: ['web'] }));
  Object.assign(seeded, { box, alpha, clockBase, now: clockBase + 25 * MINUTE, view: await startView(box) });
  seeded.input = await boardInput(seeded.view, alpha.repo);
  seeded.held = seeded.input.project.items.find(item => item.status === 'claimed');
  const state = seeded.input.project, events = seeded.input.events;
  assert.equal(state.items.length, 9, 'the actual API supplies all native rows');
  assert.equal(seeded.held.id, 7);
  assert.equal(seeded.held.owner, undefined, 'the actual page API supplies a summary, not native item detail');
  assert.equal(seeded.held.claim.by, 'web-1');
  const review = state.items.find(item => item.id === 4);
  assert.equal(review.reviewer, undefined);
  assert.equal(review.claim.by, 'tests-1');
  const reservation = events.findLast(event => event.event_kind === 'reserve' && event.item_id === 4);
  assert.equal(JSON.parse(reservation.event_detail).until, review.claim.until, 'native reservation binds the summary lease');
  assert.deepEqual(state.dashboardLanded.map(entry => entry.id).sort((a, b) => a - b), [1, 2]);
  for (const landed of state.dashboardLanded) assert.ok(events.some(event => event.event_kind === 'merged'
    && event.item_id === landed.id && JSON.parse(event.event_detail).commit === landed.commit), 'actual merged receipt binds each summary commit');
  assert.ok(events.some(event => event.event_kind === 'reject' && event.item_id === 6 && event.event_by === 'tests-1'));
  assert.ok(events.some(event => event.event_kind === 'shout' && event.event_by === 'quiet-1'));
  assert.ok(events.every((event, index) => Number.isSafeInteger(event.event_id)
    && (!index || event.event_id > events[index - 1].event_id)), 'the actual history endpoint has complete ordered native identities');

}, { timeout: 120_000 });

after(async () => { await seeded.view?.stop(); });

const GROUPS = [
  ['agents', 'Agents', ['Live', 'Building', 'Reviewing', 'Between']],
  ['recent', 'Last 4 hours', ['Landed', 'Passed', 'Sent back', 'Shouts']],
  ['waiting', 'Waiting', ['In review', 'To land', 'Ready']],
];

/** Everything the floor's layout clauses measure, read from the page at its current width. */
const MEASURE = `(() => {
  const all = selector => [...document.querySelectorAll(selector)];
  const box = element => { const rect = element.getBoundingClientRect(); return { top: Math.round(rect.top + scrollY), left: Math.round(rect.left), width: rect.width, height: rect.height }; };
  const row = all('#dashboard .floor-agent:not(.floor-axis)')[0];
  return {
    fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    groups: all('#dashboard .floor-grp').map(group => ({ key: group.dataset.floorGroup, heading: group.querySelector('h2').firstChild.textContent, note: group.querySelector('h2 > span').textContent, box: box(group),
      labels: [...group.querySelectorAll('.floor-number')].map(number => { const span = number.querySelector('span'); return { text: span.textContent, title: number.title, oneLine: span.getBoundingClientRect().height < parseFloat(getComputedStyle(span).lineHeight) * 1.5, clipped: span.scrollWidth > span.clientWidth + 1, subline: !!number.querySelector('small') }; }) })),
    timeline: box(row.querySelector('svg')), now: box(row.querySelector('.floor-now')),
    queues: all('#dashboard .floor-queue').map(box),
  };
})()`;

test('the floor\'s numbers, Now column and queue cards follow the approved fixes at desktop, 1100px and phone widths [N26,N38]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the agent floor fixes.');
  const { view, alpha } = seeded;
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-floor-fixes-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)} && !!document.querySelector('#dashboard .dash-floor-link') && !!document.querySelector('.status [data-status=agents]')`);
    // Clause 4: three more ways in, each beside the existing "Open the agent floor" link.
    const ways = [
      ['the Agents card title', '#dashboard [aria-label=Agents] h2 > a:first-child'],
      ['the Agents card working count', '#dashboard [aria-label=Agents] h2 .dash-agents-count'],
      ['the status bar agents count', '.status [data-status=agents]'],
    ];
    assert.match(await chrome.stable('document.querySelector("#dashboard [aria-label=Agents] .dash-agents-count").textContent'), /^\d+ working$/u);
    assert.equal(await chrome.stable('document.querySelector("#dashboard [aria-label=Agents] .dash-floor-link").textContent'), 'Open the agent floor →', 'the existing link stays');
    for (const [name, selector] of ways) {
      await press(chrome, `document.querySelector(${JSON.stringify(selector)})`);
      await chrome.waitFor('view.tab === "dashboard" && view.addressDetail === "floor" && !!document.querySelector("#dashboard .floor")');
      assert.equal(await chrome.stable('location.pathname'), '/dashboard/floor', `${name} opens the agent floor`);
      await press(chrome, 'document.querySelector("#dashboard .floor-crumbs a")');
      await chrome.waitFor('view.addressDetail === null && !!document.querySelector("#dashboard .dash-floor-link")');
    }
    await press(chrome, 'document.querySelector("#dashboard .dash-floor-link")');
    await chrome.waitFor('view.addressDetail === "floor" && !!document.querySelector("#dashboard .floor .floor-grp")');

    const seen = {};
    for (const width of [1440, 1100, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 700 });
      await chrome.waitFor(`innerWidth === ${width}`);
      const m = seen[width] = await chrome.stable(MEASURE);
      assert.equal(m.fits, true, `no sideways scroll at ${width}px`);
      // Clause 1: three groups, each with a heading and a right-side note, one- or two-word labels that never wrap.
      assert.deepEqual(m.groups.map(group => [group.key, group.heading]), GROUPS.map(([key, heading]) => [key, heading]), `three groups at ${width}px`);
      assert.deepEqual(m.groups.map(group => group.labels.map(label => label.text)), GROUPS.map(([, , labels]) => labels), `the labels at ${width}px`);
      assert.match(m.groups[0].note, /^\d+ seen in 4 h$/u);
      assert.match(m.groups[1].note, /^[\d,]+ landed in 24 h$/u);
      assert.equal(m.groups[2].note, '');
      for (const label of m.groups.flatMap(group => group.labels)) {
        assert.ok(label.text.split(' ').length <= 2, `${label.text} is one or two words`);
        assert.equal(label.oneLine && !label.clipped, true, `${label.text} stays on one line at ${width}px`);
        assert.ok(label.title.length > 0, `${label.text} explains itself on hover`);
        assert.equal(label.subline, false, `${label.text} has no sub-line; it moved to the hover`);
      }
      const tops = new Set(m.groups.map(group => group.box.top));
      assert.equal(tops.size, width <= 1100 ? 3 : 1, width <= 1100 ? `the groups stack at ${width}px` : `the groups sit side by side at ${width}px`);
      // Clause 2: the Now column is the wider of the two where the row is a line.
      if (width > 700) assert.ok(m.now.width > m.timeline.width, `Now (${m.now.width}) takes width from the timeline (${m.timeline.width}) at ${width}px`);
      // Clause 3: queue cards share their row's height.
      assert.equal(m.queues.length, 4);
      for (const top of new Set(m.queues.map(card => card.top))) {
        const row = m.queues.filter(card => card.top === top);
        assert.ok(Math.max(...row.map(card => card.height)) - Math.min(...row.map(card => card.height)) < 1.5, `queue cards in the row at ${top} are equal height at ${width}px`);
      }
      if (width === 1440) assert.equal(new Set(m.queues.map(card => card.top)).size, 1, 'the four queue cards sit in one row on a desktop');
    }
    assert.ok(seen[1440].now.width / seen[1440].timeline.width > 1.2, 'the Now column is clearly wider, not just a pixel');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
  }
});
