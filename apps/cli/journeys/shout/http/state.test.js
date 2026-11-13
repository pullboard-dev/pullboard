/** @pullboard-test-input apps/cli/pullboard.js */
/** Real HTTP state: summaries, details, deltas and milestone status against the actual board engine (A2). */
import {
  viewApiPorts,
} from '../../../../view/index.js';
import {
  apiBoardOpeners,
} from '../../../tests/fixtures/board.js';
import assert from 'node:assert/strict';
import {
  runFixtureGit,
} from '../../../tests/fixtures/child.js';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  spawn,
} from 'node:child_process';
import {
  createServer,
} from 'node:http';
import {
  join,
  resolve,
} from 'node:path';
import {
  test,
} from 'node:test';
import {
  createLocalApiHandler,
  WHOLE_STATE_DELTA_FIELDS,
  serveApi,
} from '../../../../../packages/api/index.js';
import {
  refusalDocument,
} from '../../../index.js';
import {
  main,
} from '../../../tests/fixtures/native.js';
import {
  applyStateDelta,
} from '../../../../../packages/api/index.js';
import {
  board as store,
} from '../../../../lib/index.js';
import {
  apiHttpFixture as fixture,
} from '../../../tests/fixtures/api.js';
import {
  apiHttpBox as httpBox,
} from '../../../tests/fixtures/api.js';
import {
  startFixtureLocalRunner,
  whenRunnerSettles,
} from '../../../tests/fixtures/runner/local-start.js';
import {
  stopFixtureLocalRunner,
} from '../../../tests/fixtures/runner/local-stop.js';
import {
  fetchFresh,
} from '../../../tests/fixtures/http.js';
import {
  commitWork,
  checkOutSubmitted,
  withoutClaimHealth,
  FIXTURE_BRIEF,
  DETAIL_BRIEF,
} from '../../../tests/fixtures/api.js';
const BIN = resolve(import.meta.dirname, '../../../pullboard.js');

/**
 * Submit one claimed item through the served board and wait for its pulled gate to settle.
 *
 * Why: a pulled submit leaves the item claimed until the host's local runner posts the gate receipt, so a review or a
 * snapshot read right after the move would see no submission [P7,N26].
 */
async function submitSettled(t, box, move, id, agent) {
  if (!box.localRunnerStarted) {
    startFixtureLocalRunner(box.env, box.root);
    box.localRunnerStarted = true;
    t.after(() => stopFixtureLocalRunner(box.env.PULLBOARD_MACHINE_HOME));
  }
  const result = await move({ verb: 'submit', item: id, agent });
  await whenRunnerSettles(box.env, async () => {
    const row = (await box.call(box.path + '/state')).document.state.items.find((entry) => entry.id === id);
    return row.status === 'claimed' ? null : row;
  }, { deadlineMs: 60_000, what: `the pulled gate of #${id}` });
  return result;
}

