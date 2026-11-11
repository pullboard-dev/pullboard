import assert from 'node:assert/strict';
import { loadConfig } from '../../../../packages/config/index.js';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { relative } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { applyRelayMove } from '../../../../packages/state/index.js';
import { prepareEngineMove } from '../../../../packages/state/index.js';
import { exportBoard } from '../../../../packages/store/index.js';
import { importBoard } from '../../../../packages/store/index.js';
import { landingFailures } from '../../../../packages/landing/index.js';
import { landingSubject } from '../../../../packages/landing/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { startFixtureChild } from '../../tests/fixtures/child.js';
import { stopGroup } from '../../tests/fixtures/runner/group.js';
import { waitForFixtureProgress } from '../../tests/fixtures/progress.js';
import { assertNoRemoteLanding } from '../../tests/fixtures/land/remote.js';
import { assertLandingStopIdentity } from '../../tests/fixtures/land/stop.js';
import { assertLandingDoctrineCounts } from '../../tests/fixtures/land/doctrine.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import { events } from '../../tests/fixtures/land/board.js';
import { calls } from '../../tests/fixtures/land/board.js';
import { json } from '../../tests/fixtures/land/board.js';
import { mergeSubjects } from '../../tests/fixtures/land/board.js';
import { startInterruptedLanding } from '../../tests/fixtures/land/board.js';
import { settleRecordedSourceWake } from '../../tests/fixtures/land/board.js';
import { recordManualMergedItems } from '../../tests/fixtures/land/board.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { assertSiblingConflictLanding } from '../../../../packages/store/tests/fixtures/collision.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';
/** Exercise landing against real private Git worktrees, hooks, SQLite and bare remotes [B3,R3]. */
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile, BIN } = e2e;
const { FILES, landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('a landing stop never signals a reused process group [Q1,Q3,C7]', async () => {
  await assertLandingStopIdentity();
});

test('a landing records a falling doctrine count and holds a rising count [B3,R3,D1,D3]', () => {
  assertLandingDoctrineCounts({ landProject, itemWorktree, submitItem, acceptItem });
});

test('a repo with no remote lands into the local trunk and status reads as normal [I1,B3,R3,H5]', () => {
  assertNoRemoteLanding(sandbox, commitFile);
});
/** Prepare four independent submitted items and accept them in a caller-selected verdict order. */

function verifiedFour(box, { red, flaky, order = [0, 1, 2, 3] } = {}) {
  box.env.LAND_SUPPRESS_RED = '1';
  const entries = FILES.map((file, index) => itemWorktree(box, index + 1, file));
  for (const [index, entry] of entries.entries()) submitItem(box, entry, index === red ? 'RED\n' : (Array.isArray(flaky) ? flaky.includes(index) : index === flaky) ? 'FLAKE\n' : 'PASS\n');
  for (const index of order) acceptItem(box, entries[index]);
  delete box.env.LAND_SUPPRESS_RED;
  return entries;
}

test('land pushes one exact batch in verdict order and records each first-containing merge once [B3,R3]', () => {
  const box = landProject();
  const entries = verifiedFour(box, { order: [3, 1, 0, 2] });
  const base = box.git(box.repo, 'rev-parse', 'main');
  const start = calls(box).length;
  const result = json(box, box.repo, 'land', '--max', '4');
  const order = [3, 1, 0, 2].map((index) => entries[index].item);
  assert.deepEqual(result.landed, order);
  assert.deepEqual(mergeSubjects(box, base, result.batch.tip), [4, 2, 1, 3].map((n) => `feat(merge): land fixture ${n} [G1]`), 'each merge takes its item\'s type from the item\'s feat commit');
  assert.equal(result.batch.state, 'landed');
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), result.batch.tip);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), result.batch.tip, 'real pre-push accepted the gated tip');
  assert.ok(relative(join(box.repo, '.git', 'pullboard'), result.batch.root).startsWith('landings/'));
  assert.notEqual(result.batch.root, box.repo);
  assert.deepEqual(calls(box).slice(start), [[]], 'one full batch gate; pre-push reads its exact green tree stamp');
  const merges = box.git(box.repo, 'rev-list', '--reverse', '--first-parent', `${base}..${result.batch.tip}`).split('\n');
  for (const [index, id] of order.entries()) assert.equal(json(box, box.repo, 'show', String(id)).item_merged_commit, merges[index]);
  for (const [index, id] of order.entries()) assert.equal(box.git(box.repo, 'log', '-1', '--format=%b', merges[index]).trim(), `Pullboard-Item: #${id}\nPullboard-Rows: G1`, 'each train merge body is only its trailers, naming no lane branch');
  const receipt = events(box).filter((event) => event.event_kind === 'main-moved');
  assert.equal(receipt.length, 1);
  assert.equal(JSON.parse(receipt[0].event_detail).sha, result.batch.tip);
  assert.equal(json(box, box.repo, 'resume').landingBatches.at(-1).id, result.batch.id);
  const eventCount = events(box).length;
  assert.deepEqual(json(box, box.repo, 'land').landed, []);
  assert.equal(events(box).length, eventCount, 'second invocation writes no duplicate receipts');
  assert.deepEqual(calls(box).slice(start), [[]], 'second invocation runs no tests');
  const lane = box.run(entries[0].path, 'land', '--json');
  assert.equal(JSON.parse(lane.out).error?.code, 'COORDINATOR_ONLY');
});

