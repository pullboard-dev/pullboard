/** A main audit's new failure is attributed to the items landed since the last green audit and filed to their lane [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  board as store,
  closeBoard,
  loadConfig,
  openBoard,
  openBoardForRead,
} from '../../../../index.js';
import {
  activateMainAudits,
  attributeAuditFailures,
  fileAuditRegressions,
  mainAuditJobs,
  routeAuditFailures,
  saveMainAudit,
} from '../../../../../../packages/gate/index.js';

/** Run real Git in the fixture with no user or system configuration, optionally at a fixed date. */
function gitAt(date, root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) } }).trim();
}

/** Run real Git in the fixture at the current time. */
function git(root, ...args) { return gitAt(null, root, ...args); }

/** The worker-shaped Git runner the attribution module takes: raw stdout, throwing on refusal. */
function gitService(root, args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }

/** Commit one file change on main, optionally at a given date, and return the new tip. */
function commit(repo, file, text, message, date) {
  writeFileSync(join(repo, file), text);
  git(repo, 'add', '-A');
  gitAt(date, repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

/**
 * A real repo and real SQLite board with an activated main audit and a green audit at `green`.
 * Lane alpha owns test/a.test.js and lane beta owns test/b.test.js; one item waits in each lane.
 */
async function greenAudited(t) {
  const scratch = mkdtempSync(join(tmpdir(), 'pullboard audit attribution '));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const repo = join(scratch, 'repo');
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'node --test', verify: 'any',
    lanes: { alpha: { owns: ['test/a.test.js'], specs: [] }, beta: { owns: ['test/b.test.js'], specs: [] } }, shared: ['pullboard.json'] }));
  writeFileSync(join(repo, 'test/b.test.js'), "import {test} from 'node:test';test('b',()=>{});\n");
  git(repo, 'init', '-q', '-b', 'main');
  commit(repo, 'test/a.test.js', "import {test} from 'node:test';test('a',()=>{});\n", 'chore: base',
    new Date(Date.now() - 3600000).toISOString());
  const file = join(repo, '.git/pullboard/board.sqlite');
  // @pullboard-board-file journey: the worker's writer and the audit read the same repository board file
  const db = openBoard(file, undefined, { isMain: true, gitRoot: repo });
  let identity, alpha, beta;
  try {
    alpha = store.addItem(db, { by: 'coordinator', lane: 'alpha', title: 'Alpha change', criterion: 'Lands by hand' });
    beta = store.addItem(db, { by: 'coordinator', lane: 'beta', title: 'Beta change', criterion: 'Lands by hand' });
    identity = { id: store.boardId(db), after: store.events(db).at(-1).event_id };
  } finally { closeBoard(db); }
  await activateMainAudits(repo, identity.after, identity.id);
  const directory = join(repo, '.git/pullboard/main-audits');
  const green = commit(repo, 'test/a.test.js', "import {test} from 'node:test';test('a2',()=>{});\n", 'chore: audited');
  saveMainAudit(join(directory, 'last-green.json'), { version: 1, complete: true, green: true, receiptId: 'fixture-receipt',
    tip: green, tree: git(repo, 'rev-parse', 'HEAD^{tree}'), keys: { 'test/a.test.js': 'ka', 'test/b.test.js': 'kb' } });
  /** Run an action against a fresh read of the real board. */
  const read = action => { const board = openBoardForRead(file); try { return action(board); } finally { closeBoard(board); } };
  /** Apply one ordered move to the real board, as the worker's writer does. */
  const write = async (operation, args) => {
    // @pullboard-board-file journey: the worker's writer and the audit read the same repository board file
    const board = openBoard(file, undefined, { isMain: true, gitRoot: repo });
    try { return store[operation](board, ...args); } finally { closeBoard(board); }
  };
  const items = () => read(board => board.db.prepare('SELECT item_id,item_lane,item_title,item_criterion FROM item ORDER BY item_id').all());
  return { repo, directory, green, alpha, beta, read, write, items, services: { git: gitService, store, read, write } };
}

