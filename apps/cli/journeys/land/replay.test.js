import assert from 'node:assert/strict';
import { loadConfig } from '../../../../packages/config/index.js';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { applyRelayMove } from '../../../../packages/state/index.js';
import { prepareEngineMove } from '../../../../packages/state/index.js';
import { exportBoard } from '../../../../packages/store/index.js';
import { importBoard } from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import { events } from '../../tests/fixtures/land/board.js';
import { calls } from '../../tests/fixtures/land/board.js';
import { json } from '../../tests/fixtures/land/board.js';
import { mergeSubjects } from '../../tests/fixtures/land/board.js';
import { settleRecordedSourceWake } from '../../tests/fixtures/land/board.js';
import { recordManualMergedItems } from '../../tests/fixtures/land/board.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';
/** Exercise landing replay, hook headers and publish against real private Git worktrees [B3,R3,H16]. */
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { FILES, landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

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