test('a train merge body is only the item trailer even when the local Git config logs merges [B3,R3]', () => {
  const box = landProject();
  verifiedFour(box, { order: [0, 1, 2, 3] });
  const base = box.git(box.repo, 'rev-parse', 'main');
  box.git(box.repo, 'config', 'merge.log', 'true');
  const result = json(box, box.repo, 'land', '--max', '4');
  assert.equal(result.landed.length, 4);
  const merges = box.git(box.repo, 'rev-list', '--reverse', '--first-parent', `${base}..${result.batch.tip}`).split('\n');
  for (const [index, id] of result.landed.entries()) {
    assert.equal(box.git(box.repo, 'log', '-1', '--format=%b', merges[index]).trim(), `Pullboard-Item: #${id}\nPullboard-Rows: G1`, 'merge.log=true appends no shortlog to the body');
  }
});

test('land names sibling conflicts whose reviews share the unchanged main [B3,R3,E8]', () => {
  assertSiblingConflictLanding({ landProject, itemWorktree, submitItem, acceptItem, json, file: FILES[0] });
});

/** Keep the complete private diagnostic refusal in a failing assertion before fixture cleanup deletes its logs. */

function diagnosticOutput(batch) {
  const directory = dirname(batch.logPath);
  return readdirSync(directory).filter(file => file.startsWith('diagnostic-') && file.endsWith('.log'))
    .map(file => readFileSync(join(directory, file), 'utf8')).join('\n');
}

