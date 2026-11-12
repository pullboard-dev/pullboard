/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js packages/state/src/io/machine.js */
/** Lifecycle activity retains its evidence without turning routine status into messages [B3,R2,N26,H16]. */
import { requireFixtureReviewFamilies } from '../../tests/fixtures/review/family.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import {
  openBoard,
  draftSpecRow,
  nativeBoardPorts,
} from '../../../lib/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import {
  applyEngineMove,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import { ACTIVITY_NEWS_ENGINE } from '../../../../packages/state/light.js';
import { ITEM_SHOUT_ENGINE } from '../../../../packages/state/light.js';
import { LANDING_LEASE_ENGINE } from '../../../../packages/state/light.js';
import { shout as shoutMove } from '../../../../packages/moves/index.js';
import { ACTIVITY_DELIVERY_ENGINE } from '../../../../packages/state/light.js';
const { relaySenderProblem } = nativeBoardPorts().enginePorts;
import { prepareSpecRefreezes } from '../../../../packages/spec/index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { DatabaseSync } from 'node:sqlite';
import { activityDeliveryLines } from '../../../../packages/activity/index.js';
import { activityMainFiles } from '../../../../packages/activity/index.js';
import { activityWorkingFiles } from '../../../../packages/activity/index.js';
import { batchMainFiles } from '../../../../packages/activity/index.js';
import { budgetInbox } from '../../../../packages/activity/index.js';
import { readActivityCursor } from '../../../../packages/activity/index.js';
import { readActivityDelivery } from '../../../../packages/activity/index.js';
import { saveActivityCursor } from '../../../../packages/activity/index.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('worker inbox handles nineteen aliases and forty thousand shouts within one second per read [B7,C7]', t => {
  // Process-level: wall-clock budget of a separate fixture process.
  const result = runFixtureChild(process.execPath, [join(import.meta.dirname, '../../tests/fixtures/worker/scale.js')],
    { encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, `bounded history fixture: ${result.error?.message ?? ''}\n${result.stderr}\n${result.stdout}`);
  const measured = JSON.parse(result.stdout);
  t.diagnostic(JSON.stringify(measured));
  assert.equal(measured.seats, 19);
  assert.equal(measured.historicalShouts, 40000);
  for (const key of ['previewMs', 'countMs', 'peekMs', 'inboxMs']) {
    assert.ok(measured[key] < 1000, `${key}=${measured[key]} ms; limit 1000 ms`);
  }
});

test('inbox reads leave the writer available and acknowledge only after selection [B7,R2,C7]', t => {
  const board = fixtureBoard(t, { storage: 'file', purpose: 'locking' });
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file;
  const competitor = new DatabaseSync(file);
  t.after(() => competitor.close());
  competitor.exec('PRAGMA busy_timeout=0');
  store.register(board, { lane: 'coordinator', path: '/lock/root' });
  const seat = store.register(board, { lane: 'web', path: '/lock/worker', session: 'private-lock-worker' });
  const original = board.db.prepare.bind(board.db);
  let reads = 0;
  let observing = false;
  /** An independent connection must acquire the writer while the inbox prepares its selection. */
  board.db.prepare = sql => {
    if (observing && sql.includes('FROM shout')) {
      assert.doesNotThrow(() => competitor.exec('BEGIN IMMEDIATE; ROLLBACK'), 'message selection holds no writer');
      reads++;
    }
    return original(sql);
  };
  for (const markRead of [false, true]) {
    const sent = store.shout(board, { from: 'coordinator', to: seat, text: 'Read after selection', lanes: ['coordinator', 'web'] });
    observing = true;
    const delivered = store.inbox(board, seat, { markRead });
    observing = false;
    assert.ok(delivered.some(shout => shout.shout_id === sent));
    assert.equal(store.agentById(board, seat).agent_last_shout_id, markRead ? sent : 0);
  }
  assert.equal(reads, 2);
});

test('a recorded submit stays successful when its later activity delivery fails [N26,H16,V4]', async () => {
  const box = e2e.project('true');
  const boardPath = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const board = openBoard(boardPath);
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Submission survives a delivery failure',
    criterion: 'The private file is committed.' });
  store.closeBoard(board);
  const claimed = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  const committed = e2e.commitFile(box, box.web, 'web/delivery-failure.txt', 'private proof\n', 'feat(web): delivery failure fixture [G1]');
  assert.equal(committed.status, 0, committed.stderr);
  const broken = openBoard(boardPath);
  // Corrupt only this private derived read state; the authoritative item and move log remain genuine.
  broken.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run('activity:web-1:cursor:', '{');
  store.closeBoard(broken);
  const submitted = await box.runLocal(box.web, 'submit', String(id), '--json');
  assert.equal(submitted.code, 0, submitted.out + submitted.err);
  const document = JSON.parse(submitted.out);
  assert.equal(document.id, id);
  assert.equal(document.gate.green, true);
  assert.equal(document.activity.receipt.recorded, false);
  assert.equal(document.activity.receipt.code, 'ACTIVITY_DELIVERY_FAILED');
  assert.match(document.diagnostics.join('\n'), /submitted .*activity delivery failed.*inbox/u);
  const after = openBoard(boardPath);
  try {
    assert.equal(store.getItem(after, id).item_status, 'submitted');
    assert.equal(store.getItem(after, id).item_commit, document.commit);
    assert.equal(store.events(after).filter(event => event.event_kind === 'submit').length, 1);
    assert.equal(store.events(after).filter(event => event.event_kind === 'activity-delivered').length, 0);
  } finally { store.closeBoard(after); }
});

/** Freeze a private item's exact requirement without claiming a test gate ran in this board-state fixture. */
function freeze(item = {}) {
  return { text: JSON.stringify({ criterion: item.item_criterion ?? '', rows: [], policy: { version: 1, verify: { policy: 'any', family: 'off' } } }), digest: 'activity-fixture' };
}

