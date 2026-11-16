/** @pullboard-test-input apps/cli/src/io/commands/show.js */
/** @pullboard-world-pin reads the shipped show command source to prove it prints the retained assertion lines. */
/** A red gate keeps its full log until its item lands or is withdrawn, and show prints the failing assertion from it [C7,#3381]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { HANDOFF_FOLDER_KEEP_MS } from '../../../../resources/index.js';
import { pruneFinishedHandoffs } from '../../../../resources/index.js';
import { failedAssertionLines } from '../../../index.js';
import { retainedGateAssertions } from '../../../index.js';
import { privateFixtureFiles } from '../../fixtures/child.js';

const LOG = [
  'TAP version 13',
  'not ok 1 - the gate names the overdue run [C7]',
  '  ---',
  '  duration_ms: 12.5',
  "  location: '/runner/jobs/x/checkout/packages/gate/tests/overdue.test.js:87:1'",
  "  failureType: 'testCodeFailure'",
  "  error: 'public output names the overdue run'",
  "  code: 'ERR_ASSERTION'",
  '  expected: 3',
  '  actual: |-',
  '    gate: held by someone',
  '    next: pullboard next',
  '  ...',
  'ok 2 - a passing case [C7]',
  '  ---',
  '  ...',
  '',
].join('\n');

/** A fixture repo's .git directory with a board that lists items by status, and one handoff folder per case. */
function fixtureRepo() {
  const fixture = privateFixtureFiles('pb-red-log-');
  const common = join(fixture.root, '.git');
  const pullboard = join(common, 'pullboard');
  mkdirSync(join(pullboard, 'submit-handoffs'), { recursive: true });
  const db = new DatabaseSync(join(pullboard, 'board.sqlite'));
  db.exec('CREATE TABLE item (item_id INTEGER PRIMARY KEY, item_status TEXT, item_merged_commit TEXT)');
  for (const [id, status, merged] of [[1, 'submitted', null], [2, 'verified', 'abc123'], [3, 'withdrawn', null], [4, 'claimed', null]]) {
    db.prepare('INSERT INTO item VALUES (?, ?, ?)').run(id, status, merged);
  }
  db.close();
  /** Write a finished red gate folder for an item, aged past the keep time. */
  function redFolder(job, item, log = LOG) {
    const directory = join(pullboard, 'submit-handoffs', job);
    mkdirSync(join(directory, 'output', 'run-1'), { recursive: true });
    writeFileSync(join(directory, 'request.json'), JSON.stringify({ item, job }));
    writeFileSync(join(directory, 'output', 'run-1', 'output.log'), log);
    writeFileSync(join(directory, 'refusal.json'), '{}');
    const old = new Date(Date.now() - HANDOFF_FOLDER_KEEP_MS - 60_000);
    utimesSync(join(directory, 'refusal.json'), old, old);
    return directory;
  }
  return { fixture, common, root: join(pullboard, 'submit-handoffs'), redFolder };
}

test('clause 1: the sweep keeps the output log of a red gate while its item is open, claimed or submitted, and removes it once the item landed or was withdrawn [C7,#3381]', t => {
  const repo = fixtureRepo();
  t.after(() => rmSync(repo.fixture.root, { recursive: true, force: true }));
  const submitted = repo.redFolder('job-submitted', 1);
  const claimed = repo.redFolder('job-claimed', 4);
  const landed = repo.redFolder('job-landed', 2);
  const withdrawn = repo.redFolder('job-withdrawn', 3);
  const removed = pruneFinishedHandoffs([repo.root]);
  assert.deepEqual(removed.sort(), [landed, withdrawn].sort());
  for (const kept of [submitted, claimed]) assert.ok(existsSync(join(kept, 'output', 'run-1', 'output.log')), kept);
});

test('clause 2: the failing assertion lines of a retained gate log give file:line, error, expected and actual for each failing case [C7,#3381]', t => {
  const repo = fixtureRepo();
  t.after(() => rmSync(repo.fixture.root, { recursive: true, force: true }));
  assert.deepEqual(failedAssertionLines(LOG), [
    'packages/gate/tests/overdue.test.js:87: the gate names the overdue run [C7]',
    '  error: public output names the overdue run',
    '  expected: 3',
    '  actual: gate: held by someone / next: pullboard next',
  ]);
  repo.redFolder('job-shown', 1);
  assert.deepEqual(retainedGateAssertions(repo.common, 'job-shown'), failedAssertionLines(LOG));
  assert.deepEqual(retainedGateAssertions(repo.common, 'job-missing'), []);
});

test('clause 2: show prints each retained failing assertion with the gate red prefix [C7,#3381]', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../../../../apps/cli/src/io/commands/show.js', import.meta.url), 'utf8');
  assert.match(source, /retainedGateAssertions\(ctx\.info\.commonDir, queuedJobId\)/u);
  assert.match(source, /gate red: \$\{line\}/u);
});