/** The one queued main-commit audit job at main's tip. */
function onlyJob(fixture) {
  const jobs = mainAuditJobs(fixture.repo, openBoardForRead);
  assert.equal(jobs.length, 1);
  return jobs[0];
}

test('a test that passed in the last green audit and fails now is attributed to the items landed between the two tips [C7]', async t => {
  const fixture = await greenAudited(t);
  const tip = commit(fixture.repo, 'test/b.test.js', "import {test} from 'node:test';test('b',()=>{throw 1});\n",
    `fix(alpha): touches beta's test\n\nPullboard-Item: #${fixture.alpha}`);
  const job = onlyJob(fixture);
  assert.equal(job.base, fixture.green, 'the range starts at the last green audited tip');
  const failures = [{ file: 'test/b.test.js', name: 'b' }, { file: 'test/new.test.js', name: 'never ran green' }];
  const regressions = fixture.read(board => attributeAuditFailures({ git: gitService, store }, fixture.repo, board, fixture.directory, job, failures));
  assert.deepEqual(regressions, [{ test: 'test/b.test.js', greenTip: fixture.green, tip, names: ['b'],
    items: [{ id: fixture.alpha, lane: 'alpha' }], lane: 'alpha' }],
  'only the test the green audit passed is attributed, to the trailer item and its lane, not the test owner\'s lane');
});

test('the attributed failure is filed once to the landed item\'s lane, naming the test and both tips [C7]', async t => {
  const fixture = await greenAudited(t);
  const tip = commit(fixture.repo, 'test/b.test.js', "import {test} from 'node:test';test('b',()=>{throw 1});\n",
    `fix(alpha): touches beta's test\n\nPullboard-Item: #${fixture.alpha}`);
  const job = onlyJob(fixture);
  const failures = [{ file: 'test/b.test.js', name: 'b' }];
  const before = fixture.items().length;
  const [first] = await fileAuditRegressions(fixture.services, fixture.repo, fixture.directory, job, failures);
  assert.equal(first.filed, true);
  const filed = fixture.items().find(row => row.item_id === first.item);
  assert.equal(filed.item_lane, 'alpha', 'filed to the landed item\'s lane');
  assert.match(filed.item_title, /test\/b\.test\.js/u, 'the title names the failing test');
  assert.ok(filed.item_criterion.includes(tip) && filed.item_criterion.includes(fixture.green), 'the bar names both audit tips');
  assert.ok(filed.item_criterion.includes(`#${fixture.alpha}`), 'the bar names the suspect item');
  assert.equal(filed.item_criterion.match(/(?:^|\s)\d+\. /gu).length, 3, 'the bar has three numbered clauses');
  const minutes = fixture.read(board => board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`item_expected_build_minutes:${first.item}`));
  assert.equal(JSON.parse(minutes.meta_value), 30, 'the bar expects at most 30 minutes');
  const again = await fileAuditRegressions(fixture.services, fixture.repo, fixture.directory, job, failures);
  assert.deepEqual(again, [{ test: 'test/b.test.js', item: first.item, filed: false, lane: 'alpha' }], 'a rerun finds the filed item');
  assert.equal(fixture.items().length, before + 1, 'the same test and tip is never filed twice');
});

test('a bare hotfix with no trailer item files the regression to the coordinator lane [C7]', async t => {
  const fixture = await greenAudited(t);
  commit(fixture.repo, 'test/a.test.js', "import {test} from 'node:test';test('a2',()=>{throw 1});\n", 'fix: coordinator hotfix');
  const job = onlyJob(fixture);
  const [row] = await fileAuditRegressions(fixture.services, fixture.repo, fixture.directory, job, [{ file: 'test/a.test.js', name: 'a2' }]);
  assert.equal(row.lane, 'coordinator');
  assert.equal(fixture.items().find(item => item.item_id === row.item).item_lane, 'coordinator');
  assert.match(fixture.items().find(item => item.item_id === row.item).item_criterion, /bare commit/u);
});

/**
 * Land `tip` as an automatic landing batch for `item`: claim, submit, accept, record and finish on the real board.
 * The acceptance is setup for the queue, never runtime proof.
 */