test('status moves are feed events and the board sends no status shout [B3,R2,N26,H16]', t => {
  const box = e2e.project(undefined, e2e.sandbox({ declareFamilies: true }));
  const base = box.git(box.repo, 'rev-parse', 'HEAD');
  const committed = e2e.commitFile(box, box.web, 'web/activity.txt', 'private activity fixture\n', 'feat(web): activity fixture [G1]');
  assert.equal(committed.status, 0, committed.stderr);
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  const tree = box.git(box.web, 'rev-parse', 'HEAD^{tree}');
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
  t.after(() => store.closeBoard(board));
  requireFixtureReviewFamilies(board);
  const reviewer = store.register(board, { lane: 'api', path: join(box.dir, 'activity-reviewer'), family: 'Fixture Activity Reviewer Vendor' });
  const item = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Activity fixture' });
  const other = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Unrelated item', criterion: 'Unrelated item' });
  const beforeShouts = board.db.prepare('SELECT * FROM shout ORDER BY shout_id').all();
  store.claim(board, item, { agentId: 'web-1', lane: 'web', leaseMs: 3600000, head: base, freeze });
  const evidence = { version: 1, files: [], full: false, deferred: true, reason: 'private lifecycle fixture, not gate evidence' };
  submitFixture(board, item, { agentId: 'web-1', commit, tree, note: 'The exact submit note stays in activity.', submissionProof: evidence });
  store.verify(board, item, { agentId: reviewer, decision: 'ACCEPT', note: 'Synthetic private lifecycle acceptance, not an execution claim.',
    head: commit, digest: freeze().digest, policy: 'any', familyPolicy: 'off', check: 'green',
    review: { commit, head: commit, trunk: base, paths: ['web/activity.txt'] } });
  const batch = { version: 1, id: 'activity-fixture', state: 'pushed', base, tip: commit,
    root: box.web, branch: 'refs/heads/main', owner: 'private-fixture', logPath: join(box.dir, 'activity.log'),
    items: [{ id: item, commit, merge: commit, reviewedCommit: commit }] };
  store.recordLandingBatch(board, { agentId: 'coordinator', batch });
  store.finishLandingBatch(board, { agentId: 'coordinator', id: batch.id, tip: commit });
  const thread = store.itemThread(board, item);
  assert.deepEqual(thread.filter(entry => ['claim', 'submit', 'accept', 'merged', 'main-moved'].includes(entry.kind)).map(entry => entry.kind),
    ['claim', 'submit', 'accept', 'merged', 'main-moved'], 'main moving reaches the landed item as activity');
  const submitted = thread.find(entry => entry.kind === 'submit');
  assert.equal(submitted.detail.note, 'The exact submit note stays in activity.');
  assert.deepEqual(submitted.detail.submissionProof, evidence);
  assert.equal(thread.find(entry => entry.kind === 'main-moved').detail.sha, commit);
  assert.equal(store.itemThread(board, other).some(entry => entry.kind === 'main-moved'), false, 'an unrelated item gets no landing activity');
  assert.deepEqual(board.db.prepare('SELECT * FROM shout ORDER BY shout_id').all(), beforeShouts, 'routine lifecycle writes no status shout');
  const snapshot = exportBoard(board);
  assert.deepEqual(store.itemThread(board, item), thread, 'reading activity again is stable');
  assert.deepEqual(exportBoard(board), snapshot, 'projection never writes another receipt');
  assert.equal(store.events(board).filter(event => event.event_kind === 'main-moved').length, 1, 'one original batch receipt serves all item readers');
  store.claim(board, other, { agentId: 'web-1', lane: 'web', leaseMs: 3600000, head: base, freeze });
  submitFixture(board, other, { agentId: 'web-1', commit, tree });
  store.verify(board, other, { agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE', note: 'Synthetic private refusal fixture.', clause: 'Unrelated item',
    head: commit, digest: freeze().digest, policy: 'any', familyPolicy: 'off', reopenFirstRefusalMinutes: 0,
    review: { commit, head: commit, trunk: base, paths: ['web/activity.txt'] } });
  assert.ok(store.itemThread(board, other).some(entry => entry.kind === 'reject'), 'a rejection remains item activity');
  const notices = board.db.prepare('SELECT * FROM shout WHERE shout_id > ? ORDER BY shout_id').all(beforeShouts.at(-1)?.shout_id ?? 0);
  // db3dba1506 (#2779): a reject reopens at once to every eligible seat, so it reserves nothing and sends no first-refusal notice.
  assert.equal(notices.length, 0, 'a reject reopens at once: no first-refusal notice and no routine reject shout is added');
  store.shout(board, { from: 'web-1', to: 'coordinator', lanes: ['web', 'api'], text: 'My work was submitted.' });
  assert.equal(board.db.prepare('SELECT shout_text FROM shout ORDER BY shout_id DESC LIMIT 1').get().shout_text,
    'My work was submitted.', 'agent-written messages are never suppressed, even when they mention status');
});