test('land diagnostics inherit their browser gate lease [C7]', () => {
  const box = landProject();
  const marker = join(box.dir, 'land-diagnostic-lease.json');
  const inspector = join(box.dir, 'inspect-land-diagnostic-lease.mjs');
  const resourcesUrl = new URL('../../../../packages/resources/index.js', import.meta.url).href;
  writeFileSync(inspector, [
    "import { writeFileSync } from 'node:fs';",
    `import { inheritedGateSlot } from ${JSON.stringify(resourcesUrl)};`,
    "const lease = inheritedGateSlot({ root: process.cwd(), browser: true });",
    "if (!lease?.browser) throw new Error('focused diagnosis did not inherit its browser lease');",
    `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ file: process.argv[2], held: process.env.PULLBOARD_GATE_SLOT_HELD ?? '', pool: process.env.PULLBOARD_GATE_SLOT_POOL ?? '', token: process.env.PULLBOARD_GATE_SLOT_TOKEN ?? '', browser: process.env.PULLBOARD_BROWSER_SLOT_HELD ?? '', inheritedBrowser: lease.browser }));`,
  ].join('\n'));

  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.affectedTests = `node ${JSON.stringify(inspector)}`;
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  const configCommit = box.tryGit(box.repo, 'commit', '-q', '-m', 'chore: inspect landing diagnostic lease');
  assert.equal(configCommit.status, 0, configCommit.stderr);
  const configPush = box.tryGit(box.repo, 'push', '-q', 'origin', 'main');
  assert.equal(configPush.status, 0, configPush.stderr);

  const entry = itemWorktree(box, 1, FILES[0]);
  box.env.LAND_SUPPRESS_RED = '1';
  try {
    submitItem(box, entry, 'RED\n');
    acceptItem(box, entry);
  } finally {
    delete box.env.LAND_SUPPRESS_RED;
  }
  const result = json(box, box.repo, 'land');
  assert.equal(result.batch.state, 'flaky', `the full gate is red while its isolated diagnosis passes: ${diagnosticOutput(result.batch)}`);
  assert.deepEqual(result.flakes.map(({ test: file }) => file), [FILES[0]]);
  const inherited = JSON.parse(readFileSync(marker, 'utf8'));
  assert.equal(inherited.file, FILES[0]);
  assert.equal(inherited.held, '1');
  assert.ok(inherited.pool, 'the child names the machine resource pool');
  assert.ok(inherited.token, 'the child names the live gate lease token');
  assert.equal(inherited.browser, '1');
  assert.equal(inherited.inheritedBrowser, true);
});

test('land stops again with an expired waiver, and a changed test on main releases the held batch [B3,R3]', () => {
  const box = landProject();
  box.env.LAND_SUPPRESS_RED = '1';
  assert.equal(commitFile(box, box.repo, FILES[0], 'FLAKE\n', 'chore: install a flaky fixture test').status, 0);
  const entry = itemWorktree(box, 1, 'web/feature.js');
  submitItem(box, entry);
  acceptItem(box, entry);
  delete box.env.LAND_SUPPRESS_RED;
  const held = json(box, box.repo, 'land');
  assert.equal(held.batch.state, 'flaky');
  const past = { now: () => new Date('2000-01-01T00:00:00Z') };
  onBoard(box, (board) => store.recordLandingWaiver(board, { agentId: 'person', channel: 'terminal', id: 'expired-example', test: FILES[0], until: '2000-01-02', reason: 'expired fixture approval' }), past);
  const start = calls(box).length;
  const refused = box.run(box.repo, 'land', '--json');
  assert.equal(JSON.parse(refused.out).error?.code, 'LAND_FLAKE');
  assert.equal(calls(box).length, start, 'expired waiver authorizes no retry');
  assert.equal(commitFile(box, box.repo, FILES[0], 'PASS\n', 'chore: correct the flaky test').status, 0);
  const landed = json(box, box.repo, 'land');
  assert.deepEqual(landed.landed, [entry.item]);
  assert.notEqual(landed.batch.id, held.batch.id);
  assert.equal(landed.batch.proof.failures.length, 0);
  assert.deepEqual(calls(box).slice(start), [[]], 'corrected test is gated afresh');
});

test('land adoption recovers an interrupted gate and keeps one receipt under a new coordinator [B3,R3]', async (t) => {
  const box = landProject();
  const entries = verifiedFour(box);
  writeFileSync(box.hold, 'armed');
  const { child, closed, waitForGate } = startInterruptedLanding(box, BIN, t);
  await waitForGate();
  const card = json(box, box.repo, 'resume');
  const batch = card.landingBatches.at(-1);
  assert.equal(batch.state, 'gating');
  assert.match(batch.logPath, /batch-\d+\.log$/u);
  assert.equal(batch.items.length, 4);
  process.kill(-child.pid, 'SIGKILL');
  assert.equal((await closed).signal, 'SIGKILL');
  writeFileSync(box.release, 'release');
  const refused = box.run(box.repo, 'land', '--json');
  assert.equal(JSON.parse(refused.out).error?.code, 'LAND_ADOPT');
  box.env.CODEX_THREAD_ID = 'private-adopting-coordinator';
  const adopted = json(box, box.repo, 'land', '--adopt');
  delete box.env.CODEX_THREAD_ID;
  assert.equal(adopted.batch.id, batch.id);
  assert.notEqual(adopted.batch.owner, batch.owner);
  assert.deepEqual(adopted.landed, entries.map((entry) => entry.item));
  assert.equal(events(box).filter((event) => event.event_kind === 'main-moved').length, 1);
  assert.equal(json(box, box.repo, 'resume').landingBatches.at(-1).state, 'landed');
});

