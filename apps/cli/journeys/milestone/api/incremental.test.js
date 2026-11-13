import { AGENT_SHELL_MARKERS } from '../../../../../packages/kernel/index.js';
import { openBoard } from '../../../../lib/index.js';
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { main } from '../../../tests/fixtures/native.js';
import { closeBoard } from '../../../../../packages/store/index.js';
import { events as boardEvents } from '../../../../../packages/store/index.js';
import { verdictsFor } from '../../../../../packages/store/index.js';
import { apiFetch } from '../../../tests/fixtures/api.js';
import { addRoutedItem } from '../../../tests/fixtures/api.js';
import { commitWork } from '../../../tests/fixtures/api.js';
import { checkOutSubmitted } from '../../../tests/fixtures/api.js';
import { settleSubmit } from '../../../tests/fixtures/submit/settle.js';
import { json } from '../../../tests/fixtures/api/project.js';
import { SPEC } from '../../../tests/fixtures/api/project.js';
import { runLocal } from '../../../tests/fixtures/api/milestone.js';
import { settledProject } from '../../../tests/fixtures/api/milestone.js';
import { startLocalHandler } from '../../../tests/fixtures/api/milestone.js';
import { jobQueueEmpty } from '../../../tests/fixtures/api/milestone.js';

test('one move recomputes only the items it touched [A2,N26]', async (t) => {
  const box = settledProject();
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  // @pullboard-board-file journey: seed the fixture board the real served API then reads.
  const board = openBoard(boardFile, undefined, { isMain: true });
  const ids = [];
  try {
    for (let index = 0; index < 300; index += 1) {
      ids.push(addRoutedItem(board, {
        by: 'coordinator', lane: 'app', title: `Incremental item ${String(index + 1).padStart(3, '0')}`,
        criterion: `Exercise item projection ${index + 1}`, specIds: ['G1'], route: index === 2 ? 'mid' : 'light',
        brief: 'Files:\n- app/incremental-fixture.js\nChange:\n- Preserve the fixture item.\nTest:\n- The API projection matches a full rebuild.',
        check: 'true',
        ...(index === 1 ? { after: [ids[0]] } : {}),
      }));
    }
  } finally {
    closeBoard(board);
  }
  assert.equal(ids.length, 300);

  const builder = json(box, box.repo, 'worktree', ['app', '--route', 'light', '--model', 'fixture-builder']);
  const verifier = json(box, box.repo, 'worktree', ['app', '--route', 'light', '--model', 'fixture-verifier']);
  /** Execute the real CLI with only this test's private homes, Git config and PATH. */
  async function runFixtureCommand(argv, io) {
    const keys = new Set([...Object.keys(box.env), ...AGENT_SHELL_MARKERS, 'PULLBOARD_RELAY_TOKEN', 'npm_config_cache']);
    const previous = new Map([...keys].map((key) => [key, process.env[key]]));
    try {
      for (const key of keys) {
        if (Object.hasOwn(box.env, key)) process.env[key] = box.env[key];
        else delete process.env[key];
      }
      process.env.npm_config_cache = join(box.dir, 'npm-cache');
      return await main(argv, io);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
  /** The fixture project as the gate settle seam reads it: an async run answering code, out and err. */
  const settleBox = { repo: box.repo, env: box.env, run: async (cwd, ...args) => {
    const result = await runLocal(box, cwd, ...args);
    return { code: result.status, out: result.stdout, err: result.stderr };
  } };
  const realDateNow = Date.now.bind(Date);
  const realWallStart = realDateNow();
  let clockOffsetMs = 0;
  t.mock.timers.enable({ apis: ['Date'], now: realWallStart });
  /** Preserve real elapsed wall time while allowing an explicit offset for eventless expiry. */
  function setTestClock() {
    t.mock.timers.setTime(realWallStart + (realDateNow() - realWallStart) + clockOffsetMs);
  }
  setTestClock();
  const builds = [];
  let stateBuilds = 0;
  const api = await startLocalHandler(t, box, {
    runCommand: runFixtureCommand,
    personChannel: 'api', stateDetail: 'full',
    onStateBuild: () => { stateBuilds += 1; },
    onItemBuild: (entry) => builds.push(entry.itemId),
  });
  const boardListing = await apiFetch(api, '/api/v1/boards');
  assert.equal(boardListing.status, 200);
  const boardId = (await boardListing.json()).boards.find((entry) => entry.root === box.repo).id;
  const path = `/api/v1/boards/${boardId}`;

  /** Send one authenticated local API move and return its versioned response. */
  async function move(verb, item, args = {}, agent = 'coordinator') {
    setTestClock();
    const response = await apiFetch(api, `${path}/moves`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verb, ...(item === undefined ? {} : { item }), args, agent }),
    });
    const document = await response.json();
    assert.equal(response.status, 200, `${verb} move: ${JSON.stringify(document)}`);
    return document;
  }

  /** Name each JSON path where two state projections differ, so a drift reads as fields rather than two dumped boards. */
  const stateDiffs = (a, b, at = '$', out = []) => { if (JSON.stringify(a) !== JSON.stringify(b)) { if (a && b && typeof a === 'object' && typeof b === 'object') for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) stateDiffs(a[key], b[key], `${at}.${key}`, out); else out.push([at, a, b]); } return out; };
  /** Read one handler's full state at the controlled instant. */
  async function fullState(handler, label) { const response = await apiFetch(handler, `${path}/state?detail=full`); assert.equal(response.status, 200, `${label}: full state response`); return (await response.json()).state; }
  /** Compare the live cached full state with a fresh full projection; seats may append itemless usage events after a command returns, so only a board still across the fresh build compares. */
  async function assertFreshFullState(label) {
    for (let attempt = 1; ; attempt += 1) {
      setTestClock();
      const comparisonTime = Date.now(), before = await fullState(api, `${label}: live`);
      const fresh = await startLocalHandler(t, box, { personChannel: 'api', stateDetail: 'full' });
      const rebuilt = await fullState(fresh, `${label}: fresh`).finally(() => fresh.close()), after = await fullState(api, `${label}: live again`);
      assert.equal(Date.now(), comparisonTime, `${label}: both state projections use the same controlled instant`);
      if (attempt < 20 && stateDiffs(before, after).length) continue; // Each fresh build is the wait: the board moved during it, so build again.
      // The recent-activity window is read from the wall clock at each build, so only its bounds may differ between the two builds.
      assert.deepEqual(stateDiffs(after, rebuilt).filter(([at]) => !/^\$\.dashboardRecent\.(?:since|until)$/u.test(at)).slice(0, 20), [], `${label}: incremental state equals a clean full rebuild`);
      return after;
    }
  }

  /** Run one read against the fixture board without changing its event cursor. */
  function readBoard(read) {
    // @pullboard-board-file journey: read the fixture board the real served API holds, without moving its event cursor.
    const current = openBoard(boardFile, undefined, { isMain: true });
    try { return read(current); }
    finally { closeBoard(current); }
  }
  /** Read one item's current lease from the fixture board. */
  const leaseUntil = (itemId) => readBoard((current) => current.db.prepare('SELECT item_lease_until FROM item WHERE item_id = ?').get(itemId).item_lease_until);

  try {
    const initialResponse = await apiFetch(api, `${path}/state?detail=full`);
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json();
    assert.equal(initial.state.items.length, 300);
    assert.equal(builds.length, 300, 'the initial full snapshot projects each item once');
    assert.equal(stateBuilds, 1);

    builds.length = 0;
    await move('edit', ids[2], { criterion: 'One item changed after the warm snapshot' });
    const edited = await assertFreshFullState('single item edit');
    assert.deepEqual(builds, [ids[2]], 'one item move rebuilds only its touched item');
    assert.equal(edited.items.find((item) => item.id === ids[2]).criterion, 'One item changed after the warm snapshot');

    builds.length = 0;
    await move('claim', ids[0], {}, builder.agent);
    commitWork(box, builder, ids[0]);
    // Under pull dispatch the submit only queues its gate; wait for the loopback runner's receipt before the verifier's next [P7].
    const submitted = await move('submit', ids[0], {}, builder.agent);
    await settleSubmit(t, settleBox, submitted.result ?? submitted);
    checkOutSubmitted(box, builder, verifier); await move('next', undefined, { verify: true }, verifier.agent);
    // Keep the fixture's trunk fixed so automatic landing cannot invalidate every item during this incremental check.
    writeFileSync(join(box.repo, 'landing-fixture-dirty'), 'hold the trunk\n');
    await move('verify', ids[0], { decision: 'accept', reason: 'CRITERION_MET', note: 'verified dependency' }, verifier.agent);
    builds.length = 0;
    const dependencyState = await assertFreshFullState('verified dependency');
    // A pulled submit only queues its gate, so it may or may not have handed its seat the next light item; any such claim is recomputed too.
    const nextClaimed = dependencyState.items.find((item) => item.id === ids[3])?.claim ? [ids[3]] : [];
    // The runner's own events for these items can recompute them again while the fresh build runs, so each is counted once.
    assert.deepEqual([...new Set(builds)].sort((a, b) => a - b), [ids[0], ids[1], ...nextClaimed], 'the verified item, its dependent and any next light item a seat claimed on submit are recomputed');
    assert.deepEqual(dependencyState.items.find((item) => item.id === ids[1]).blockedBy, [],
      'the waiting item becomes unblocked when its dependency is verified');
    for (const extra of dependencyState.items.filter((item) => [ids[1], ids[3]].includes(item.id) && item.claim)) {
      assert.ok([builder.agent, verifier.agent].includes(extra.claim.by), 'the extra claim belongs to a fixture seat');
      const owner = extra.claim.by === builder.agent ? builder : verifier;
      const released = await runLocal(box, owner.path, 'release', String(extra.id), '--reason', 'OTHER', '--note', 'isolate the later lease expiry', '--no-next');
      assert.equal(released.status, 0, released.stderr || released.stdout);
    }
    await assertFreshFullState('release the extra claims');

    // The loopback runner may still be landing or gating the verified item; let its queue empty so only the shout can move the board [P7].
    await jobQueueEmpty(box);
    await assertFreshFullState('runner queue settled');
    builds.length = 0;
    await move('shout', undefined, { to: 'all', text: 'Board-only change for incremental projection' });
    const shouted = await assertFreshFullState('board-only shout');
    assert.deepEqual(builds, [], 'an event with no item_id recomputes zero item bodies');
    assert.ok(shouted.shouts.some((entry) => entry.shout_text === 'Board-only change for incremental projection'));

    const detailBuilds = [];
    let detailStateBuilds = 0;
    const detailOnly = await startLocalHandler(t, box, {
      personChannel: 'api', stateDetail: 'full',
      onStateBuild: () => { detailStateBuilds += 1; },
      onItemBuild: (entry) => detailBuilds.push(entry.itemId),
    });
    try {
      const detailResponse = await apiFetch(detailOnly, `${path}/items/${ids[17]}`);
      assert.equal(detailResponse.status, 200);
      assert.equal((await detailResponse.json()).item.id, ids[17]);
      assert.deepEqual(detailBuilds, [ids[17]], 'a cold item detail projects only its requested item');
      assert.equal(detailStateBuilds, 0, 'a cold item detail does not build or queue behind a full board snapshot');
    } finally {
      await detailOnly.close();
    }

    builds.length = 0;
    const specFile = join(box.repo, 'SPEC.md');
    writeFileSync(specFile, SPEC.replace('The fixture keeps its board.', 'The fixture keeps its changed specification.'));
    await assertFreshFullState('SPEC.md change');

    builds.length = 0;
    const configFile = join(box.repo, 'pullboard.json');
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    config.agents.names = 'prefix';
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    await assertFreshFullState('pullboard.json change');

    builds.length = 0;
    const milestone = await runLocal(box, box.repo, 'milestone', 'add', 'Incremental milestone', '--reason', 'Arrange fixture release', '--items', String(ids[4]));
    assert.equal(milestone.status, 0, milestone.stderr || milestone.stdout);
    const milestoneState = await assertFreshFullState('milestone change');
    assert.deepEqual(builds, [ids[4]], 'changing one milestone membership recomputes only the affected item');
    assert.equal(milestoneState.items.find((item) => item.id === ids[4]).milestone, 'Incremental milestone');

    builds.length = 0;
    await move('claim', ids[299], {}, builder.agent);
    const claimed = await assertFreshFullState('claim before lease expiry');
    assert.equal(claimed.items.find((item) => item.id === ids[299]).status, 'claimed');
    const lease = leaseUntil(ids[299]);
    // A seat may append itemless usage events after its claim returns, so the baseline is read right before the clock moves.
    await jobQueueEmpty(box);
    const sequenceBeforeExpiry = (await fullState(api, 'sequence before lease expiry')).sequence;
    clockOffsetMs += Date.parse(lease) - Date.now() + 1;
    setTestClock();
    builds.length = 0;
    const expired = await assertFreshFullState('eventless claim lease expiry');
    assert.equal(leaseUntil(ids[299]), lease, 'advancing the test clock leaves the persisted lease deadline unchanged');
    const lateEvents = readBoard((current) => current.db.prepare('SELECT event_id, event_by, event_kind, item_id, event_at FROM event WHERE event_id > ?').all(sequenceBeforeExpiry));
    // A seat's own itemless usage checkpoint can land after its claim returns; expiry itself appends nothing else.
    assert.deepEqual(lateEvents.filter((event) => event.event_kind !== 'usage'), [], 'lease expiry appends no board event');
    assert.equal(expired.items.find((item) => item.id === ids[299]).status, 'open');
    assert.deepEqual(builds, [ids[299]], 'eventless lease expiry recomputes only the expired claim');

    // @pullboard-board-file journey: read the board file the real served API incrementally projected.
    const queryBoard = openBoard(boardFile, undefined, { isMain: true });
    try {
      const queries = [];
      const trackedBoard = { ...queryBoard, db: {
        prepare(sql) {
          const statement = queryBoard.db.prepare(sql);
          return { all(...params) { queries.push({ sql, params }); return statement.all(...params); } };
        },
      } };
      boardEvents(trackedBoard, { itemId: ids[17] });
      verdictsFor(trackedBoard, ids[17]);
      const itemQueries = queries.filter(({ sql }) => /\bFROM\s+(?:event|verdict)\b/iu.test(sql));
      assert.ok(itemQueries.some(({ sql }) => /FROM\s+event\s+WHERE\s+item_id\s*=\s*\?/iu.test(sql)),
        'the production item-events query binds item_id directly');
      assert.ok(itemQueries.some(({ sql }) => /FROM\s+verdict\s+WHERE\s+item_id\s*=\s*\?/iu.test(sql)),
        'the production verdict query binds item_id directly');
      assert.ok(!itemQueries.some(({ sql }) => /\?\s+IS\s+NULL\s+OR\s+item_id/iu.test(sql)),
        'the production item-events query has no index-blocking optional-filter form');
      for (const { sql, params } of itemQueries) {
        const plan = queryBoard.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(({ detail }) => detail).join('\n');
        if (/\bFROM\s+event\b/iu.test(sql)) {
          assert.match(plan, /SEARCH\s+event\s+USING\s+(?:COVERING\s+)?INDEX\s+event_item_id_event_id/iu,
            `item event query uses its item_id index:\n${sql}\n${plan}`);
        } else {
          assert.match(plan, /SEARCH\s+verdict\s+USING\s+(?:COVERING\s+)?INDEX\s+verdict_item_id_verdict_id/iu,
            `item verdict query uses its item_id index:\n${sql}\n${plan}`);
        }
        assert.doesNotMatch(plan, /SCAN\s+(?:event|verdict)\b/iu, `item query has no full-table scan:\n${sql}\n${plan}`);
      }
      assert.ok(itemQueries.some(({ sql }) => /FROM\s+event\s+WHERE\s+item_id\s*=\s*\?.*event_kind/isu.test(sql)),
        "verdict receipts are read from the item's event rows");
      assert.ok(itemQueries.some(({ sql, params }) => /FROM\s+event\s+WHERE\s+item_id\s*=\s*\?/iu.test(sql)
        && params.length === 1 && params[0] === ids[17]), 'the production scoped event query binds the requested item id');
      assert.ok(itemQueries.some(({ sql, params }) => /FROM\s+verdict\s+WHERE\s+item_id\s*=\s*\?/iu.test(sql)
        && params.length === 1 && params[0] === ids[17]), 'the production scoped verdict query binds the requested item id');
      const indexes = queryBoard.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(({ name }) => name);
      assert.ok(indexes.includes('event_item_id_event_id'));
      assert.ok(indexes.includes('verdict_item_id_verdict_id'));
    } finally {
      closeBoard(queryBoard);
    }

    await api.close();
    const legacy = new DatabaseSync(boardFile);
    // A board from before these indexes carries an older user_version; only that makes an open migrate (#1047).
    try { legacy.exec('DROP INDEX event_item_id_event_id; DROP INDEX verdict_item_id_verdict_id; PRAGMA user_version = 1;'); }
    finally { legacy.close(); }
    // This positive migration control uses a private database; branch code cannot repair
    // persistent indexes on the repository-shared board by supplying isMain: true.
    const privateLegacy = join(box.dir, 'index-migration.sqlite');
    cpSync(boardFile, privateLegacy);
    // @pullboard-board-file migration: open a private legacy copy to prove the index migration.
    const migrated = openBoard(privateLegacy);
    try {
      const restored = migrated.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(({ name }) => name);
      assert.ok(restored.includes('event_item_id_event_id'), 'reopening an existing board restores the event item index');
      assert.ok(restored.includes('verdict_item_id_verdict_id'), 'reopening an existing board restores the verdict item index');
    } finally {
      closeBoard(migrated);
    }
  } finally {
    await api.close();
  }
});