test('an agent feed shows only activity that touches its items files rows and lane [R2,N26,H16]', (t) => {
  assert.equal(typeof store.agentActivity, 'function', 'the inbox needs a tailored activity projection, not the global event log');
  const git = e2e.project();
  const base = git.git(git.web, 'rev-parse', 'HEAD');
  assert.equal(e2e.commitFile(git, git.web, 'web/feed-fixture.txt', 'private fixture\n', 'feat(web): private feed fixture [G1]').status, 0);
  const commit = git.git(git.web, 'rev-parse', 'HEAD');
  const tree = git.git(git.web, 'rev-parse', 'HEAD^{tree}');
  let leaseTime = Date.now();
  // Only this private board's lease clock advances; admission and elapsed-time clocks stay real.
  const board = openBoard(':memory:', { now: () => new Date(leaseTime) });
  t.after(() => store.closeBoard(board));
  for (const [lane, path] of [['coordinator', '/feed-fixture'], ['web', '/feed-fixture/web-1'],
    ['web', '/feed-fixture/web-2'], ['api', '/feed-fixture/api-1']]) store.register(board, { lane, path, family: `Fixture Feed Vendor ${path}` });
  requireFixtureReviewFamilies(board);
  const lanes = ['coordinator', 'web', 'api'];
  /** Create ordinary private items; public lifecycle moves later establish their projection state. */
  const add = (title, lane = 'api', options = {}) => store.addItem(board, { by: 'coordinator', lane, title, ...options });
  const ancestor = add('Upstream ancestor');
  const dependency = add('Direct dependency', 'api', { after: [ancestor] });
  const mine = add('My active build', 'web', { after: [dependency], specIds: ['G1'],
    brief: 'Files: src/edit.js\nTest: preserve the work\n' });
  const dependent = add('Direct dependent', 'api', { after: [mine] });
  const downstream = add('Downstream dependent', 'api', { after: [dependent] });
  const sibling = add('Sibling only shares my prerequisite', 'api', { after: [dependency] });
  const reviewed = add('My active review');
  const sharedFile = add('Another lane edits my planned file', 'api', { brief: 'Files: src/edit.js\nTest: private fixture\n' });
  const changedFile = add('Another lane edits my submitted diff', 'api', { brief: 'Files: src/diff-only.js\nTest: private fixture\n' });
  const workingFile = add('Another lane edits my current working diff', 'api', { brief: 'Files: src/working.js\nTest: private fixture\n' });
  const prefixOnly = add('A similar spelling is not the same file', 'api', { brief: 'Files: src/edit.js.backup\nTest: private fixture\n' });
  const laneOnly = add('Other work in my lane', 'web');
  const unrelated = add('Unrelated work');
  const expired = add('My old expired claim', 'web');
  const expiredReview = add('My old expired review');
  /** Use normal private lifecycle moves; these synthetic submission receipts do not claim a gate ran. */
  const submit = id => {
    store.claim(board, id, { agentId: 'api-1', lane: 'api', leaseMs: 3_600_000, head: base, freeze });
    submitFixture(board, id, { agentId: 'api-1', commit, tree });
  };
  /** Verify prerequisites with the existing private lifecycle fixture contract. */
  const accept = id => {
    submit(id);
    store.verify(board, id, { agentId: 'web-2', decision: 'ACCEPT', head: commit, digest: freeze().digest,
      note: 'Private projection fixture, not runtime proof.', policy: 'any', familyPolicy: 'off', check: 'green',
      review: { commit, head: commit, trunk: base, paths: ['web/feed-fixture.txt'] } });
  };
  store.claim(board, expired, { agentId: 'web-1', lane: 'web', leaseMs: 1000, head: base, freeze });
  submit(expiredReview);
  store.reserveReview(board, expiredReview, { agentId: 'web-1', leaseMs: 1000, policy: 'any' });
  leaseTime += 2000;
  accept(ancestor);
  accept(dependency);
  store.claim(board, mine, { agentId: 'web-1', lane: 'web', leaseMs: 3_600_000, head: base, freeze });
  submit(reviewed);
  store.reserveReview(board, reviewed, { agentId: 'web-1', leaseMs: 3_600_000, policy: 'any' });
  const question = store.shout(board, { from: 'web-1', to: 'api-1', text: 'Which direction?', lanes, decision: true });
  const otherQuestion = store.shout(board, { from: 'web-2', to: 'api-1', text: 'Someone else asked', lanes, decision: true });
  const since = board.db.prepare('SELECT MAX(event_id) AS id FROM event').get().id;
  const expectedItems = [ancestor, dependency, mine, dependent, downstream, reviewed, sharedFile, changedFile, workingFile];
  for (const id of [...expectedItems, sibling, prefixOnly, laneOnly, unrelated, expired, expiredReview]) {
    store.appendFact(board, id, { agentId: 'coordinator', kind: 'note', text: id === laneOnly
      ? 'Private lane detail must be summarized, not broadcast verbatim.' : `Private observation for #${id}` });
  }
  const rowRecords = [];
  for (const id of ['G1', 'G2']) rowRecords.push(...store.recordRowDecisions(board, { agentId: 'person', channel: 'terminal', decisions: [{
    kind: 'spec', id, file: 'SPEC.md', decision: 'approve', source: `- ${id} [draft] Private row ${id}.`,
    replacement: `- ${id} [approved] Private row ${id}.`, text: `Private row ${id}.`,
  }] }));
  // Seal complete corrected bars through the current apply protocol; this fixture proves feed projection only.
  /** Freeze the private fixture's corrected row bytes without claiming a gate execution. */
  const correctedFreeze = item => {
    const text = JSON.stringify({ title: item.item_title, criterion: item.item_criterion,
      check: item.item_check ?? '', rows: item.item_spec_ids.split(',').map(id => ({ id, text: `Private row ${id}.`, gate: '' })) });
    return { text, digest: createHash('sha256').update(text).digest('hex') };
  };
  const refreezes = prepareSpecRefreezes(rowRecords, store.listItems(board, { all: true }), correctedFreeze);
  store.applyRowDecisions(board, { agentId: 'coordinator', events: rowRecords.map(record => record.event), refreezes });
  draftSpecRow(board, { agentId: 'web-1', row: { id: 'G1', text: 'Private cited-row draft',
    gate: 'private fixture gate', tier: 'should', section: 'Goals' } });
  const answer = store.answerDecision(board, question, { agentId: 'api-1', text: 'Use the narrow path.', lanes });
  store.answerDecision(board, otherQuestion, { agentId: 'api-1', text: 'Unrelated answer must stay private.', lanes });
  const sha = 'a'.repeat(40);
  // This synthetic main receipt supplies only identity; the injected Git seam supplies actual changed paths.
  board.db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)')
    .run(new Date().toISOString(), 'coordinator', 'main-moved', null, JSON.stringify({ sha, batch: 'private-feed-main', items: [] }));
  const news = store.shout(board, { from: 'coordinator', to: 'all', text: 'Release ready.\nRead its item for details.', lanes, news: true });
  const governing = store.shout(board, { from: 'coordinator', to: 'all', text: 'Hold new browser launches until the person clears it.', lanes });
  const snapshot = exportBoard(board);
  /** This private Git seam declares fixture paths, not a claim about the live repository. */
  const changesForMain = commit => commit === sha ? ['src/edit.js', 'src/diff-only.js', 'src/working.js', 'src/unrelated.js'] : null;
  const options = { after: since, workingFiles: ['src/diff-only.js', 'src/working.js'], changesForMain, sessionStart: true, newsAfter: 0 };
  const feed = store.agentActivity(board, 'web-1', options);
  assert.deepEqual(feed.entries.filter(entry => entry.kind === 'fact').map(entry => entry.item).sort((a, b) => a - b),
    expectedItems.sort((a, b) => a - b), 'both dependency directions are transitive, but a prerequisite sibling is not my dependent');
  const rowChanges = feed.entries.filter(entry => entry.kind === 'row_decision');
  assert.equal(rowChanges.length, 1);
  assert.deepEqual(rowChanges[0].rows, ['G1'], 'only rows cited by my active work reach me');
  assert.deepEqual(feed.entries.find(entry => entry.kind === 'row_apply')?.rows, ['G1'], 'application resolves its original decision ids');
  assert.deepEqual(feed.entries.find(entry => entry.kind === 'row_draft')?.rows, ['G1'], 'a cited draft change reaches the same feed');
  const answers = feed.entries.filter(entry => entry.kind === 'answer');
  assert.deepEqual(answers.map(entry => entry.shout), [answer]);
  assert.equal(answers[0].text, 'Use the narrow path.');
  const main = feed.entries.find(entry => entry.kind === 'main-moved');
  assert.deepEqual(main.files, ['src/diff-only.js', 'src/edit.js', 'src/working.js']);
  assert.equal(main.text, 'main changed 3 files you are editing');
  const digest = feed.digests.find(entry => entry.kind === 'lane');
  assert.equal(digest.lane, 'web');
  assert.equal(digest.count, 2, 'an expired own-lane claim is summarized rather than treated as active work');
  assert.deepEqual(digest.items, [laneOnly, expired]);
  assert.doesNotMatch(JSON.stringify(feed), /Private lane detail|Unrelated answer/, 'digests do not leak the underlying unrelated prose');
  assert.equal(new Set(feed.entries.map(entry => entry.eventId)).size, feed.entries.length, 'overlapping reasons deliver one event');
  assert.deepEqual(feed.entries.map(entry => entry.eventId), feed.entries.map(entry => entry.eventId).toSorted((a, b) => a - b));
  const announcements = feed.digests.find(entry => entry.kind === 'news');
  assert.deepEqual(announcements.shouts, [news]);
  assert.doesNotMatch(announcements.text, /[\r\n]/, 'explicit news is a one-line session-start digest');
  assert.equal(feed.entries.some(entry => entry.shout === news), false, 'explicit news is not repeated as a direct message');
  assert.equal(feed.entries.find(entry => entry.shout === governing)?.text,
    'Hold new browser launches until the person clears it.', 'untyped governing broadcasts remain direct');
  assert.equal(feed.cursor, board.db.prepare('SELECT MAX(event_id) AS id FROM event').get().id);
  const continued = store.agentActivity(board, 'web-1', { ...options, after: feed.cursor, sessionStart: false });
  assert.deepEqual(continued.entries, [], 'the caller can continue from the returned cursor');
  assert.equal(continued.digests.some(entry => entry.kind === 'news'), false, 'news is read at session start, not on every poll');
  assert.deepEqual(exportBoard(board), snapshot, 'a feed projection does not modify immutable history or native receipts');
  assert.throws(() => store.agentActivity(board, 'unknown-fixture-agent', options), error => error.code === 'NO_AGENT');
  for (const invalid of [{ from: 'web-1' }, { to: 'web' }, { decision: true }, { request: true },
    { answers: question }, { item: mine }, { detail: { news: true }, news: undefined }]) {
    assert.throws(() => store.shout(board, { from: 'coordinator', to: 'all', text: 'Invalid private announcement',
      lanes, news: true, ...invalid }), error => error.code === 'BAD_NEWS', 'news never creates a new broadcast or decision authority');
  }
  const executable = prepareEngineMove(board, 'shout', [{ from: 'coordinator', to: 'all', text: 'Private replay news', lanes, news: true }]);
  assert.throws(() => applyEngineMove(board, { ...executable, engine: ACTIVITY_NEWS_ENGINE - 1 },
    { sequence: 1, at: new Date().toISOString() }), error => error.code === 'RELAY_MOVE', 'old engines cannot silently reinterpret explicitly marked news');
  assert.equal(shoutMove.minimumEngine([{ item: mine }]), ITEM_SHOUT_ENGINE, 'ordinary historical arguments keep their old engine floor');
  assert.equal(shoutMove.minimumEngine([{ news: true, item: mine, landingFence: {} }]),
    Math.max(ACTIVITY_NEWS_ENGINE, ITEM_SHOUT_ENGINE, LANDING_LEASE_ENGINE), 'news combines every applicable feature floor');
  assert.deepEqual(exportBoard(board), snapshot, 'refused news and old replay leave all native rows and receipts unchanged');
});