function landBatch(fixture, item, base, tip) {
  const file = join(fixture.repo, '.git/pullboard/board.sqlite');
  // @pullboard-board-file journey: the worker's writer and the audit read the same repository board file
  const db = openBoard(file, undefined, { isMain: true, gitRoot: fixture.repo });
  try {
    db.executionEngineVersion = 1;
    const [, builder, reviewer] = (() => { try { return [store.register(db, { lane: 'coordinator', path: fixture.repo }),
      store.register(db, { lane: 'alpha', path: join(fixture.repo, '..', 'builder') }),
      store.register(db, { lane: 'beta', path: join(fixture.repo, '..', 'reviewer') })]; } finally { delete db.executionEngineVersion; } })();
    const tree = git(fixture.repo, 'rev-parse', `${tip}^{tree}`), id = 'automatic-batch';
    store.claim(db, item, { agentId: builder, lane: 'alpha', leaseMs: 3600000,
      freeze: () => ({ text: JSON.stringify({ policy: { version: 1, commit: base, verify: { policy: 'any', family: 'off' } } }), digest: 'fixture-bar' }) });
    store.submit(db, item, { agentId: builder, commit: tip, tree, submissionProof: { version: 1, files: [], full: false, deferred: true, reason: 'fixture acceptance only' } });
    store.verify(db, item, { agentId: reviewer, head: tip, digest: 'fixture-bar', policy: 'any', decision: 'ACCEPT', note: 'fixture acceptance only' });
    store.recordLandingBatch(db, { agentId: 'coordinator', batch: { version: 1, id, state: 'trunk', base, tip, root: fixture.repo,
      branch: 'refs/heads/main', owner: 'coordinator-fixture', logPath: join(fixture.repo, '..', 'batch.log'), items: [{ id: item, commit: tip, merge: tip }] } });
    store.finishLandingBatch(db, { agentId: 'coordinator', id, tip });
    return id;
  } finally { closeBoard(db); }
}

test('an automatic landed batch that breaks a test the last green audit passed files the repair to its trailer item\'s lane [C7]', async t => {
  const fixture = await greenAudited(t);
  const tip = commit(fixture.repo, 'test/b.test.js', "import {test} from 'node:test';test('b',()=>{throw 1});\n",
    `fix(alpha): touches beta's test\n\nPullboard-Item: #${fixture.alpha}`);
  const batchId = landBatch(fixture, fixture.alpha, fixture.green, tip);
  const job = onlyJob(fixture);
  assert.equal(job.batchId, batchId, 'the landed batch covers the tip, so no main-commit job is queued');
  assert.equal(job.source, undefined, 'an ordinary automatic batch job carries no main-commit source');
  const before = fixture.items().length;
  const receipt = { green: false, failures: [{ file: 'test/b.test.js', name: 'b' }] };
  const route = () => routeAuditFailures(fixture.repo, job, receipt, loadConfig(fixture.repo), fixture.write, 0, openBoardForRead);
  await route();
  const filed = fixture.items().slice(before);
  assert.equal(filed.length, 1, 'one repair is filed');
  assert.equal(filed[0].item_lane, 'alpha', 'the repair goes to the trailer item\'s lane, not to beta, which owns the test');
  assert.match(filed[0].item_criterion, /test\/b\.test\.js/u, 'the bar names the failing test');
  const notes = () => fixture.read(board => board.db.prepare("SELECT json_extract(event_detail,'$.text') AS text FROM event WHERE event_kind='fact' AND item_id=?").all(filed[0].item_id))
    .map(row => row.text).filter(text => text.startsWith('Main audit regression:'));
  assert.equal(notes().length, 1);
  assert.ok(notes()[0].includes(fixture.green) && notes()[0].includes(tip) && notes()[0].includes(`#${fixture.alpha} (alpha)`),
    'the repair names both audit tips and the suspect item');
  await route();
  assert.equal(fixture.items().length, before + 1, 'a resumed audit never files the same test and tip twice');
  assert.equal(notes().length, 1, 'nor notes it twice');
});
