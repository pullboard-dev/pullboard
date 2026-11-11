/** Main's own commits queue the full-suite audit, with no landing batch needed [C7]. */
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
  openBoard,
  openBoardForRead,
} from '../../../../index.js';
import {
  activateMainAudits,
  mainAuditJobs,
  mainAuditKey,
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

/** Commit one file change on main, optionally at a given date, and return the new tip. */
function commit(repo, file, text, message, date) {
  writeFileSync(join(repo, file), text);
  git(repo, 'add', '-A');
  gitAt(date, repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

/** A real repo with a real SQLite board and an activated main audit, before main moves. */
async function activated(t) {
  const scratch = mkdtempSync(join(tmpdir(), 'pullboard plain commit audit '));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const repo = join(scratch, 'repo');
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'node --test', verify: 'any',
    lanes: { alpha: { owns: ['test/a.test.js'], specs: [] } }, shared: ['pullboard.json'] }));
  git(repo, 'init', '-q', '-b', 'main');
  const base = commit(repo, 'test/a.test.js', "import {test} from 'node:test';test('a',()=>{});\n", 'chore: base',
    new Date(Date.now() - 3600000).toISOString());
  const file = join(repo, '.git/pullboard/board.sqlite');
  const db = openBoard(file, undefined, { isMain: true, gitRoot: repo });
  let identity, item;
  try {
    item = store.addItem(db, { by: 'coordinator', lane: 'alpha', title: 'Hand-landed fix', criterion: 'Lands by hand' });
    identity = { id: store.boardId(db), after: store.events(db).at(-1).event_id };
  } finally { closeBoard(db); }
  await activateMainAudits(repo, identity.after, identity.id);
  /** Count landing_batch events on the real board. */
  function batches() {
    const read = openBoardForRead(file);
    try { return read.db.prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind='landing_batch'").get().n; }
    finally { closeBoard(read); }
  }
  return { repo, base, item, board: identity.id, batches, directory: join(repo, '.git/pullboard/main-audits') };
}

test('a plain commit on main with no landing batch queues an audit of main\'s tip [C7]', async t => {
  const fixture = await activated(t);
  const tip = commit(fixture.repo, 'test/a.test.js', "import {test} from 'node:test';test('a',()=>{throw 1});\n",
    `fix(gate): hand landing\n\nPullboard-Item: #${fixture.item}`);
  assert.equal(fixture.batches(), 0, 'main moved with no landing_batch event');
  const jobs = mainAuditJobs(fixture.repo, openBoardForRead);
  assert.equal(jobs.length, 1, 'exactly one audit job is queued');
  const [job] = jobs;
  assert.equal(job.tip, tip);
  assert.equal(job.tree, git(fixture.repo, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(job.board, fixture.board);
  assert.equal(job.branch, 'refs/heads/main');
  assert.equal(job.base, fixture.base, 'the range starts at main\'s tip when the audit was activated');
  assert.match(job.batchId, /^[a-zA-Z0-9_-]{1,80}$/u, 'the job id passes the gate\'s audit id rule');
  assert.deepEqual(job.items, [{ id: fixture.item, lane: 'alpha' }], 'the trailer names the landed item and its lane');
  assert.match(mainAuditKey(job), /^[a-f0-9]{64}$/u);
  assert.deepEqual(mainAuditJobs(fixture.repo, openBoardForRead).map(mainAuditKey), [mainAuditKey(job)], 'the same tip is the same obligation');
});

test('a green audit at main\'s tip clears the queue, and a later hotfix queues from that tip [C7]', async t => {
  const fixture = await activated(t);
  const audited = commit(fixture.repo, 'test/a.test.js', "import {test} from 'node:test';test('a2',()=>{});\n", 'chore: audited');
  saveMainAudit(join(fixture.directory, 'last-green.json'), { version: 1, complete: true, green: true,
    receiptId: 'fixture-receipt', tip: audited, tree: git(fixture.repo, 'rev-parse', 'HEAD^{tree}') });
  assert.deepEqual(mainAuditJobs(fixture.repo, openBoardForRead), [], 'nothing on main is unaudited');
  const hotfix = commit(fixture.repo, 'pullboard.json', '{}', 'fix: coordinator hotfix');
  const jobs = mainAuditJobs(fixture.repo, openBoardForRead);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].tip, hotfix);
  assert.equal(jobs[0].base, audited, 'the range starts after the last audited tip');
  assert.deepEqual(jobs[0].items, [], 'a hotfix with no trailer names no item');
  assert.equal(fixture.batches(), 0);
});

test('an activated main that has not moved queues no audit [C7]', async t => {
  const fixture = await activated(t);
  assert.deepEqual(mainAuditJobs(fixture.repo, openBoardForRead), [], 'activation alone is no retroactive full-suite run');
});