test('activity cursors leave events arriving during an observation pending [N26]', (t) => {
  const board = openBoard(':memory:');
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: '/feed-cursor-fixture' });
  store.register(board, { lane: 'web', path: '/feed-cursor-fixture/web-1' });
  const item = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Private cursor item' });
  store.claim(board, item, { agentId: 'web-1', lane: 'web', leaseMs: 3_600_000, freeze });
  const before = board.db.prepare('SELECT MAX(event_id) AS id FROM event').get().id;
  const observed = store.agentActivity(board, 'web-1', { after: before, workingFiles: () => {
    store.appendFact(board, item, { agentId: 'coordinator', kind: 'note', text: 'Arrived after the observed high-water mark' });
    store.shout(board, { from: 'coordinator', to: 'all', text: 'A later governing message', lanes: ['web'] });
    return [];
  } });
  assert.equal(observed.cursor, before);
  assert.deepEqual(observed.entries, [], 'later events are not falsely covered by the earlier cursor');
  assert.deepEqual(store.inbox(board, 'web-1', { through: observed.shoutCursor }), [], 'acknowledging this snapshot does not consume the later message');
  const next = store.agentActivity(board, 'web-1', { after: observed.cursor });
  assert.equal(next.entries.some(entry => entry.kind === 'fact' && entry.item === item), true);
  assert.equal(next.entries.some(entry => entry.text === 'A later governing message'), true);
  // Legacy corruption is a private fixture, not a native writer or a repair to its stored bytes.
  board.db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)')
    .run(new Date().toISOString(), 'coordinator', 'fact', item, '{broken legacy fact');
  store.shout(board, { from: 'coordinator', to: 'all', text: 'Governing messages survive unknown old detail', lanes: ['web'] });
  const intact = exportBoard(board);
  const unknown = store.agentActivity(board, 'web-1', { after: next.cursor });
  assert.equal(unknown.entries.some(entry => entry.item === item && entry.unknown === true), true);
  assert.equal(readActivityDelivery(board, 'web-1', { sessionStart: false }).entries.some(entry => entry.item === item && entry.unknown), true,
    'an unreadable historical obligation stays an immediate notice, never a quiet digest count');
  assert.equal(unknown.entries.some(entry => entry.text === 'Governing messages survive unknown old detail'), true);
  assert.deepEqual(exportBoard(board), intact, 'unknown legacy detail is reported without rewriting it');
  assert.throws(() => store.inbox(board, 'web-1', { through: -1 }), error => error.code === 'BAD_ACTIVITY_CURSOR');
  const oldMessage = store.shout(board, { from: 'coordinator', to: 'all', text: 'A legacy message still has its body', lanes: ['web'] });
  // Construct an additional legacy-corrupt row without rewriting any append-only event.
  board.db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)')
    .run(new Date().toISOString(), 'coordinator', 'shout', null, '{broken legacy message event');
  const legacy = store.agentActivity(board, 'web-1', { after: unknown.cursor });
  assert.ok(store.inbox(board, 'web-1', { through: legacy.shoutCursor }).some(shout => shout.shout_id === oldMessage),
    'a corrupt old event cannot block delivery from the canonical message table');
});

test('inbox delivery uses real Git paths and board-bound cursors without consuming later news [R2,N26,H16]', async () => {
  const box = e2e.project();
  const base = box.git(box.web, 'rev-parse', 'HEAD');
  const rowFile = 'web/feed-rows.md';
  const first = '## Goals\n- G1 [draft, should] First row.\n- G2 [draft, should] Other row.\n';
  assert.equal(e2e.commitFile(box, box.web, rowFile, first, 'feat(web): private row file [G1]').status, 0);
  const introduced = box.git(box.web, 'rev-parse', 'HEAD');
  assert.deepEqual(activityMainFiles(box.web, introduced, { base }, { rowFiles: [rowFile] }).rows.toSorted(), ['G1', 'G2']);
  assert.equal(e2e.commitFile(box, box.web, rowFile, first.replace('First row.', 'Changed row.'), 'feat(web): change one private row [G1]').status, 0);
  const changed = box.git(box.web, 'rev-parse', 'HEAD');
  assert.deepEqual(activityMainFiles(box.web, changed, { base: introduced }, { rowFiles: [rowFile] }).rows, ['G1']);
  assert.equal(activityMainFiles(box.web, changed, { base: 'f'.repeat(40) }), null, 'missing Git ancestry stays unknown');
  writeFileSync(join(box.web, 'web', 'untracked\nname.js'), 'private current diff\n');
  const observed = activityWorkingFiles(box.web, [{ item_claim_head: base }]);
  assert.equal(observed.unknown, false);
  assert.ok(observed.files.includes(rowFile));
  assert.ok(observed.files.includes('web/untracked\nname.js'), 'real NUL-delimited Git output preserves newline names');
  assert.equal(activityWorkingFiles(box.web, [{ item_claim_head: 'missing' }]).unknown, true);

  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Private CLI feed item',
    specIds: ['G1'], brief: 'Files: web/feed-rows.md\nTest: private fixture\n' });
  store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 3_600_000, head: base, freeze });
  store.appendFact(board, id, { agentId: 'web-1', kind: 'note', text: 'Private meaningful activity' });
  // Synthetic native batch receipts exercise the read path, not a claim that a landing gate ran.
  store.recordLandingBatch(board, { agentId: 'coordinator', batch: { version: 1, id: 'private-feed-git',
    state: 'pushed', base, tip: changed, root: box.web, branch: 'refs/heads/main', owner: 'private-fixture',
    logPath: join(box.dir, 'private-feed-git.log'), items: [] } });
  store.finishLandingBatch(board, { agentId: 'coordinator', id: 'private-feed-git', tip: changed });
  const lanes = ['web', 'api'];
  store.shout(board, { from: 'coordinator', to: 'all', text: 'A governing instruction stays direct.', lanes });
  const firstNews = store.shout(board, { from: 'coordinator', to: 'all', text: 'First private release.', lanes, news: true });
  const boardId = store.boardId(board);
  store.closeBoard(board);
  const one = await box.runLocal(box.web, 'inbox', '--json');
  assert.equal(one.code, 0, one.err);
  const feed = JSON.parse(one.out);
  assert.ok(feed.shouts.some(shout => shout.shout_text === 'A governing instruction stays direct.'));
  assert.equal(feed.shouts.some(shout => shout.shout_id === firstNews), false);
  assert.ok(feed.activity.digests.some(entry => entry.kind === 'fact' && entry.count > 0), 'routine facts become a counted break-time summary');
  assert.deepEqual(feed.activity.interrupts.find(entry => entry.kind === 'main-moved')?.files, [rowFile],
    'the real CLI compares the exact recorded Git base and tip against the active file plan');
  assert.deepEqual(feed.activity.digests.find(digest => digest.kind === 'news')?.shouts, [firstNews]);
  const continued = await box.runLocal(box.web, 'inbox', '--json');
  assert.equal(continued.code, 0, continued.err);
  assert.deepEqual(JSON.parse(continued.out).activity.entries, []);
  assert.deepEqual(JSON.parse(continued.out).activity.digests, []);
  const again = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  const secondNews = store.shout(again, { from: 'coordinator', to: 'all', text: 'Next private release.', lanes, news: true });
  store.closeBoard(again);
  const sameSession = await box.runLocal(box.web, 'inbox', '--json');
  assert.equal(sameSession.code, 0, sameSession.err);
  assert.deepEqual(JSON.parse(sameSession.out).activity.digests, [], 'later news waits for the next session');
  const delivery = readActivityCursor(box.web, 'web-1', boardId);
  const saved = JSON.parse(readFileSync(delivery.file, 'utf8'));
  // Explicit synthetic local delivery state models a restart; no native board identity is changed.
  writeFileSync(delivery.file, JSON.stringify({ ...saved, session: 'older-private-fixture-session' }));
  const restarted = await box.runLocal(box.web, 'inbox', '--json');
  assert.equal(restarted.code, 0, restarted.err);
  assert.deepEqual(JSON.parse(restarted.out).activity.digests.find(digest => digest.kind === 'news')?.shouts, [secondNews]);
  assert.equal(readActivityCursor(box.web, 'web-1', 'different-private-board').after, 0, 'another board cannot borrow a cursor');
  writeFileSync(delivery.file, '{damaged cursor');
  assert.equal(readActivityCursor(box.web, 'web-1', boardId).after, 0, 'damaged local state replays instead of dropping history');
  rmSync(delivery.file);
  mkdirSync(delivery.file);
  assert.equal(saveActivityCursor(delivery, 1), false, 'a refused cursor save reports failure without hiding it');
  const refusedSave = await box.runLocal(box.web, 'inbox', '--json');
  assert.equal(refusedSave.code, 0, refusedSave.err);
  const savedFailure = JSON.parse(refusedSave.out);
  const saveDiagnostic = JSON.stringify({ activityPresent: Boolean(savedFailure.activity), diagnostics: savedFailure.diagnostics });
  assert.ok(savedFailure.activity, `delivery remains readable when local persistence fails: ${saveDiagnostic}`);
  assert.ok(savedFailure.diagnostics?.includes('activity cursor could not be saved; activity may repeat when you read inbox again'),
    `JSON callers receive the complete persistence warning in the standard diagnostics array: ${saveDiagnostic}`);
  rmSync(delivery.file, { recursive: true });
});

