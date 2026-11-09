/**
 * A scratch Pullboard project whose submits queue to the real gate dispatcher [C7]: a real repository with an origin
 * to land to, a real board, one builder seat in the web lane, and items whose check can hold until released.
 *
 * Why its own module: the end-to-end harness and the repro harnesses all need the same queued-gate project, and none
 * may touch the main checkout, so the project is built once here inside an e2e sandbox the kit watches.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { from, track } from './harness-kit.js';

const { createE2eHelpers } = await from('test/e2e-helpers.js');
const { fixtureAdd, createFixtureWorktree, fixtureCommittedPolicy, fixtureMachineSettings, withFixtureBoard } = await from('test/testkit-fixture.js');
const store = await from('packages/store/index.js');
const drive = await from('packages/drive/index.js');

/**
 * Quote one value for the configured shell command.
 *
 * @param {string} value
 * @returns {string}
 */
function word(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Parse a CLI result's JSON, failing with its output when the command failed.
 *
 * @param {{ code: number, out: string, err: string }} result
 * @returns {any}
 */
export function json(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/**
 * Build the project. Its gate check holds while the candidate's web/snapshot.txt says "hold" and the release file is
 * missing, writing the started file first, so a harness can catch a gate mid-run.
 *
 * @param {{ handoffWorkers?: number }} [options] - `handoffWorkers` sets the machine's worker cap.
 * @returns {object} The e2e box plus boardFile, release, started, item(), state(), driver() and settle().
 */
export function handoffProject({ handoffWorkers } = {}) {
  const helpers = createE2eHelpers();
  const isolated = helpers.sandbox();
  track(isolated.dir);
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete isolated.env[key];
  const box = helpers.project('true', isolated);
  const release = join(box.dir, 'release'), started = join(box.dir, 'started'), script = join(box.dir, 'gate.cjs');
  writeFileSync(script, [
    "const fs = require('node:fs');",
    "const value = fs.existsSync('web/snapshot.txt') ? fs.readFileSync('web/snapshot.txt', 'utf8').trim() : 'base';",
    "if (value === 'hold') {",
    ` fs.appendFileSync(${JSON.stringify(started)}, String(process.pid) + '\\n');`,
    ' const deadline = Date.now() + 180000;',
    ` while (!fs.existsSync(${JSON.stringify(release)})) { if (Date.now() > deadline) throw Error('release never arrived'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); }`,
    '}',
  ].join('\n'));
  const boardFile = fixtureCommittedPolicy(box, { submit: { handoff: true } });
  box.git(box.dir, 'init', '-q', '--bare', '-b', 'main', join(box.dir, 'origin.git'));
  box.git(box.repo, 'remote', 'add', 'origin', join(box.dir, 'origin.git'));
  box.git(box.repo, 'push', '-q', 'origin', 'main');
  if (handoffWorkers) fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { handoffWorkers } });
  const check = `${word(process.execPath)} ${word(script)}`;
  /** File one web item whose check is the holding gate, and return its id. */
  const item = (title = 'Hop harness item') => {
    const id = json(fixtureAdd(box.run, box.repo, 'web', title, '--route', 'strong', '--specs', 'G1',
      '--criterion', 'The hop harness candidate passes its check.', '--check', check, '--wait', '--json')).item.item_id;
    json(box.run(box.repo, 'fact', String(id), 'diagnosis',
      'Files: web/snapshot.txt Change: write the snapshot the hop harness holds on Test case: the queued gate finishes green', '--json'));
    return id;
  };
  /** Read the item, its current submit hand-off and its submit-gate count from the board, writing nothing. */
  const state = id => onBoard(boardFile, board => ({ item: store.getItem(board, id), job: store.submitHandoff(board, id) }));
  /** The gate's driver record for a hand-off job, as the dispatcher wrote it. */
  const driver = job => onBoard(boardFile, board => drive.readGateDrive(board.db, job));
  /** Another builder worktree joined to the web lane; returns its path. */
  const seat = () => {
    const made = createFixtureWorktree(box, box.repo, 'web');
    assert.equal(made.code, 0, `${made.err}\n${made.out}`);
    return JSON.parse(made.out).path;
  };
  /** Commit web/snapshot.txt with `text` in a builder checkout, so its gate holds ("hold") or passes. */
  const candidate = (cwd, text) => {
    const done = helpers.commitFile(box, cwd, 'web/snapshot.txt', `${text}\n`, `feat(web): ${text} candidate [G1]`);
    assert.equal(done.status, 0, done.stderr);
  };
  return { ...box, helpers, boardFile, release, started, item, state, driver, seat, candidate };
}

/**
 * Run `work` on the project's board file and close it.
 *
 * @template T
 * @param {string} boardFile
 * @param {(board: any) => T} work
 * @returns {T}
 */
export function onBoard(boardFile, work) {
  return withFixtureBoard(boardFile, work);
}