/** Prove the authenticated HTTP state reuses a complete snapshot until one of its inputs changes. */
async function cachedHttpStateTest(t) {
  let builds = 0;
  const box = await httpBox(t, { onStateBuild: () => { builds += 1; } });
  const agent = await box.cliLocal(box.root, 'worktree', 'app', '--model', 'fixture-agent');
  const hostileShout = 'cache baseline "quoted" \\ path\nline\n", "proofStats": {"flow":"forged"}';
  await box.cliLocal(box.root, 'shout', 'app', hostileShout);

  const first = await box.call(box.path + '/state');
  assert.equal(first.status, 200);
  assert.equal(builds, 1);
  assert.ok(first.document.state.shouts.some((shout) => shout.shout_text === hostileShout));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const unchanged = await box.call(box.path + '/state');
  assert.equal(builds, 1, 'an identical refresh reuses the complete board state');
  assert.ok(unchanged.document.state.shouts.some((shout) => shout.shout_text === hostileShout));
  assert.notEqual(unchanged.document.state.proofStats.flow.asOf, first.document.state.proofStats.flow.asOf);

  const latestShout = first.document.state.shouts.at(-1).shout_id;
  const unread = await box.call(box.path + '/state?seen=0');
  assert.equal(unread.document.state.unseen.since, 0);
  assert.ok(unread.document.state.unseen.count > 0);
  const read = await box.call(box.path + '/state?seen=' + latestShout);
  assert.deepEqual(read.document.state.unseen, { since: latestShout, count: 0 });
  assert.equal(builds, 1, 'the request-specific seen cursor does not rebuild or mutate the shared state');

  await box.cliLocal(box.root, 'add', 'app', 'cache invalidation item', '--criterion', 'visible after the next refresh', '--specs', 'G1');
  const moved = await box.call(box.path + '/state');
  assert.equal(builds, 2);
  assert.ok(moved.document.state.items.some((item) => item.title === 'cache invalidation item'));

  writeFileSync(join(box.root, 'SPEC.md'), '# HTTP fixture\n\n## Goals\n- G1 [approved, must] Keep the board. | gate: true\n- G2 [approved, must] Keep the cache fresh. | gate: true\n');
  const spec = await box.call(box.path + '/state');
  assert.equal(builds, 3);
  assert.ok(spec.document.state.spec.some((row) => row.id === 'G2'));

  const configFile = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, lease: '1m', lanes: { ...config.lanes, ops: { owns: [] } } }));
  const configured = await box.call(box.path + '/state');
  assert.equal(builds, 4);
  assert.ok(configured.document.state.lanes.includes('ops'));

  writeFileSync(join(box.root, 'DOCTRINE.md'), '# Local rules\n\n## Team Rules\n\n- LOCAL1 [approved, must] Keep the local board readable. | gate: true\n');
  const doctrine = await box.call(box.path + '/state');
  assert.equal(builds, 5);
  assert.ok(doctrine.document.state.practice.some((row) => row.id === 'LOCAL1'));

  writeFileSync(join(box.root, 'cache-head.txt'), 'advance HEAD without a board event\n');
  runFixtureGit(['add', 'cache-head.txt'], { cwd: box.root, env: box.env, stdio: 'pipe' });
  runFixtureGit(['commit', '-q', '-m', 'chore: advance fixture head'], { cwd: box.root, env: box.env, stdio: 'pipe' });
  const headed = await box.call(box.path + '/state');
  assert.equal(builds, 6);
  const head = runFixtureGit(['rev-parse', 'HEAD'], { cwd: box.root, env: box.env, stdio: 'pipe' });
  assert.equal(headed.document.state.rowAgesAt['SPEC.md'], head);

  await box.cliLocal(box.root, 'shout', 'app', 'agent inbox cursor');
  const beforeInbox = await box.call(box.path + '/state');
  const agentBeforeInbox = beforeInbox.document.state.agents.find((entry) => entry.agent_id === agent.agent);
  const boardBeforeInbox = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try {
    store.inbox(boardBeforeInbox, agent.agent);
  } finally {
    store.closeBoard(boardBeforeInbox);
  }
  const afterInbox = await box.call(box.path + '/state');
  const agentAfterInbox = afterInbox.document.state.agents.find((entry) => entry.agent_id === agent.agent);
  assert.equal(agentAfterInbox.agent_last_shout_id, Math.max(...beforeInbox.document.state.shouts.map((shout) => shout.shout_id)));
  assert.notEqual(agentAfterInbox.agent_last_shout_id, agentBeforeInbox.agent_last_shout_id);
  assert.equal(builds, 8, 'an inbox cursor change without an event invalidates the agent projection');

  const added = await box.call(box.path + '/moves', { verb: 'add', args: { lane: 'app', title: 'Lease cache item', criterion: 'remain current', specs: 'G1', brief: FIXTURE_BRIEF } });
  assert.equal(added.status, 200);
  const itemId = added.document.result.item.item_id;
  const claimed = await box.call(box.path + '/moves', { verb: 'claim', item: itemId, agent: agent.agent });
  assert.equal(claimed.status, 200);
  const active = await box.call(box.path + '/state');
  assert.equal(active.document.state.items.find((item) => item.id === itemId).status, 'claimed');
  const lastEvent = active.document.state.events[0].event_id;
  const leaseBoard = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  let leaseUntil;
  try {
    leaseUntil = leaseBoard.db.prepare('SELECT item_lease_until FROM item WHERE item_id = ?').get(itemId).item_lease_until;
  } finally {
    store.closeBoard(leaseBoard);
  }
  assert.ok(Number.isFinite(Date.parse(leaseUntil)));
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  t.mock.timers.tick(Math.max(1, Date.parse(leaseUntil) - now + 1));
  const expired = await box.call(box.path + '/state');
  assert.equal(expired.document.state.items.find((item) => item.id === itemId).status, 'open');
  assert.equal(expired.document.state.items.find((item) => item.id === itemId).claim, null);
  assert.equal((await box.call(box.path + '/items/' + itemId)).document.item.owner, null);
  assert.equal(expired.document.state.events[0].event_id, lastEvent, 'lease expiry changed no board event');
  assert.equal(builds, 10, 'clock-only lease expiry invalidates the cached state');
}

test('[A2, N26] an unchanged board state is reused and a move rebuilds it', cachedHttpStateTest);