test('old ordinary shout replay does not become newly typed news [H16,N26]', (t) => {
  const board = openBoard(':memory:');
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: '/private-legacy-feed' });
  store.register(board, { lane: 'web', path: '/private-legacy-feed/web-1' });
  const move = prepareEngineMove(board, 'shout', [{ from: 'coordinator', to: 'all', lanes: ['web'],
    text: 'Historical metadata is not a new delivery instruction.', detail: { news: true } }]);
  applyEngineMove(board, { ...move, engine: 1 }, { sequence: 1, at: new Date().toISOString() });
  const agentMove = prepareEngineMove(board, 'shout', [{ from: 'web-1', to: 'all', lanes: ['web'],
    text: 'Legacy agent metadata cannot hide a direct message.', detail: { news: true, newsFormat: 1 } }]);
  applyEngineMove(board, { ...agentMove, engine: 1 }, { sequence: 2, at: new Date().toISOString() });
  const exactText = 'Legacy coordinator metadata is not an instruction to hide this message.';
  const exactTagMove = prepareEngineMove(board, 'shout', [{ from: 'coordinator', to: 'all', lanes: ['web'],
    text: exactText, detail: { news: true, newsFormat: 1 } }]);
  const oldOutcome = applyEngineMove(board, { ...exactTagMove, engine: ACTIVITY_NEWS_ENGINE - 1 },
    { sequence: 3, at: new Date().toISOString() });
  assert.equal(oldOutcome.error, undefined, 'the last old engine still supports ordinary metadata-bearing shouts');
  const legacyDetail = JSON.parse(oldOutcome.events[0].event_detail);
  assert.equal(legacyDetail.news, true);
  assert.equal(legacyDetail.newsFormat, 1, 'legacy replay preserves the recorded arbitrary detail');
  const nativeBeforeRead = exportBoard(board);
  const feed = store.agentActivity(board, 'web-1', { sessionStart: true });
  assert.ok(feed.entries.some(entry => entry.text === exactText),
    'an old-engine coordinator message stays direct even when its arbitrary metadata matches both new tags');
  assert.ok(feed.entries.some(entry => entry.text === 'Historical metadata is not a new delivery instruction.'));
  assert.deepEqual(feed.digests, [], 'only the new versioned explicit representation is digested');
  assert.equal(feed.entries.some(entry => entry.text === 'Legacy agent metadata cannot hide a direct message.'), false,
    'supplemental news reads never reintroduce the sender\'s own ordinary broadcast');
  // The sender does not read its own broadcast; the coordinator must still receive it directly.
  const coordinator = store.agentActivity(board, 'coordinator', { sessionStart: true });
  assert.ok(coordinator.entries.some(entry => entry.text === 'Legacy agent metadata cannot hide a direct message.'));
  assert.deepEqual(coordinator.digests, []);
  assert.deepEqual(exportBoard(board), nativeBeforeRead, 'reading does not rewrite legacy metadata or native receipts');
  const typedMove = prepareEngineMove(board, 'shout', [{ from: 'coordinator', to: 'all', lanes: ['web'],
    text: 'New typed news survives ordered replay and native export.', news: true }]);
  const typed = applyEngineMove(board, typedMove, { sequence: 4, at: new Date().toISOString() });
  assert.equal(typed.error, undefined);
  assert.equal(typed.events[0].event_kind, 'shout_news', 'only the new-engine typed path emits the new native kind');
  const replica = openBoard(':memory:');
  t.after(() => store.closeBoard(replica));
  importBoard(replica, exportBoard(board));
  assert.deepEqual(store.events(replica), store.events(board), 'native export/import preserves old and new exact event rows');
  const restored = store.agentActivity(replica, 'web-1', { sessionStart: true });
  assert.ok(restored.entries.some(entry => entry.text === exactText), 'native restore never upgrades old detail into news');
  assert.deepEqual(restored.digests.find(digest => digest.kind === 'news')?.shouts, [typed.result]);
});


test('interrupts arrive at once and the digest arrives as a short summary at a break [R2,N26,H16]', async t => {
  const box = e2e.project('true', e2e.sandbox({ declareFamilies: true }));
  const foreignRoot = join(box.dir, 'interrupt-other');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', foreignRoot, 'main');
  assert.equal(fixtureJoin(box.run, foreignRoot, 'api', '--json').code, 0);
  const base = box.git(box.web, 'rev-parse', 'HEAD');
  assert.equal(e2e.commitFile(box, box.web, 'web/interrupt.txt', 'private interrupt fixture\n', 'feat(web): interrupt fixture [G1]').status, 0);
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  const tree = box.git(box.web, 'rev-parse', 'HEAD^{tree}');
  // A real sibling commit keeps this rejected fixture out of the later item's ancestry.
  const rejectedCommit = box.git(box.repo, 'commit-tree', tree, '-p', base, '-m', 'private rejected sibling');
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
  t.after(() => store.closeBoard(board));
  requireFixtureReviewFamilies(board);
  const reviewer = store.register(board, { lane: 'api', path: join(box.dir, 'interrupt-reviewer'), family: 'Fixture Interrupt Reviewer Vendor' });
  const rejected = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Private rejected work', criterion: 'Private rejected work' });
  store.claim(board, rejected, { agentId: 'web-1', lane: 'web', leaseMs: 3_600_000, head: base, freeze });
  submitFixture(board, rejected, { agentId: 'web-1', commit: rejectedCommit, tree });
  store.verify(board, rejected, { agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE',
    note: 'Synthetic board-state refusal, not an executed gate.', clause: 'Private rejected work', head: rejectedCommit, digest: freeze().digest,
    policy: 'any', familyPolicy: 'off', reopenFirstRefusalMinutes: 30,
    review: { commit: rejectedCommit, head: rejectedCommit, trunk: base, paths: ['web/interrupt.txt'] } });
  const active = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Private lapsing work',
    criterion: 'The private break file is committed.', brief: 'Files: web/interrupt.txt\nTest: preserve the private fixture\n' });
  const nativeClaim = await box.runLocal(box.web, 'claim', String(active), '--json');
  assert.equal(nativeClaim.code, 0, `${nativeClaim.err}\n${nativeClaim.out}`);
  // Shorten only this real native claim's lease; its actual frozen criterion remains unchanged.
  store.claim(board, active, { agentId: 'web-1', lane: 'web', leaseMs: 4 * 60_000, head: base, freeze });
  const question = store.shout(board, { from: 'web-1', to: 'coordinator', text: 'Which private path?', decision: true, lanes: ['web', 'api'] });
  store.answerDecision(board, question, { agentId: 'coordinator', text: 'Use the private reviewed path.', lanes: ['web', 'api'] });
  // A synthetic landing receipt exercises real Git overlap; it is not a claim of a live landing proof.
  store.recordLandingBatch(board, { agentId: 'coordinator', batch: { version: 1, id: 'interrupt-private-main',
    state: 'pushed', base, tip: commit, root: box.web, branch: 'refs/heads/main', owner: 'private-fixture',
    logPath: join(box.dir, 'private-interrupt.log'), items: [] } });
  store.finishLandingBatch(board, { agentId: 'coordinator', id: 'interrupt-private-main', tip: commit });
  const other = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Private digest work' });
  store.appendFact(board, other, { agentId: 'coordinator', kind: 'note', text: 'PRIVATE_RAW_STATUS_MUST_NOT_BE_DIGEST_TEXT' });
  const claimBefore = store.getItem(board, active);
  const first = await box.runLocal(box.web, 'inbox', '--json');
  assert.equal(first.code, 0, first.err);
  const feed = JSON.parse(first.out).activity;
  assert.ok(Array.isArray(feed.interrupts), 'the actual inbox separates actionable interrupts from the digest');
  assert.deepEqual(new Set(feed.interrupts.map(entry => entry.reason)),
    new Set(['rejected', 'claim-lapsing', 'answered', 'files-changed']), 'every required interrupt reaches the next check');
  assert.ok(feed.interrupts.find(entry => entry.reason === 'files-changed').files.includes('web/interrupt.txt'));
  assert.ok(feed.digests.length, 'session start delivers a short summary');
  assert.equal(JSON.stringify(feed.digests).includes('PRIVATE_RAW_STATUS_MUST_NOT_BE_DIGEST_TEXT'), false);
  const delivered = store.events(board).filter(event => event.event_kind === 'activity-delivered');
  assert.ok(delivered.length, 'delivery is recorded on the canonical board, not just a checkout cursor');
  assert.ok(delivered.every(event => event.event_by === 'web-1'), 'the recipient owns its delivery receipts');
  assert.deepEqual(store.getItem(board, active), claimBefore, 'delivery grants no claim or lease authority');
  const again = await box.runLocal(box.web, 'inbox', '--json');
  assert.equal(again.code, 0, again.err);
  // #1885: delivered obligations stay pending by id on a repeat read; they are never replayed as text.
  assert.deepEqual(JSON.parse(again.out).activity.interrupts, [], 'a repeat read replays no delivered interrupt');
  assert.deepEqual(new Set(JSON.parse(again.out).activity.pending), new Set(feed.interrupts.map(entry => entry.id)),
    'reading or advancing a checkout cursor never means acted-on');
  assert.deepEqual(JSON.parse(again.out).activity.digests, [], 'ordinary checks do not deliver the digest');
  const ids = feed.interrupts.map(entry => entry.id).join(',');
  const beforeForeign = exportBoard(board);
  const foreign = await box.runLocal(foreignRoot, 'inbox', '--acted-on', ids, '--json');
  assert.equal(JSON.parse(foreign.out).error?.code, 'ACTIVITY_NOT_DELIVERED');
  assert.deepEqual(exportBoard(board), beforeForeign, 'another recipient cannot acknowledge these obligations');
  const acted = await box.runLocal(box.web, 'inbox', '--acted-on', ids, '--json');
  assert.equal(acted.code, 0, acted.err);
  assert.deepEqual(JSON.parse(acted.out).activity.interrupts, []);
  const actedEvents = store.events(board).filter(event => event.event_kind === 'activity-acted');
  assert.equal(actedEvents.length, 1);
  assert.deepEqual(new Set(JSON.parse(actedEvents[0].event_detail).interrupts), new Set(feed.interrupts.map(entry => entry.id)));
  store.appendFact(board, other, { agentId: 'coordinator', kind: 'note', text: 'SECOND_PRIVATE_RAW_STATUS_BODY' });
  const beforeBreak = await box.runLocal(box.web, 'inbox', '--json');
  assert.equal(beforeBreak.code, 0, beforeBreak.err);
  assert.deepEqual(JSON.parse(beforeBreak.out).activity.digests, [], 'new digest activity waits for a natural break');
  assert.equal(e2e.commitFile(box, box.web, 'web/after-break.txt', 'private submit break\n', 'feat(web): submit break [G1]').status, 0);
  const submitted = await box.runLocal(box.web, 'submit', String(active), '--json');
  assert.equal(submitted.code, 0, `${submitted.err}\n${submitted.out}`);
  const summary = JSON.parse(submitted.out).activity;
  assert.ok(summary.digests.length, 'the actual successful submit delivers the pending short digest');
  assert.equal(summary.budget?.counting, 'utf8-bytes', 'submit JSON retains the feed accounting and omission summary');
  assert.equal(JSON.stringify(summary.digests).includes('SECOND_PRIVATE_RAW_STATUS_BODY'), false);

});


