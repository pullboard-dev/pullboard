/** @pullboard-test-loads apps/cli/src/io/commands/red.js */
/** @pullboard-test-loads apps/cli/src/io/test/pull.js */
/** pullboard red bisect probes each commit as a pulled test job on the board's local runner, and refuses RED_NO_PROBE only on a board with no runner [P7,C7,#7575]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { receiptBody } from '../../../../packages/gate/index.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { BOARD_FILE } from '../../tests/fixtures/check-baseline.js';
import { cleanupFixtures } from '../../tests/fixtures/check-baseline.js';
import { project } from '../../tests/fixtures/check-baseline.js';
import { withBoard } from '../../tests/fixtures/check-baseline.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';

after(cleanupFixtures);

const FILE = 'web/sample.test.js', SOURCE = 'web/logic.js';
const SAMPLE = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { n } from './logic.js';\ntest('n stays small', () => assert.ok(n < 5));\n";

/**
 * A board whose main runs FILE green at n = 1 and red at n = 7, one commit per n, with a gate receipt recorded at each
 * end; the commit that sets n = 5 is the one that breaks it. Synthetic receipts live only in this private fixture.
 */
function history(box) {
  const config = join(box.repo, 'pullboard.json');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), affectedTests: 'node --test' }, null, 2) + '\n');
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(box.repo, FILE), SAMPLE);
  const save = n => {
    writeFileSync(join(box.repo, SOURCE), `export const n = ${n};\n`);
    box.git(box.repo, 'add', '-A');
    box.git(box.repo, 'commit', '-q', '-m', `test(fixture): n is ${n} [G1]`);
    return { head: box.git(box.repo, 'rev-parse', 'HEAD'), tree: box.git(box.repo, 'rev-parse', 'HEAD^{tree}') };
  };
  const commits = [1, 2, 3, 4, 5, 6, 7].map(save);
  const folder = join(box.repo, '.git', 'pullboard', 'gate-receipts');
  mkdirSync(folder, { recursive: true });
  const make = (id, { head, tree }, passed) => ({ version: 1, id, kind: 'gate', head, tree, main: null,
    command: 'a'.repeat(64), green: passed, failures: passed ? [] : [{ file: FILE, name: 'n stays small' }],
    load: { average: [0, 0, 0], cpus: 1, freeMB: 100 }, at: '2026-01-01T00:00:00.000Z',
    testOutcomes: [{ file: FILE, name: 'n stays small', passed, skipped: false }] });
  for (const row of [make('11111111-1111-4111-8111-111111111111', commits[0], true), make('22222222-2222-4222-8222-222222222222', commits[6], false)]) {
    writeFileSync(join(folder, `${row.id}.json`), receiptBody(row));
  }
  return commits.map(commit => commit.head);
}

test('clause 1: red bisect on a board with a local pull runner probes through runner test jobs and names the breaking commit, without RED_NO_PROBE [P7,C7,#7575]', { timeout: 240_000 }, // budget: hang ceiling for a project and three runner test jobs.
async () => {
  const box = project();
  const commits = history(box);
  const ran = box.run(box.repo, ['red', 'bisect', FILE]);
  assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}`);
  assert.doesNotMatch(ran.stderr, /RED_NO_PROBE/u);
  const found = /Breaking commit: ([0-9a-f]{40}) \((\d+) probes over (\d+) closure commits\)/u.exec(ran.stdout);
  assert.ok(found, ran.stdout);
  assert.equal(found[1], commits[4], 'the commit that set n = 5 broke the file');
  assert.equal(found[3], '6', 'every commit after the green touches the closure');
  const jobs = withBoard(join(box.repo, BOARD_FILE), board => jobsOf(board.db, { kind: 'test' }));
  assert.equal(jobs.length, Number(found[2]), 'one runner test job per probe');
  assert.ok(jobs.every(job => job.steps.some(step => step.name === 'receipt')), 'a runner posted every probe\'s receipt');
});

test('clause 1: red bisect on a board with no runner still refuses RED_NO_PROBE and offers no job [P7,C7,#7575]', { timeout: 120_000 }, // budget: hang ceiling for a project and one refused command.
async () => {
  const box = project();
  history(box);
  const settings = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const current = JSON.parse(readFileSync(settings, 'utf8'));
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { ...current, runners: [], gate: { ...current.gate, localRunner: false } });
  const ran = box.run(box.repo, ['red', 'bisect', FILE]);
  assert.equal(ran.status, 1, `${ran.stdout}${ran.stderr}`);
  assert.match(ran.stderr, /RED_NO_PROBE: red bisect needs a pull runner/u);
  assert.deepEqual(withBoard(join(box.repo, BOARD_FILE), board => jobsOf(board.db, { kind: 'test' })), []);
});