test('landing diagnostics retain unknown failures and merge subjects obey typed 72-character headers [B3,R3]', () => {
  const root = '/private/landing';
  const failures = landingFailures(`not ok 1 - located failure\n  location: ${root}/test/one.test.js:3:4\nnot ok 2 - unknown failure\n`, root);
  assert.deepEqual(failures, [{ name: 'located failure', file: 'test/one.test.js' }, { name: 'unknown failure', file: null }]);
  // Node 24 node --test reports with spec by default: its failing-tests summary names each file and test (#1071).
  const spec = landingFailures(`\u2716 red one (1.2ms)\n\u2716 failing tests:\n\ntest at web/red.test.js:6:1\n\u2716 red one (1.2ms)\n  AssertionError\n\ntest at /elsewhere/x.test.js:1:1\n\u2716 outside (3ms)\n`, root);
  assert.deepEqual(spec, [{ name: 'red one', file: 'web/red.test.js', assertion: 'AssertionError' }, { name: 'outside', file: null }], 'spec failures keep their file and assertion, and an outside path is unknown');
  // The title keeps priority up to the room its first row needs; the rows fill what is left (RFC 0005).
  const subject = landingSubject({ item_id: 91, item_title: 'A VERY LONG TITLE '.repeat(10), item_spec_ids: 'B3,R3' });
  assert.equal(subject, 'chore(merge): a very long title a very long title a very long [B3,R3]');
  assert.ok(subject.length <= 72);
});