test('interrupt receipts replay once and only their recipient can acknowledge delivered work [N26,H2,H16]', t => {
  const boards = ['origin', 'left', 'right'].map(() => openBoard(':memory:'));
  t.after(() => { for (const board of boards) store.closeBoard(board); });
  const [source, left, right] = boards;
  store.register(source, { lane: 'coordinator', path: '/interrupt-replay' });
  store.register(source, { lane: 'web', path: '/interrupt-replay/web-1' });
  store.register(source, { lane: 'web', path: '/interrupt-replay/web-2' });
  const question = store.shout(source, { from: 'web-1', to: 'coordinator', text: 'Choose a private path', decision: true, lanes: ['web'] });
  store.answerDecision(source, question, { agentId: 'coordinator', text: 'Use the reviewed path', lanes: ['web'] });
  const event = store.events(source).findLast(row => row.event_kind === 'answer');
  const initial = exportBoard(source);
  for (const board of [left, right]) importBoard(board, initial);
  const interrupt = { id: `event:${event.event_id}`, eventId: event.event_id, reason: 'answered', text: 'An answer is waiting' };
  const payload = { agentId: 'web-1', through: event.event_id, interrupts: [interrupt] };
  const beforeRead = exportBoard(left);
  const changes = left.db.prepare('SELECT total_changes() AS count').get().count;
  assert.equal(readActivityDelivery(left, 'web-1', { sessionStart: true }).interrupts[0]?.reason, 'answered');
  assert.deepEqual(exportBoard(left), beforeRead, 'the public read projection neither delivers nor acknowledges');
  assert.equal(left.db.prepare('SELECT total_changes() AS count').get().count, changes);
  const delivery = prepareEngineMove(source, 'recordActivityDelivery', [payload]);
  const at = new Date().toISOString();
  assert.equal(relaySenderProblem(delivery, { kind: 'agent', agent: 'web-2', userId: 'private-user' }, 'move')?.code, 'RELAY_SENDER_MISMATCH');
  const untouched = exportBoard(left);
  assert.throws(() => applyEngineMove(left, { ...delivery, engine: ACTIVITY_DELIVERY_ENGINE - 1 }, { sequence: 1, at }),
    error => error.code === 'RELAY_MOVE');
  assert.deepEqual(exportBoard(left), untouched, 'an older engine changes neither native history nor the replay prefix');
  const outcomes = boards.map(board => applyEngineMove(board, delivery, { sequence: 1, at }));
  assert.equal(outcomes[0].error, undefined);
  assert.deepEqual(outcomes[1], outcomes[2]);
  assert.equal(store.activityDeliveryState(left, 'web-1').pending.length, 1);
  assert.deepEqual(applyEngineMove(left, delivery, { sequence: 1, at }), outcomes[1]);
  assert.equal(store.events(left).filter(row => row.event_kind === 'activity-delivered').length, 1);
  const beforeBad = exportBoard(left);
  assert.throws(() => store.actOnActivity(left, { agentId: 'web-2', ids: [interrupt.id] }), error => error.code === 'ACTIVITY_NOT_DELIVERED');
  assert.throws(() => store.actOnActivity(left, { agentId: 'web-1', ids: [interrupt.id, 'event:999999'] }), error => error.code === 'ACTIVITY_NOT_DELIVERED');
  assert.deepEqual(exportBoard(left), beforeBad, 'a forged or partly invalid acknowledgement is atomic');
  const ack = prepareEngineMove(source, 'actOnActivity', [{ agentId: 'web-1', ids: [interrupt.id] }]);
  const acknowledged = boards.map(board => applyEngineMove(board, ack, { sequence: 2, at }));
  assert.deepEqual(acknowledged[1], acknowledged[2]);
  assert.equal(store.activityDeliveryState(left, 'web-1').pending.length, 0);
  assert.equal(store.events(left).filter(row => row.event_kind === 'activity-acted').length, 1);
  assert.deepEqual(exportBoard(left), exportBoard(right));
  const beforeRetry = exportBoard(left);
  store.recordActivityDelivery(left, payload);
  store.actOnActivity(left, { agentId: 'web-1', ids: [interrupt.id] });
  assert.deepEqual(exportBoard(left), beforeRetry, 'a new local retry cannot redeliver or re-acknowledge the same source event');
});