test("[A2, N26] the board state sends summaries and an item's detail comes from its own path", async (t) => {
  const box = await httpBox(t);
  const builder = await box.cliLocal(box.root, 'worktree', 'app', '--model', 'fixture-builder', '--family', 'codex');
  const verifier = await box.cliLocal(box.root, 'worktree', 'app', '--model', 'fixture-verifier', '--family', 'claude');
  /** Make one real board move through HTTP and return its result. */
  async function move(body) {
    const moved = await box.call(box.path + '/moves', body);
    assert.equal(moved.status, 200, JSON.stringify(moved.document));
    return moved.document.result;
  }
  const accepted = (await move({ verb: 'add', args: {
    lane: 'app', title: 'Accepted summary item', criterion: 'Every list reads the Zebra marker', brief: DETAIL_BRIEF,
    specs: 'G1', check: 'true', wait: true,
  } })).item.item_id;
  await move({ verb: 'claim', item: accepted, agent: builder.agent });
  await move({ verb: 'fact', item: accepted, agent: builder.agent, args: { kind: 'note', text: 'a fact only the thread carries' } });
  commitWork(box, builder, accepted); await submitSettled(t, box, move, accepted, builder.agent);
  checkOutSubmitted(box, builder, verifier); await move({ verb: 'next', agent: verifier.agent, args: { verify: true } });
  await move({ verb: 'verify', item: accepted, agent: verifier.agent, args: { decision: 'accept', reason: 'CRITERION_MET', note: 'ran the check and read the summary' } });
  const claimed = (await move({ verb: 'add', args: { lane: 'app', title: 'Claimed summary item', criterion: 'stays claimed', specs: 'G1', brief: FIXTURE_BRIEF } })).item.item_id;
  await move({ verb: 'claim', item: claimed, agent: builder.agent });
  const open = (await move({ verb: 'add', args: { lane: 'app', title: 'Open summary item', criterion: 'waits for a builder', specs: 'G1', brief: FIXTURE_BRIEF } })).item.item_id;
  await box.cliLocal(box.root, 'milestone', 'add', 'Delivery', '--reason', 'Arrange fixture release', '--items', String(accepted));
  const board = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  let leaseUntil;
  try { leaseUntil = board.db.prepare('SELECT item_lease_until FROM item WHERE item_id = ?').get(claimed).item_lease_until; } finally { store.closeBoard(board); }

  const summaryFields = ['id', 'title', 'lane', 'status', 'route', 'milestone', 'specs', 'claim', 'builtBy', 'blockedBy', 'progress', 'updatedAt', 'stage', 'since', 'counts', 'verdict', 'withdrawnReason', 'withdrawnFrom'];
  const summaryState = await box.call(box.path + '/state');
  assert.equal(summaryState.status, 200);
  const fullState = await box.call(box.path + '/state?detail=full');
  assert.equal(fullState.status, 200);
  const summaries = new Map(summaryState.document.state.items.map((item) => [item.id, item]));
  const fulls = new Map(fullState.document.state.items.map((item) => [item.id, item]));
  assert.deepEqual([...summaries.keys()], [open, claimed, accepted], 'the state still lists every item, in board order');
  assert.deepEqual([...fulls.keys()], [...summaries.keys()]);
  for (const summary of summaries.values()) {
    assert.deepEqual(Object.keys(summary), summaryFields, `#${summary.id} carries only the summary fields`);
  }
  for (const full of fulls.values()) {
    for (const field of ['thread', 'verdicts', 'history', 'brief', 'criterion', 'check', ...summaryFields]) assert.ok(Object.hasOwn(full, field), `detail=full keeps #${full.id}'s ${field}`);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(summaryState.document)) < Buffer.byteLength(JSON.stringify(fullState.document)));
  assert.equal(JSON.stringify(summaryState.document).includes('A brief only the detail carries'), false, 'no brief text in the summaries');
  assert.equal(JSON.stringify(summaryState.document).includes('Zebra'), false, 'no criterion text in the summaries');

  const acceptedFull = fulls.get(accepted);
  const mergedEvent = acceptedFull.history.findLast((event) => event.kind === 'merged');
  const lastAcceptedEvent = mergedEvent ?? acceptedFull.history.findLast((event) => event.kind === 'accept');
  assert.ok(lastAcceptedEvent, 'the fixture item was accepted');
  assert.deepEqual(summaries.get(accepted), {
    id: accepted, title: 'Accepted summary item', lane: 'app', status: 'verified', route: acceptedFull.route, milestone: 'Delivery',
    specs: ['G1'], claim: null, builtBy: builder.agent, blockedBy: [], progress: acceptedFull.progress, updatedAt: acceptedFull.updatedAt, stage: mergedEvent ? 'merged' : 'accepted',
    since: lastAcceptedEvent.at, counts: { verdicts: 1, facts: acceptedFull.thread.filter((entry) => entry.type === 'fact').length },
    verdict: { decision: 'ACCEPT', reason: 'CRITERION_MET' }, withdrawnReason: null, withdrawnFrom: null,
  });
  const claimedFull = fulls.get(claimed);
  assert.deepEqual(summaries.get(claimed).claim, { by: builder.agent, until: leaseUntil });
  assert.equal(summaries.get(claimed).stage, 'claimed');
  assert.equal(summaries.get(claimed).since, claimedFull.history.findLast((event) => event.kind === 'claim').at);
  assert.deepEqual(summaries.get(open), {
    id: open, title: 'Open summary item', lane: 'app', status: 'open', route: fulls.get(open).route, milestone: null,
    specs: ['G1'], claim: null, builtBy: null, blockedBy: [], progress: fulls.get(open).progress, updatedAt: fulls.get(open).updatedAt, stage: 'open',
    since: fulls.get(open).history.find((event) => event.kind === 'add').at, counts: { verdicts: 0, facts: 0 }, verdict: null, withdrawnReason: null, withdrawnFrom: null,
  });
  assert.deepEqual(summaryState.document.state.moveCounts, {
    'open>claimed:claim': 2, 'claimed>submitted:submit': 1, 'submitted>submitted:reserve': 1, 'submitted>verified:accept': 1,
  }, 'the lifecycle drawing tallies the moves without any history; the submit\'s own lease renewal is no re-claim');
  assert.deepEqual(fullState.document.state.moveCounts, summaryState.document.state.moveCounts);

  for (const [id, full] of fulls) {
    const detail = await box.call(box.path + '/items/' + id);
    assert.equal(detail.status, 200);
    assert.deepEqual({ ...summaries.get(id), ...detail.document.item }, withoutClaimHealth(full), `#${id}'s summary and detail make its full item`);
    const carried = Object.keys(detail.document.item).filter((field) => summaryFields.includes(field));
    assert.deepEqual(carried, ['id', 'withdrawnReason', 'withdrawnFrom', 'verdict'], 'the detail repeats identity, withdrawal facts and the whole latest verdict');
    for (const field of ['thread', 'verdicts', 'history', 'brief', 'criterion', 'check', 'owner', 'reviewer', 'reviewUntil', 'verifiedBy', 'commit', 'merged']) {
      assert.ok(Object.hasOwn(detail.document.item, field), `#${id}'s detail carries ${field}`);
    }
  }
  const acceptedDetail = (await box.call(box.path + '/items/' + accepted)).document.item;
  assert.equal(acceptedDetail.brief, DETAIL_BRIEF);
  assert.equal(acceptedDetail.criterion, 'Every list reads the Zebra marker');
  assert.equal(acceptedDetail.check, 'true');
  assert.equal(acceptedDetail.checkBaseline.result, 'green');
  assert.match(acceptedDetail.verdict.note, /^ran the check and read the summary\n(?:reused submit proof [0-9a-f-]+(?:, [0-9a-f-]+)*\n)?verified against agent-approved G1$/u,
    'the post-init approved fixture row qualifies the receipt without losing the reviewer note');
  assert.deepEqual(acceptedDetail.thread.filter((entry) => entry.type === 'fact').map((entry) => entry.text).filter((text) => !/^(?:Tier-1 shadow for gate receipt|Review comparison: |Gate job gate:)/u.test(text)), ['a fact only the thread carries']);

  /** Search through HTTP and return the matching ids in board order. */
  const search = async (text) => {
    const found = await box.call(box.path + '/items?q=' + encodeURIComponent(text));
    assert.equal(found.status, 200);
    return found.document.ids;
  };
  assert.deepEqual(await search('zebra'), [accepted], 'the criterion is searched without being in the state');
  assert.deepEqual(await search('  CLAIMED summary '), [claimed], 'trimmed text matches a title, ignoring case');
  assert.deepEqual(await search('#' + open), [open], 'an #id matches its item');
  assert.deepEqual(await search('g1'), [open, claimed, accepted], 'spec ids match');
  assert.deepEqual(await search('APP'), [open, claimed, accepted], 'the lane matches');
  assert.deepEqual(await search(''), [open, claimed, accepted], 'no text matches every item, as the view shows them all');
  assert.deepEqual(await search('no item says this'), []);

  const missing = await box.call(box.path + '/items/9999');
  assert.equal(missing.status, 404);
  assert.equal(missing.document.error.code, 'NO_ITEM');
  for (const rawId of ['0', 'abc', '1.5']) {
    const malformed = await box.call(box.path + '/items/' + rawId);
    assert.equal(malformed.status, 400);
    assert.equal(malformed.document.error.code, 'BAD_REQUEST');
  }
  const posted = await box.call(box.path + '/items/' + accepted, {});
  assert.equal(posted.status, 400);
  const badDetail = await box.call(box.path + '/state?detail=everything');
  assert.equal(badDetail.status, 400);
  assert.equal(badDetail.document.error.code, 'BAD_REQUEST');
  assert.deepEqual((await box.call(box.path + '/state?detail=summary')).document.state.items, summaryState.document.state.items);

  // pullboard serve itself sends summaries; a page's own server, built as the view builds it, keeps full items until it opts in.
  // Stays a process: a real pullboard serve whose own summaries are under test.
  const served = spawn(process.execPath, [BIN, 'serve', '--port', '0', '--json'], { cwd: box.root, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((done) => served.once('close', done));
  t.after(async () => { served.kill('SIGTERM'); await exited; });
  const servedUrl = await new Promise((found, fail) => {
    let out = '';
    served.stdout.setEncoding('utf8');
    served.stdout.on('data', (chunk) => {
      out += chunk;
      const match = /"url":\s*"([^"]+)"/.exec(out);
      if (match) found(new URL(match[1]));
    });
    served.once('close', (code) => fail(new Error('pullboard serve exited ' + code + ' before printing its address: ' + out)));
  });
  const servedState = await fetchFresh(servedUrl.origin + box.path + '/state', { headers: { 'x-pullboard-key': servedUrl.searchParams.get('k') } });
  assert.equal(servedState.status, 200);
  assert.deepEqual((await servedState.json()).state.items, summaryState.document.state.items, 'pullboard serve sends the same summaries');
  let pagePort;
  const pageHandler = createLocalApiHandler({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, secret: 'page-fixture-secret', getPort: () => pagePort, runCommand: main, projects: () => [{ root: box.root, name: 'HTTP fixture' }] });
  const page = createServer(pageHandler);
  await new Promise((done) => page.listen(0, '127.0.0.1', done));
  pagePort = page.address().port;
  t.after(() => new Promise((done) => { pageHandler.close(); page.close(done); page.closeIdleConnections(); }));
  const pageState = await fetchFresh('http://127.0.0.1:' + pagePort + box.path + '/state', { headers: { 'x-pullboard-key': 'page-fixture-secret' } });
  assert.deepEqual((await pageState.json()).state.items, fullState.document.state.items, 'a page server that has not opted in keeps every item in full');
  const pageSummary = await fetchFresh('http://127.0.0.1:' + pagePort + box.path + '/state?detail=summary', { headers: { 'x-pullboard-key': 'page-fixture-secret' } });
  assert.deepEqual((await pageSummary.json()).state.items, summaryState.document.state.items, 'and sends summaries when asked');
});

