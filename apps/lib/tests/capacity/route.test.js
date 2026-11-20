/** Route work shortages reach the coordinator through the existing durable observer [A6,N2,B13]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../index.js';
import { scanHealthSentinel } from '../../../../packages/sentinels/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { loadDoctrine } from '../../../../packages/doctrine/light.js';
import { frozenCriterion } from '../../../../packages/spec/index.js';
import { loadSpec } from '../../../../packages/spec/index.js';
import { runFixtureGit } from '../../../cli/tests/fixtures/child.js';
import { itemWaits } from '../../../../packages/queue/index.js';
import { readyItems } from '../../../../packages/queue/index.js';

/** The store's digest window: a reader's buffered routine findings are sent once this long has passed. */
const DIGEST_WINDOW_MS = 10 * 60_000;

/** Keep the board, Git and injected observation clock private to this case. */
function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-route-capacity-')));
  let board = null;
  t.after(() => { if (board) store.closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  const root = join(directory, 'repo');
  mkdirSync(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Route fixture', GIT_AUTHOR_EMAIL: 'route@example.invalid',
    GIT_COMMITTER_NAME: 'Route fixture', GIT_COMMITTER_EMAIL: 'route@example.invalid' };
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', lanes: { core: { owns: ['src/'] } } }));
  writeFileSync(join(root, 'SPEC.md'), '# Fixture\n\n## A\n- A6 [approved, must] Report stuck work. | gate: review\n');
  writeFileSync(join(root, 'DOCTRINE.md'), '# Fixture rules\n\n## PB\n- PB1 [approved, must] Keep the fixture isolated. | gate: review\n');
  runFixtureGit(['add', '.'], { cwd: root, env });
  runFixtureGit(['commit', '-q', '-m', 'test: private route fixture'], { cwd: root, env });
  const file = join(root, '.git', 'pullboard', 'board.sqlite');
  const clock = { at: Date.parse('2026-10-25T00:00:00Z'), now() { return new Date(this.at); } };
  // @pullboard-board-file persistence: the health sentinel scans this board by its file path
  board = openBoard(file, clock);
  store.register(board, { lane: 'coordinator', path: root });
  const config = loadConfig(root);
  /** Publish only the real observer's captured snapshot, with ordinary revision validation. */
  function scan() {
    const observation = scanHealthSentinel(file, { root, config, now: clock.now() });
    return observation ? store.recordHealthFindings(board, { agentId: 'coordinator', ...observation }) : null;
  }
  /** Keep the seeded mid items valid under the ordinary cold-build brief requirement. */
  function addFree(title, extra = {}) {
    return store.addItem(board, { by: 'coordinator', lane: 'core', title, route: 'mid',
      criterion: 'The private fixture item can be built cold.', check: 'false',
      brief: 'Files:\n- src/fixture.js\nTest:\nThe fixture test asserts its declared behavior.', ...extra });
  }
  const freeze = item => frozenCriterion(loadSpec(root, config), item, loadDoctrine(root, config));
  /** Register a real route seat without adding a Git checkout for each simulated worker. */
  const seat = (name, route = 'mid') => store.register(board, { lane: 'core', path: join(directory, name), route });
  /** Keep chosen seats present after their no-pull idle threshold has elapsed. */
  const present = agents => {
    for (const agent of agents) store.shout(board, { from: agent, to: 'coordinator', text: 'Available now', lanes: ['core'] });
  };
  /** Select just the route count notices, leaving all pre-existing health causes visible. */
  const shortages = () => scanHealthSentinel(file, { root, config, now: clock.now() }).findings
    .filter(finding => finding.cause === 'ROUTE_WORK_SHORTAGE').map(finding => finding.detail);
  return { directory, root, file, board, clock, config, scan, addFree, freeze, seat, present, shortages };
}

test('lib.capacity-route.the-coordinator-is-told-to-split-work: the coordinator is told to split work when a route has more idle seats than free items [A6,N2,B13]', t => {
  const box = fixture(t);
  const agents = [1, 2].map(number => store.register(box.board,
    { lane: 'core', path: join(box.directory, 'seat-' + number), route: 'mid' }));
  box.addFree('One free item');
  box.clock.at += 31 * 60_000;
  for (const agent of agents) store.shout(box.board, { from: agent, to: 'coordinator', text: 'Available now', lanes: ['core'] });
  const observation = scanHealthSentinel(box.file, { root: box.root, config: box.config, now: box.clock.now() });
  const shortage = observation.findings.find(finding => finding.cause === 'ROUTE_WORK_SHORTAGE' && finding.detail.route === 'mid');
  assert.ok(shortage, 'the ordinary observer identifies too little claimable mid work for two idle mid seats');
  assert.equal(shortage.detail.free, 1);
  assert.equal(shortage.detail.idle, 2);
  box.scan();
  const digests = () => store.allShouts(box.board).filter(row => row.shout_from === 'sentinel'
    && row.shout_to === 'coordinator' && row.shout_text.startsWith('Digest:') && row.shout_text.includes('mid route'));
  assert.equal(digests().length, 0, 'a routine shortage is buffered, not sent at once');
  // The coordinator hears buffered routine findings as one digest line once the digest window has passed [#1479].
  box.clock.at += DIGEST_WINDOW_MS;
  for (const agent of agents) store.shout(box.board, { from: agent, to: 'coordinator', text: 'Available now', lanes: ['core'] });
  box.scan();
  const notices = digests();
  assert.equal(notices.length, 1);
  assert.match(notices[0].shout_text, /\d+ routine findings/u);
  const eventCount = store.events(box.board).length;
  assert.equal(box.scan(), null, 'identical shortages do not keep shouting');
  assert.equal(store.events(box.board).length, eventCount);
  box.addFree('Second free item');
  assert.ok(box.scan().resolved.includes(shortage.key), 'enough claimable work resolves the shortage');
});


test('lib.capacity-route.idle-seats-count-once-at-their-top: idle seats count once at their top route and lower work remains compatible [N2,B13]', t => {
  const box = fixture(t);
  const seats = [box.seat('light', 'light'), box.seat('mid'), box.seat('strong', 'strong')];
  // A light item is offered only once a capable seat has diagnosed it, as next's own eligibility requires [N2,B13].
  const lightWork = box.addFree('Light work');
  store.appendFact(box.board, lightWork, { agentId: seats[2], kind: 'diagnosis',
    text: 'Files: src/fixture.js Change: repoint the fixture to the canonical handler Test case: the fixture returns the expected result from the canonical module' });
  box.clock.at += 31 * 60_000;
  box.present(seats);
  assert.deepEqual(box.shortages(), [], 'one light item is compatible with each one-seat top-route group');
  const secondStrong = box.seat('second-strong', 'strong');
  box.clock.at += 31 * 60_000;
  box.present([...seats, secondStrong]);
  assert.deepEqual(box.shortages(), [{ route: 'strong', free: 1, idle: 2 }],
    'strong seats do not also inflate light or mid idle counts');
  box.addFree('Strong work', { route: 'strong' });
  assert.deepEqual(box.shortages(), [], 'strong work resolves only the strong group; lower groups keep their light work');
});

test('lib.capacity-route.held-and-dependency-blocked-items-do-not: held and dependency-blocked items do not hide a route work shortage [A6,N2,B13]', t => {
  const box = fixture(t);
  const seats = [box.seat('one'), box.seat('two')];
  const free = box.addFree('Free work');
  const held = box.addFree('Held work');
  box.addFree('Blocked work', { after: [free] });
  store.holdItem(box.board, held, { agentId: 'coordinator', reason: 'Wait for a decision' });
  box.clock.at += 31 * 60_000;
  box.present(seats);
  assert.deepEqual(box.shortages(), [{ route: 'mid', free: 1, idle: 2 }]);
  store.holdLane(box.board, 'core', { agentId: 'coordinator', reason: 'Pause this lane' });
  assert.deepEqual(box.shortages(), [{ route: 'mid', free: 0, idle: 2 }], 'a lane hold removes its otherwise free work');
});

test('lib.capacity-route.recently-joined-busy-and-retired-seats-do: recently joined, busy and retired seats do not inflate idle route capacity [A6,N2,B13]', t => {
  const box = fixture(t);
  const idle = box.seat('idle');
  box.seat('retired');
  const busy = box.seat('busy');
  const work = box.addFree('Claimed work');
  store.claim(box.board, work, { agentId: busy, lane: 'core', leaseMs: 3_600_000, freeze: box.freeze });
  box.clock.at += 31 * 60_000;
  box.present([idle]);
  box.seat('fresh');
  assert.deepEqual(box.shortages(), [{ route: 'mid', free: 0, idle: 1 }],
    'only the present seat that has neither pulled nor held work for thirty minutes counts');
});


test('lib.capacity-route.ready-capacity-reads-current-items-and-lane: ready capacity reads current items and lane holds once per projection [C7,N2]', t => {
  const box = fixture(t);
  const ids = Array.from({ length: 12 }, (_, index) => box.addFree(`Capacity ${index}`, index === 2 ? { reviewFamily: 'Claude' } : {}));
  box.addFree('Dependency blocked', { after: [ids[0]] });
  store.holdItem(box.board, ids[1], { agentId: 'coordinator', reason: 'Wait for a decision' });
  const before = store.listItems(box.board, { all: true });
  const expected = before.filter(item => item.item_status === 'open' && !itemWaits(box.board, item, before, store.foreignBlockers).length);
  const reads = { items: 0, holds: 0, families: 0 };
  const observed = { ...box.board, db: {
    /** Count actual production SQLite reads while forwarding exact parameters and native results. */
    prepare(sql) {
      if (/SELECT item\.\*, imported\.meta_value/u.test(sql)) reads.items++;
      if (/SELECT \* FROM hold\b/u.test(sql)) reads.holds++;
      const statement = box.board.db.prepare(sql);
      if (sql !== 'SELECT meta_value FROM board_meta WHERE meta_key=?') return statement;
      return {
        /** Separate reviewer-family keys from redirects sharing this same native SQL text. */
        get(...args) {
          if (args[0]?.startsWith('item_review_family:')) reads.families++;
          return statement.get(...args);
        },
      };
    },
  } };
  assert.deepEqual(readyItems(observed, store.foreignBlockers), expected, 'ordinary hold and dependency blockers retain exact rows and order');
  assert.deepEqual(reads, { items: 1, holds: 1, families: 0 }, 'capacity does not reread full items or prepare a hold query per open item');
  store.editItem(box.board, ids[2], { agentId: 'coordinator', reviewFamily: 'Sol' });
  assert.equal(readyItems(observed, store.foreignBlockers).find(item => item.item_id === ids[2]).item_review_family, 'Sol',
    'the next projection reads an intervening native reviewer-family change');
  store.holdLane(box.board, 'core', { agentId: 'coordinator', reason: 'Pause this lane' });
  reads.items = 0;
  reads.holds = 0;
  reads.families = 0;
  assert.deepEqual(readyItems(observed, store.foreignBlockers), [], 'the next projection observes an intervening native lane hold');
  assert.deepEqual(reads, { items: 1, holds: 1, families: 0 });
});