test('pullboard inbox answers in under a second on a 40,000-shout backlog and matches the inbox API [B26,C7]', t => {
  const box = e2e.project();
  // This raw inbox-API comparison explicitly requests room for the whole directed backlog.
  const configPath = join(box.web, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.inbox = { tokenBudget: 1_048_576 };
  writeFileSync(configPath, JSON.stringify(config));
  // An in-memory-style fixture board with a declared persistence purpose; the CLI reads a copy of its file.
  const board = fixtureBoard(t, { storage: 'file', purpose: 'persistence' });
  const boardFile = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file;
  const target = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  /** Copy the fixture's committed pages over the project's board, where the CLI reads it. */
  const publish = () => {
    board.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    copyFileSync(boardFile, target);
    rmSync(`${target}-wal`, { force: true });
    rmSync(`${target}-shm`, { force: true });
  };
  const coordinator = store.register(board, { lane: 'coordinator', path: box.repo });
  const seat = store.register(board, { lane: 'web', path: box.web });
  const items = Array.from({ length: 300 }, (_, index) => store.addItem(board, { by: 'coordinator', lane: 'web', title: `Backlog item ${index}`, criterion: 'The item is read.' }));
  const other = store.register(board, { lane: 'web', path: join(box.dir, 'web-other') });
  // Most of the backlog is someone else's: other seats and items this seat does not read. It stays on the board
  // for every read to scan, while this seat's directed shouts are the few it is owed (1 in 500).
  const seedBacklog = (from, to) => {
    for (let index = from; index < to; index += 1) {
      const item = index % 2 === 0 ? items[index % items.length] : undefined;
      const direct = index % 500 === 1;
      store.shout(board, { from: coordinator, to: direct ? seat : item === undefined ? other : `item:${item}`, item, text: `backlog shout ${index}`, lanes: ['web'] });
    }
  };
  seedBacklog(0, 40_000);
  publish();
  const first = timedInbox(box, board, seat);
  assert.ok(first.shoutIds.length >= 60 && first.shoutIds.length <= 100, `only the directed backlog is delivered: ${first.shoutIds.length}`);
  assert.ok(first.ms < 2500, `pullboard inbox used ${first.ms.toFixed(0)}ms of CPU on a 40,000-shout backlog`);
  // The CLI's read marks the seat's delivered shouts; the fixture takes the same cursor before the next backlog.
  board.db.prepare('UPDATE agent SET agent_last_shout_id = ? WHERE agent_id = ?').run(Math.max(...first.shoutIds), seat);
  // Seat history: its cursors are now set, and each later poll reads only what arrived since.
  seedBacklog(40_000, 42_000);
  publish();
  const later = timedInbox(box, board, seat);
  assert.ok(later.shoutIds.length >= 3 && later.shoutIds.length <= 6, `only the new directed shouts are delivered: ${later.shoutIds.length}`);
  assert.ok(later.ms < 2500, `a later pullboard inbox used ${later.ms.toFixed(0)}ms of CPU`);
});

/**
 * Run the real CLI from the seat's checkout, and read the same shouts through the store API before it runs.
 * The time is the CLI's own CPU time (user plus system, read in an exit hook), not the wall clock: a shared runner
 * can leave the process waiting for a core for seconds, and that wait says nothing about the work the inbox does.
 */
function timedInbox(box, board, seat) {
  const expected = store.inbox(board, seat, { markRead: false }).map(shout => shout.shout_id);
  // A first poll of a long backlog prints every shout, so the buffer is sized for the whole answer.
  // Process-level: the CPU-time hook is injected with --import into a real CLI process.
  const cpuHook = 'data:text/javascript,process.on("exit",()=>{const u=process.cpuUsage();process.stderr.write("CPU_MS="+(u.user+u.system)/1000)})';
  const result = spawnSync(process.execPath, ['--import', cpuHook, join(import.meta.dirname, '../../pullboard.js'), 'inbox', '--json'],
    { cwd: box.web, env: box.env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const ms = Number(/CPU_MS=([\d.]+)/.exec(result.stderr)?.[1]);
  assert.ok(Number.isFinite(ms), `the exit hook reported the CLI's CPU time: ${result.stderr}`);
  const shoutIds = JSON.parse(result.stdout).shouts.map(shout => shout.shout_id);
  assert.deepEqual(shoutIds, expected, 'the CLI delivers the same shouts as the inbox API');
  return { shoutIds, ms };
}

test('an inbox check over its budget summarizes the rest and names what it left out [R2,N26,H16]', async () => {
  const box = e2e.project();
  const configPath = join(box.web, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.inbox = { tokenBudget: 1024 };
  writeFileSync(configPath, JSON.stringify(config));
  // @pullboard-board-file journey: the real CLI subprocess reads and persists this project board between inbox checks
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  for (let index = 0; index < 12; index++) store.shout(board, { from: 'coordinator', to: 'web-1',
    text: `Private budget message ${index}: ${'界'.repeat(350)}`, lanes: ['web', 'api'] });
  const before = exportBoard(board);
  store.closeBoard(board);
  const result = await box.runLocal(box.web, 'inbox', '--json');
  assert.equal(result.code, 0, result.err);
  assert.ok(Buffer.byteLength(result.out, 'utf8') <= 1024,
    'the complete JSON delivery fits the configured conservative UTF-8 byte token budget');
  const delivered = JSON.parse(result.out);
  assert.equal(delivered.budget.counting, 'utf8-bytes', 'the public response declares its conservative accounting method');
  assert.equal(delivered.budget.limit, 1024);
  assert.equal(delivered.budget.omitted.shout, 12, 'every omitted message is counted once, not again as activity');
  assert.match(delivered.budget.summary, /12 shout/u, 'the summary names the omitted count and kind');
  assert.doesNotMatch(result.out, /Private budget message/u, 'oversized messages are summarized rather than partly leaked');
  const again = await box.runLocal(box.web, 'inbox', '--json');
  assert.equal(again.code, 0, again.err);
  const continued = JSON.parse(again.out);
  assert.equal(continued.shouts.length, 0, 'summarized messages are acknowledged rather than repeated forever');
  // @pullboard-board-file journey: the real CLI subprocess reads and persists this project board between inbox checks
  const unchanged = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  assert.deepEqual(exportBoard(unchanged).tables.event.filter(event => event.event_kind !== 'activity-delivered'),
    before.tables.event, 'budgeting preserves original immutable events while allowing canonical delivery receipts');
  assert.deepEqual(exportBoard(unchanged).tables.shout, before.tables.shout, 'budgeting preserves original message bodies');
  store.closeBoard(unchanged);
});

test('inbox budgets retain small deliveries and bound text without clipping messages [R2,N26]', async () => {
  const box = e2e.project();
  const configPath = join(box.web, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.inbox = { tokenBudget: 1024 };
  writeFileSync(configPath, JSON.stringify(config));
  // @pullboard-board-file journey: the real CLI subprocess reads and persists this project board between inbox checks
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  store.shout(board, { from: 'coordinator', to: 'web-1', text: 'An oversized message: ' + '界'.repeat(350), lanes: ['web'] });
  store.closeBoard(board);
  const text = await box.runLocal(box.web, 'inbox');
  assert.equal(text.code, 0, text.err);
  assert.ok(Buffer.byteLength(text.out) <= 1024);
  assert.match(text.out, /1 shout/u);
  assert.doesNotMatch(text.out, /An oversized message/u);
  config.inbox.tokenBudget = 2048;
  writeFileSync(configPath, JSON.stringify(config));
  // @pullboard-board-file journey: the real CLI subprocess reads and persists this project board between inbox checks
  const reopened = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  store.shout(reopened, { from: 'coordinator', to: 'web-1', text: 'Ready.', lanes: ['web'] });
  store.closeBoard(reopened);
  const small = await box.runLocal(box.web, 'inbox', '--json');
  assert.equal(small.code, 0, small.err);
  assert.ok(Buffer.byteLength(small.out) <= 2048);
  assert.equal(JSON.parse(small.out).shouts[0]?.shout_text, 'Ready.');
  config.inbox.tokenBudget = 1;
  writeFileSync(configPath, JSON.stringify(config));
  const invalid = await box.runLocal(box.web, 'inbox', '--json');
  assert.equal(invalid.code, 1);
  assert.equal(JSON.parse(invalid.out).error.code, 'BAD_CONFIG');
});

test('inbox budgets withhold interrupt receipts until the whole interrupt is rendered [R2,N26,H16]', async () => {
  const box = e2e.project();
  const configPath = join(box.web, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.inbox = { tokenBudget: 1024 };
  writeFileSync(configPath, JSON.stringify(config));
  // @pullboard-board-file journey: the real CLI subprocess reads and persists this project board between inbox checks
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  const question = store.shout(board, { from: 'web-1', to: 'coordinator', text: 'Which bounded path?',
    decision: true, lanes: ['web', 'api'] });
  store.answerDecision(board, question, { agentId: 'coordinator', text: '界'.repeat(350), lanes: ['web', 'api'] });
  const answer = store.events(board).findLast(event => event.event_kind === 'answer');
  const id = `event:${answer.event_id}`;
  const bodies = exportBoard(board).tables.shout;
  store.closeBoard(board);
  const small = await box.runLocal(box.web, 'inbox', '--json');
  assert.equal(small.code, 0, small.err);
  assert.ok(Buffer.byteLength(small.out) <= 1024);
  const withheld = JSON.parse(small.out);
  assert.deepEqual(withheld.activity.interrupts, []);
  assert.equal(withheld.budget.omitted.interrupt, 1);
  assert.match(withheld.budget.summary, /1 interrupt/u);
  // @pullboard-board-file journey: the real CLI subprocess reads and persists this project board between inbox checks
  const recorded = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  assert.ok(store.events(recorded).filter(event => event.event_kind === 'activity-delivered')
    .every(event => !JSON.parse(event.event_detail).interrupts.includes(id)), 'a summary is not an interrupt delivery receipt');
  assert.deepEqual(exportBoard(recorded).tables.shout, bodies, 'canonical source bodies stay intact');
  store.closeBoard(recorded);
  const premature = await box.runLocal(box.web, 'inbox', '--acted-on', id, '--json');
  assert.equal(JSON.parse(premature.out).error?.code, 'ACTIVITY_NOT_DELIVERED');
  config.inbox.tokenBudget = 8192;
  writeFileSync(configPath, JSON.stringify(config));
  const enlarged = await box.runLocal(box.web, 'inbox', '--json');
  assert.equal(enlarged.code, 0, enlarged.err);
  assert.ok(Buffer.byteLength(enlarged.out) <= 8192);
  assert.deepEqual(JSON.parse(enlarged.out).activity.interrupts.map(interrupt => interrupt.id), [id],
    'a withheld fresh obligation survives both canonical and local cursor advancement');
  const repeat = await box.runLocal(box.web, 'inbox', '--json');
  // #1885: a repeat read names the delivered, unacted obligation by id and never re-lists its text.
  assert.deepEqual(JSON.parse(repeat.out).activity.interrupts, [], 'a delivered interrupt is not replayed');
  assert.deepEqual(JSON.parse(repeat.out).activity.pending, [id], 'delivery still grants no acted-on authority');
  const acted = await box.runLocal(box.web, 'inbox', '--acted-on', id, '--json');
  assert.equal(acted.code, 0, acted.err);
  assert.deepEqual(JSON.parse(acted.out).activity.interrupts, []);
  assert.deepEqual(JSON.parse(acted.out).activity.pending, [], 'an acted-on interrupt leaves the pending list');
});


test('inbox omission metadata stays bounded across many digest event kinds [R2,N26,H16]', () => {
  const digests = Array.from({ length: 40 }, (_, index) => ({ kind: `fixture-event-kind-${index}`,
    count: index + 1, text: '界'.repeat(350) }));
  const document = budgetInbox({ shouts: [], activity: { interrupts: [], entries: [], digests, cursor: 1 } },
    1024, result => activityDeliveryLines(result, {}));
  assert.ok(Buffer.byteLength(JSON.stringify({ version: 1, ...document }, null, 2) + '\n') <= 1024,
    'the count metadata alone must fit the same delivery budget');
  assert.ok(Buffer.byteLength(activityDeliveryLines(document, {}).join('\n') + '\n') <= 1024);
  assert.deepEqual(document.activity.digests, []);
  assert.deepEqual(document.budget.omitted, { digest: 820 }, 'fixed delivery kinds preserve the exact omitted update count');
  assert.match(document.budget.summary, /820 digest/u);
});

/** Synthetic presentation input proves the supplied ports, not any native execution or receipt authority. */
test('activity delivery uses its caller actor and evidence presentation ports [R2,N26,H16]', () => {
  const document = { agents: [], shouts: [{ shout_id: 4, shout_at: '2026-10-28T10:00:00.000Z',
    shout_from: 'web-1', shout_to: 'coordinator', shout_text: 'A concrete blocker.',
    shout_evidence_kind: 'test', shout_evidence_outcome: 'red', shout_evidence_item: 3, shout_evidence_commit: 'a'.repeat(40) }],
  activity: { interrupts: [{ id: 'event:7', text: 'The actual obligation text.' }],
    entries: [], digests: [{ text: 'Two routine updates.' }] }, budget: { summary: 'One group withheld.' } };
  const before = structuredClone(document);
  const ports = {
    /** The caller owns how native actor identities are presented. */
    agentDisplayName(_agents, _config, id) { return `caller(${id})`; },
    /** The caller owns the existing evidence presentation contract. */
    evidenceLine(row) { return `${row.shout_evidence_kind}:${row.shout_evidence_outcome}:#${row.shout_evidence_item}`; },
  };
  const config = { lanes: {}, agents: { names: 'suffix' } };
  assert.deepEqual(activityDeliveryLines(document, config, ports), [
    '2026-10-28T10:00  caller(web-1) -> caller(coordinator): A concrete blocker.',
    '  test:red:#3', 'interrupt event:7: The actual obligation text.',
    'Two routine updates.', 'One group withheld.',
  ]);
  assert.deepEqual(document, before, 'presentation cannot rewrite canonical source groups');
});

test('clause 1: inbox on a board with 38 claimed items makes at most 3 Git processes [C7,#3252]', () => {
  const box = e2e.project('true');
  const heads = [box.git(box.web, 'rev-parse', 'HEAD')];
  for (let n = 0; n < 38; n++) {
    assert.equal(e2e.commitFile(box, box.web, `web/claimed-${n}.txt`, `claim ${n}\n`, `feat(web): claimed fixture ${n} [G1]`).status, 0);
    heads.push(box.git(box.web, 'rev-parse', 'HEAD'));
  }
  const builds = heads.slice(0, 38).map(item_claim_head => ({ item_claim_head }));
  const pairs = heads.slice(1).map((commit, n) => ({ commit, base: heads[n] }));
  const trace = join(box.web, '..', 'git-trace2.json');
  const before = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = trace;
  let observed, batch;
  try {
    observed = activityWorkingFiles(box.web, builds);
    batch = batchMainFiles(box.web, pairs);
  } finally {
    if (before === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = before;
  }
  const processes = readFileSync(trace, 'utf8').split('\n').filter(line => line.includes('"event":"version"')).length;
  assert.ok(processes >= 1 && processes <= 3, `${processes} Git processes read 38 claim bases and 38 landings`);
  assert.equal(observed.unknown, false);
  assert.deepEqual(observed.files.filter(file => file.startsWith('web/claimed-')).toSorted(), Array.from({ length: 38 }, (_, n) => `web/claimed-${n}.txt`).toSorted());
  for (const [n, pair] of pairs.entries()) {
    assert.deepEqual(batch.get(`${pair.base} ${pair.commit}`), [`web/claimed-${n}.txt`], 'each landing keeps its own file list');
    assert.deepEqual(activityMainFiles(box.web, pair.commit, { base: pair.base }).files, [`web/claimed-${n}.txt`], 'the single read agrees');
  }
});