test("[A2, N26] a sent-back item's summary carries its reject note's first line", async (t) => {
  const box = await httpBox(t);
  const builder = await box.cliLocal(box.root, 'worktree', 'app', '--model', 'fixture-builder', '--family', 'codex');
  const verifier = await box.cliLocal(box.root, 'worktree', 'app', '--model', 'fixture-verifier', '--family', 'claude');
  /** Make one real board move through HTTP and return its result. */
  async function move(body) {
    const moved = await box.call(box.path + '/moves', body);
    assert.equal(moved.status, 200, JSON.stringify(moved.document));
    return moved.document.result;
  }
  /** Build an item to submission and reserve its review for the verifier. */
  async function submitted(title) {
    const id = (await move({ verb: 'add', args: { lane: 'app', title, criterion: 'shows a greeting', specs: 'G1', brief: FIXTURE_BRIEF } })).item.item_id;
    await move({ verb: 'claim', item: id, agent: builder.agent });
    commitWork(box, builder, id); await submitSettled(t, box, move, id, builder.agent);
    checkOutSubmitted(box, builder, verifier); await move({ verb: 'next', agent: verifier.agent, args: { verify: true } });
    return id;
  }
  const note = 'The page shows no greeting.\nThe second line stays in the detail.';
  const rejected = await submitted('Rejected item');
  await move({ verb: 'verify', item: rejected, agent: verifier.agent, args: { decision: 'reject', reason: 'BEHAVIOR_MISMATCH', note, clause: 'shows a greeting' } });
  const accepted = await submitted('Accepted item');
  await move({ verb: 'verify', item: accepted, agent: verifier.agent, args: { decision: 'accept', reason: 'CRITERION_MET', note: 'The page greets by name.\nChecked twice.' } });

  const summaries = new Map((await box.call(box.path + '/state')).document.state.items.map((item) => [item.id, item]));
  assert.deepEqual(summaries.get(rejected).verdict, { decision: 'REJECT', reason: 'BEHAVIOR_MISMATCH', note: 'The page shows no greeting.' },
    'a sent-back row keeps its reason and the first line of the note');
  assert.deepEqual(summaries.get(accepted).verdict, { decision: 'ACCEPT', reason: 'CRITERION_MET' }, 'an accepted item carries no note');
  assert.equal((await box.call(box.path + '/items/' + rejected)).document.item.verdict.note, note, 'the whole note stays in the detail');

  // A verdict hands the verifier the next build, which is the item it just sent back; the builder takes it from there.
  await move({ verb: 'release', item: rejected, agent: verifier.agent, args: { reason: 'ROUTED_ELSEWHERE' } });
  await move({ verb: 'claim', item: rejected, agent: builder.agent });
  const reworked = (await box.call(box.path + '/state')).document.state.items.find((item) => item.id === rejected);
  assert.equal(reworked.verdict.note, 'The page shows no greeting.', 'a row being reworked still says why');
  const full = (await box.call(box.path + '/state?detail=full')).document.state.items.find((item) => item.id === rejected);
  assert.deepEqual({ ...reworked, ...(await box.call(box.path + '/items/' + rejected)).document.item }, withoutClaimHealth(full), 'the detail still completes the summary');
});