test('land bisect adoption retains completed gates, isolated diagnostics and original candidates [B3,R3]', async (t) => {
  const box = landProject();
  const entries = verifiedFour(box, { red: 2 });
  writeFileSync(box.trace, '');
  writeFileSync(box.hold, '3');
  const child = startFixtureChild(process.execPath, [BIN, 'land', '--json'], { cwd: box.repo, env: box.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let outputBytes = 0;
  child.stdout.on('data', part => { outputBytes += Buffer.byteLength(part); });
  child.stderr.on('data', part => { outputBytes += Buffer.byteLength(part); });
  const closed = new Promise((resolveClose) => child.once('close', (status, signal) => resolveClose({ status, signal })));
  t.after(async () => {
    writeFileSync(box.release, 'release');
    await stopGroup(child, closed);
  });
  await waitForFixtureProgress({
    child,
    ready: () => existsSync(box.entered),
    progress: () => outputBytes + [box.calls, box.trace].reduce((bytes, file) =>
      bytes + (existsSync(file) ? readFileSync(file).length : 0), 0),
    description: 'third full gate inside bisection',
  });
  const interrupted = json(box, box.repo, 'resume').landingBatches.at(-1);
  assert.equal(interrupted.items.length, 2, 'the current half differs from the original four candidates');
  assert.equal(interrupted.gateResults.length, 2);
  assert.deepEqual(interrupted.diagnostics, [{ test: FILES[2], isGreen: false }]);
  process.kill(-child.pid, 'SIGKILL');
  assert.equal((await closed).signal, 'SIGKILL');
  writeFileSync(box.release, 'release');
  const result = json(box, box.repo, 'land', '--adopt');
  assert.deepEqual(result.landed, [entries[0].item, entries[1].item, entries[3].item]);
  const trace = readFileSync(box.trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(trace.filter((row) => !row.alone && row.files.length === 4).length, 1, 'completed initial red is not retried');
  assert.equal(trace.filter((row) => !row.alone && row.files.join(',') === FILES.slice(0, 2).join(',')).length, 1, 'completed green half is not retried');
  assert.equal(trace.filter((row) => row.alone && row.files[0] === FILES[2]).length, 1, 'the isolated red is not retried');
  assert.equal(json(box, box.repo, 'show', String(entries[2].item)).thread.filter((entry) => entry.type === 'fact').length, 1);
});

test('landing records replay identically with native sender and engine boundaries [B3,R3,H16]', (t) => {
  const box = landProject();
  const entry = itemWorktree(box, 1);
  submitItem(box, entry);
  acceptItem(box, entry);
  const document = onBoard(box, (board) => exportBoard(board));
  const boards = [0, 1].map(index => {
    const board = fixtureBoard(t, { clock: { now: () => new Date(index ? '2030-01-01' : '2020-01-01') } });
    importBoard(board, document);
    return board;
  });
  const batch = { version: 1, id: 'replayed-batch', state: 'pushed', base: box.git(box.repo, 'rev-parse', 'HEAD'), tip: entry.commit,
    root: join(box.repo, '.git', 'pullboard', 'landings', 'replayed-batch', 'worktree'), branch: 'refs/heads/main', owner: 'coordinator-fixture',
    logPath: join(box.dir, 'replayed-gate.log'), items: [{ id: entry.item, commit: entry.commit, merge: entry.commit }] };
  const operations = [
    ['recordLandingBatch', [{ agentId: 'coordinator', batch }], 'coordinator'],
    ['recordLandingWaiver', [{ agentId: 'person', channel: 'terminal', id: 'replayed-waiver', test: FILES[0], until: '2099-01-01', reason: 'private replay exception' }], 'person'],
    ['recordLandingFlake', [{ agentId: 'coordinator', test: FILES[0], hash: 'd'.repeat(64), names: ['private failing test'], lane: 'web', batchId: batch.id }], 'coordinator'],
    ['finishLandingBatch', [{ agentId: 'coordinator', id: batch.id, tip: entry.commit }], 'coordinator'],
  ];
  for (const [index, [operation, args, actor]] of operations.entries()) {
    const move = prepareEngineMove(boards[0], operation, args, { id: `landing-replay-${index}`, actor });
    const options = { sequence: index + 1, at: '2026-10-10T17:30:00.000Z', kind: 'move',
      sender: actor === 'person' ? { kind: 'person', userId: 'fixture-person' } : { kind: 'agent', agent: actor, userId: 'fixture-person' } };
    const one = applyRelayMove(boards[0], move, options);
    const two = applyRelayMove(boards[1], move, options);
    assert.equal(one.error, undefined, JSON.stringify(one));
    assert.deepEqual(one, two);
    const before = store.events(boards[0]);
    assert.deepEqual(applyRelayMove(boards[0], move, options), one, 'replay of a receipt is idempotent');
    assert.deepEqual(store.events(boards[0]), before);
  }
  assert.deepEqual(store.events(boards[0]), store.events(boards[1]), 'different local clocks produce the same authoritative events');
  assert.equal(store.getItem(boards[0], entry.item).item_merged_commit, entry.commit);
  assert.equal(store.events(boards[0]).filter((event) => event.event_kind === 'main-moved').length, 1);
  const old = prepareEngineMove(boards[0], 'recordLandingBatch', [{ agentId: 'coordinator', batch: { ...batch, id: 'old-engine-batch' } }], { id: 'old-engine-landing', actor: 'coordinator' });
  assert.throws(() => applyRelayMove(boards[0], { ...old, engine: 7 }, { sequence: 5, at: '2026-10-10T17:31:00.000Z', kind: 'move', sender: { kind: 'agent', userId: 'fixture-person', agent: 'coordinator' } }), { code: 'RELAY_MOVE' });
  const forged = prepareEngineMove(boards[0], 'recordLandingWaiver', operations[1][1], { id: 'forged-landing-waiver', actor: 'person' });
  const spoof = applyRelayMove(boards[0], forged, { sequence: 5, at: '2026-10-10T17:32:00.000Z', kind: 'move', sender: { kind: 'agent', userId: 'fixture-person', agent: 'web-1' } });
  assert.equal(spoof.error?.code, 'RELAY_PERSON_ONLY');
});

test('an item with no spec rows lands under a header its commit hook accepts [B3,R3]', () => {
  const box = landProject();
  // A docs-lane item with no spec rows: its commit cites none, and its merge header names its lane's type.
  const config = loadConfig(box.repo);
  config.lanes.docs = { owns: ['docs/'], specs: [] };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: add a docs lane');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const path = join(box.dir, 'docs-land-1');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'docs/land-1', path, 'main');
  assert.equal(fixtureJoin(box.run, path, 'docs', '--model', 'Test Model').code, 0);
  const added = fixtureAdd(box.run, box.repo, 'docs', 'Docs fixture with no rows', '--criterion', 'the docs fixture is valid',
    '--brief', 'Files: docs/land-1.md\nTest: docs/land-1.test.js\n',
    '--check', `node ${JSON.stringify(box.checks)} ${JSON.stringify('docs/land-1.test.js')}`, '--json');
  assert.equal(added.code, 0, added.err);
  const item = JSON.parse(added.out).item.item_id;
  assert.equal(box.run(path, 'claim', String(item)).code, 0);
  mkdirSync(join(path, 'docs'), { recursive: true });
  writeFileSync(join(path, 'docs', 'land-1.md'), 'docs\n');
  writeFileSync(join(path, 'docs', 'land-1.test.js'), 'PASS\n');
  box.git(path, 'add', '-A');
  box.git(path, 'commit', '-q', '-m', 'docs(docs): describe the docs fixture');
  const entry = { path, item, file: 'docs/land-1.test.js', commit: box.git(path, 'rev-parse', 'HEAD') };
  assert.equal(box.run(path, 'submit', String(item), '--no-next').code, 0, 'the docs commit submits');
  acceptItem(box, entry);
  const base = box.git(box.repo, 'rev-parse', 'main');
  const result = json(box, box.repo, 'land', '--max', '1');
  assert.deepEqual(result.landed, [item]);
  const [subject] = mergeSubjects(box, base, result.batch.tip);
  assert.equal(subject, 'docs(merge): docs fixture with no rows', 'a docs-lane item with no rows lands under docs(merge)');
});

test('publish pushes only a head the whole suite passed and names every red [B3,R3]', async () => {
  const box = landProject();
  const entries = verifiedFour(box, { red: 1 });
  const before = box.git(box.remote, 'rev-parse', 'main');
  // Tier 1 by hand: each verified item lands on the local trunk only, as pullboard merged records it.
  recordManualMergedItems(box, entries);
  // Manual merged calls start native source advances; close their exact recorded wake before measuring publish.
  await settleRecordedSourceWake(box, { waitFor });
  const head = box.git(box.repo, 'rev-parse', 'main');
  const start = calls(box).length;
  const red = box.run(box.repo, 'publish', '--json');
  assert.equal(red.code, 1, 'a red head fails publish');
  const report = JSON.parse(red.out);
  assert.equal(report.published, false);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), before, 'a red head is never pushed');
  assert.deepEqual(report.red.map((entry) => entry.file), [FILES[1]], 'every failing test is named from the one run');
  assert.deepEqual(report.red[0].items, [entries[1].item], 'the failing file names the landed item whose merge touched it');
  assert.equal(calls(box).length - start, 1, 'one whole-suite run');
  const again = box.run(box.repo, 'publish', '--json');
  assert.equal(again.code, 0);
  assert.equal(JSON.parse(again.out).waiting, true, 'the same red head waits for a new head');
  assert.equal(calls(box).length - start, 1, 'waiting runs no tests');
  // A fix lands on the trunk; the new head passes the whole suite and is pushed exactly.
  assert.equal(commitFile(box, box.repo, FILES[1], 'PASS\n', 'fix(web): land fixture 2 passes again [G1]').status, 0);
  const fixed = box.git(box.repo, 'rev-parse', 'main');
  assert.notEqual(fixed, head);
  const green = json(box, box.repo, 'publish');
  assert.equal(green.published, true);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), fixed, 'only the head the whole suite passed reaches the remote');
});
