/** pullboard test --status <run> --json carries each case's outcome, read from the outcome frames, behind test.statusOutcomes, off by default (#9085) [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { queueTestRun } from '../../../../../packages/drive/index.js';
import { writeStep } from '../../../../../packages/jobs/index.js';
import { settingsInventory } from '../../../../../packages/config/index.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { withFixtureBoard } from '../../fixtures/board.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const RUN_ID = '11111111-2222-3333-4444-555555555555';
const FRAME = '# pullboard test outcomes ';

/** One outcome frame line, as the test reporter prints it. */
function frame(file, name, passed, skipped = false) { return `${FRAME}${JSON.stringify({ version: 1, id: RUN_ID, tests: [{ file, name, passed, skipped }] })}\n`; }

/**
 * A finished red run whose log is cut to its last 40 KB: 300 padding lines of TAP that the cut loses, then the frames at
 * the end, as the runner writes them. Returns the project, the run id and the cases the frames hold.
 */
function finishedRun() {
  const box = e2e.project(undefined, undefined, { withWorktree: false });
  const commonDir = join(box.repo, '.git');
  const run = withFixtureBoard(join(commonDir, 'pullboard', 'board.sqlite'), board => queueTestRun({ info: { commonDir, root: box.repo } },
    work => work(board), { agent: 'seat', files: ['test/a.test.js'] }, { launch: () => ({ unref() {} }) }));
  const cases = [['test/a.test.js', 'clause 1: first', true, false], ['test/a.test.js', 'clause 2: second', false, false], ['test/b.test.js', 'clause 3: third', true, true]];
  const full = Array.from({ length: 2000 }, (_, at) => `ok ${at + 1} - clause ${at + 1}: padding case number ${at + 1} of the big run\n`).join('') + cases.map(row => frame(...row)).join('');
  const log = join(box.dir, 'output.log');
  writeFileSync(log, full.slice(-40_000));
  assert.ok(full.length > 40_000 && statSync(log).size <= 40_000, 'the log was cut to its last 40 KB');
  assert.ok(!readFileSync(log, 'utf8').includes('ok 1 - clause 1:'), 'the cut lost the first TAP lines');
  withFixtureBoard(join(commonDir, 'pullboard', 'board.sqlite'), board => writeStep(board.db, run.id, 'result', { green: false, runner: 'r', seconds: 3, counts: null, failures: [], logPath: log, files: ['test/a.test.js'], notices: [] }));
  return { box, run, cases };
}

/** Turn test.statusOutcomes on in the project's machine settings. */
function turnOn(box) {
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), test: { statusOutcomes: true } }));
}

test('clause 1: with test.statusOutcomes on, test --status --json of a finished run carries the outcomes read from its frames, even when the log is cut to its last 40 KB (#9085) [C7]', async () => {
  const { box, run, cases } = finishedRun();
  turnOn(box);
  const status = await box.inProcess(box.repo, 'test', '--status', run.id, '--json');
  assert.equal(status.code, 1, `${status.out}${status.err}`);
  const document = JSON.parse(status.out);
  assert.deepEqual(document.outcomes, cases.map(([file, name, passed, skipped]) => ({ file, name, passed, skipped })));
});

test('clause 2: with test.statusOutcomes off the test --status --json document is the same as before, with no outcomes key (#9085) [C7]', async () => {
  const { box, run } = finishedRun();
  const status = await box.inProcess(box.repo, 'test', '--status', run.id, '--json');
  const document = JSON.parse(status.out);
  assert.equal('outcomes' in document, false);
  assert.equal(document.status, 'red');
  assert.equal(document.id, run.id);
});

test('clause 3: test.statusOutcomes is a described setting, off by default, and on only for an exact true (#9085) [C7]', async () => {
  const { box } = finishedRun();
  const row = () => {
    const saved = process.env.PULLBOARD_MACHINE_HOME;
    process.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_MACHINE_HOME;
    try { return settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(entry => entry.key === 'test.statusOutcomes'); }
    finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
  };
  const unset = row();
  assert.equal(unset.default, false);
  assert.equal(unset.value, false);
  assert.ok(unset.label && unset.description);
  assert.match(unset.description, /40 KB/u);
  turnOn(box);
  assert.equal(row().value, true);
});