test('[A2, N26] a delta brings a snapshot up to date', async (t) => {
  const box = await httpBox(t);
  writeFileSync(join(box.root, 'SPEC.md'), '# HTTP fixture\n\n## Goals\n- G1 [approved, must] Keep the board. | gate: true\n- G2 [pending, must] Keep each delta small. | gate: true\n');
  runFixtureGit(['commit', '-qam', 'docs: ask whether deltas stay small'], { cwd: box.root, env: box.env, stdio: 'pipe' });
  const builder = await box.cliLocal(box.root, 'worktree', 'app', '--model', 'fixture-builder', '--family', 'codex');
  const verifier = await box.cliLocal(box.root, 'worktree', 'app', '--model', 'fixture-verifier', '--family', 'claude');
  /** Make one real board move through HTTP and return its result. */
  async function move(body) {
    const moved = await box.call(box.path + '/moves', body);
    assert.equal(moved.status, 200, JSON.stringify(moved.document));
    return moved.document.result;
  }
  const item = (await move({ verb: 'add', args: { lane: 'app', title: 'Delta item', criterion: 'moves through review', specs: 'G1', brief: FIXTURE_BRIEF } })).item.item_id;
  const waiting = (await move({ verb: 'add', args: { lane: 'app', title: 'Waiting item', criterion: 'stays open', specs: 'G1', after: String(item), brief: FIXTURE_BRIEF } })).item.item_id;

  const first = (await box.call(box.path + '/state')).document.state;
  assert.ok(Number.isSafeInteger(first.sequence), 'a snapshot names the event it reflects');
  let held = first;
  /**
   * Ask for what changed since the held snapshot, apply it, and compare it with a fresh snapshot
   * read at the same instant, so the flow observation in both is the same.
   */
  async function catchUp(label, observedAt = Date.now()) {
    t.mock.timers.enable({ apis: ['Date'], now: observedAt });
    try {
      // A submit's handoff worker may append its own events between the two reads; compare only a pair read at one sequence.
      let answer = await box.call(box.path + '/state?since=' + held.sequence);
      let fresh = await box.call(box.path + '/state');
      for (let attempt = 0; attempt < 200 && answer.document.sequence !== fresh.document.state?.sequence; attempt += 1) {
        answer = await box.call(box.path + '/state?since=' + held.sequence);
        fresh = await box.call(box.path + '/state');
      }
      assert.equal(answer.status, 200, label);
      assert.ok(answer.document.delta, `${label}: ${JSON.stringify(answer.document.reset)}`);
      assert.equal(answer.document.since, held.sequence, label);
      assert.equal(answer.document.sequence, fresh.document.state.sequence, `${label}: the delta names the new latest sequence`);
      assert.equal(answer.document.eventLogVersion, fresh.document.eventLogVersion, label);
      const updated = applyStateDelta(held, answer.document.delta);
      assert.deepEqual(updated, fresh.document.state, `${label}: the delta brings the snapshot up to date`);
      assert.ok(JSON.stringify(answer.document).length < JSON.stringify(fresh.document).length, `${label}: the delta is smaller than a snapshot`);
      held = updated;
      return answer.document.delta;
    } finally {
      t.mock.timers.reset();
    }
  }
  const changed = (delta, field) => (delta.merge[field]?.set ?? []).map((entry) => entry[delta.merge[field].key]);

  await move({ verb: 'claim', item, agent: builder.agent });
  const claimed = await catchUp('claim');
  assert.deepEqual(changed(claimed, 'items'), [item], 'only the claimed item travels');
  assert.equal(claimed.merge.items.set[0].claim.by, builder.agent);
  assert.equal(Object.hasOwn(claimed.merge.items, 'ids'), false, 'no item came or went, so the order is not sent');
  const unchangedSequence = held.sequence;
  const nextObservation = Date.parse(held.observedAt) + 1; // One logical clock tick; no board move or timed wait.
  const still = await catchUp('only the observation clock changed', nextObservation);
  assert.equal(held.sequence, unchangedSequence, 'advancing the observation clock writes no board event');
  assert.equal(still.replace.observedAt, new Date(nextObservation).toISOString(),
    'even a no-event delta must refresh the held snapshot observation time');
  assert.deepEqual(still.merge, {}, 'an unchanged board merges nothing');
  assert.deepEqual(Object.keys(still.replace).sort(), [...WHOLE_STATE_DELTA_FIELDS, 'claimOverlaps'].sort(),
    'only the declared per-read projections and small decision lists travel whole');
  assert.deepEqual(still.replace.decisionQueue, [], 'the unchanged empty coordinator queue travels as a whole field');

  commitWork(box, builder, item); await submitSettled(t, box, move, item, builder.agent);
  assert.equal((await catchUp('submit')).merge.items.set[0].status, 'submitted');

  checkOutSubmitted(box, builder, verifier); await move({ verb: 'next', agent: verifier.agent, args: { verify: true } });
  await move({ verb: 'verify', item, agent: verifier.agent, args: { decision: 'accept', reason: 'CRITERION_MET', note: 'read every delta' } });
  const verdict = await catchUp('verdict');
  assert.deepEqual(changed(verdict, 'items').sort((a, b) => a - b), [item, waiting], 'the accept also unblocks the item waiting on it');

  const asked = await move({ verb: 'shout', agent: builder.agent, args: { to: 'coordinator', text: 'May the delta skip the order?', kind: 'question', decision: true } });
  const shouted = await catchUp('shout');
  assert.ok(changed(shouted, 'shouts').includes(asked.id), 'the new shout travels');
  assert.ok(changed(shouted, 'asked').includes(asked.id), 'and so does the open question');
  assert.ok(shouted.replace.decisionQueue.some(row => row.shout_id === asked.id), 'the coordinator queue carries its actual new question');
  const answered = await move({ verb: 'answer', item: asked.id, args: { text: 'Only when nothing moved.' } });
  const answer = await catchUp('answer');
  assert.ok(changed(answer, 'shouts').includes(answered.id), 'the answer travels');
  assert.ok(answer.merge.asked.ids.every((id) => id !== asked.id), 'the answered question leaves the open list');
  assert.ok(answer.replace.decisionQueue.every(row => row.shout_id !== asked.id), 'the answered question also leaves the coordinator queue');

  await box.cliLocal(box.root, 'spec', 'approve', 'G2');
  const decided = await catchUp('spec decision');
  assert.deepEqual(changed(decided, 'spec'), ['G2'], 'only the decided spec row travels');

  writeFileSync(join(box.root, 'DOCTRINE.md'), '# Local rules\n\n## Team Rules\n\n- LOCAL1 [approved, must] Keep each delta exact. | gate: true\n');
  const unmoved = held.sequence;
  const edited = await catchUp('a doctrine edit without a move');
  assert.equal(held.sequence, unmoved, 'no event, so the sequence holds');
  assert.ok(changed(edited, 'practice').includes('LOCAL1'), 'the doctrine row travels anyway');
  await catchUp('again at the same sequence, which may repeat the edit but still applies exactly');

  held = first;
  await catchUp('every move at once, from the first snapshot');

  const ahead = await box.call(box.path + '/state?since=' + (held.sequence + 1000));
  assert.equal(ahead.status, 200);
  assert.equal(ahead.document.delta, null);
  assert.equal(ahead.document.reset.code, 'BASE_AHEAD');
  assert.match(ahead.document.reset.next, /\/state/);
  const format = await box.call(box.path + '/state?since=' + held.sequence + '&eventLogVersion=0');
  assert.equal(format.document.delta, null);
  assert.equal(format.document.reset.code, 'FORMAT_CHANGED', 'a snapshot in another event-log format is never extended');
  // A restarted server that has only read an item, or searched, never sent a snapshot: it cannot
  // extend the held one, even when a change with no event leaves the sequence where it was.
  writeFileSync(join(box.root, 'DOCTRINE.md'), '# Local rules\n\n## Team Rules\n\n- LOCAL1 [approved, must] A restarted server knows only what it sent. | gate: true\n');
  const restarted = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, runCommand: main, projects: () => [{ root: box.root, name: 'HTTP fixture' }] });
  t.after(() => restarted.close());
  const restartedUrl = new URL(restarted.url);
  /** Read through the restarted server with its own key. */
  const restartedRead = async (path) => (await fetchFresh(restartedUrl.origin + box.path + path, { headers: { 'x-pullboard-key': restartedUrl.searchParams.get('k') } })).json();
  assert.equal((await restartedRead('/items/' + item)).item.id, item);
  assert.deepEqual((await restartedRead('/items?q=delta')).ids, [item]);
  const unknownDocument = await restartedRead('/state?since=' + held.sequence);
  assert.equal(unknownDocument.delta, null, JSON.stringify(unknownDocument.delta));
  assert.equal(unknownDocument.reset.code, 'BASE_NOT_KEPT', 'a server that never sent that snapshot says so instead of guessing');
  const resent = (await restartedRead('/state')).state;
  assert.equal(resent.sequence, held.sequence, 'the doctrine edit wrote no event');
  assert.notDeepEqual(resent.practice, held.practice, 'so the held snapshot really is stale');
  assert.equal((await restartedRead('/state?since=' + held.sequence)).delta === null, false, 'once it sends a snapshot at that sequence, it can extend it');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const extended = applyStateDelta(resent, (await restartedRead('/state?since=' + resent.sequence)).delta);
    assert.deepEqual(extended, (await restartedRead('/state')).state, 'and its delta still brings that snapshot up to date');
  } finally {
    t.mock.timers.reset();
  }
  for (const [query, code] of [['since=', 'BAD_CURSOR'], ['since=-1', 'BAD_CURSOR'], ['since=1.5', 'BAD_CURSOR'], ['since=1&detail=full', 'BAD_REQUEST']]) {
    const refused = await box.call(box.path + '/state?' + query);
    assert.equal(refused.status, 400, query);
    assert.equal(refused.document.error.code, code, query);
  }
});

test('[A2, N26] local milestone item status refreshes after an item event', async (t) => {
  let builds = 0;
  const box = await httpBox(t, { onStateBuild: () => { builds += 1; } });
  const agent = await box.cliLocal(box.root, 'worktree', 'app', '--model', 'fixture-agent');
  const added = await box.call(box.path + '/moves', {
    verb: 'add', args: { lane: 'app', title: 'Roadmap item', criterion: 'refresh local status', specs: 'G1', brief: FIXTURE_BRIEF },
  });
  assert.equal(added.status, 200);
  const itemId = added.document.result.item.item_id;
  await box.cliLocal(box.root, 'milestone', 'add', 'Delivery', '--reason', 'Arrange fixture release', '--items', String(itemId));

  const before = await box.call(box.path + '/state');
  assert.equal(builds, 1);
  assert.ok(before.document.state.milestones[0].items[0].progress, JSON.stringify(before.document.state.milestones[0]).slice(0, 1500));
  const { progress: beforeProgress, ...beforeItem } = before.document.state.milestones[0].items[0];
  assert.equal(beforeProgress.stage, 'open');
  assert.deepEqual(beforeItem, {
    id: itemId, title: 'Roadmap item', status: 'open', state: 'open', position: 1,
  });

  const unchanged = await box.call(box.path + '/state');
  assert.equal(builds, 1, 'an unchanged local roadmap state reuses its cached snapshot');
  assert.deepEqual(unchanged.document.state.milestones, before.document.state.milestones);

  const claimed = await box.call(box.path + '/moves', { verb: 'claim', item: itemId, agent: agent.agent });
  assert.equal(claimed.status, 200);
  const after = await box.call(box.path + '/state');
  assert.equal(builds, 2, 'a real item event rebuilds the cached local roadmap');
  const { progress: afterProgress, ...afterItem } = after.document.state.milestones[0].items[0];
  assert.equal(afterProgress.stage, 'claimed');
  assert.deepEqual(afterItem, {
    id: itemId, title: 'Roadmap item', status: 'claimed', state: 'claimed', position: 1,
  });
});
