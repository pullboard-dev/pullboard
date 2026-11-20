/**
 * A scratch Pullboard project whose submits queue to the real gate dispatcher [C7]: a real repository with an origin
 * to land to, a real board, one builder seat in the web lane, and items whose check can hold until released.
 *
 * Why its own module: the end-to-end harness and the repro harnesses all need the same queued-gate project, and none
 * may touch the main checkout, so the project is built once here inside an e2e sandbox the kit watches.
 */
/** @pullboard-module-loads apps/cli/tests/fixtures/e2e.js packages/board/tests/fixtures/board.js packages/gate/tests/fixtures/testkit.js packages/store/index.js */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ROOT,
  track,
} from './kit.js';

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
 * The project builder for one Pullboard tree: its CLI, fixtures, board all come from `root`.
 * Why a root: the stale-tooling repro runs a whole project from a scratch copy of Pullboard whose HEAD it can move.
 *
 * @param {string} root - A Pullboard source tree.
 * @returns {Promise<{ handoffProject: (options?: { handoffWorkers?: number }) => object }>}
 */
export async function projectKit(root) {
  const load = path => import(pathToFileURL(join(root, path)).href);
  const { createE2eHelpers } = await load('apps/cli/tests/fixtures/e2e.js');
  const { fixtureAdd, createFixtureWorktree, fixtureCommittedPolicy, fixtureMachineSettings } = await load('packages/gate/tests/fixtures/testkit.js');
  const { withFixtureBoard } = await load('packages/board/tests/fixtures/board.js');
  const store = await load('packages/store/index.js');

  /**
   * Build the project. Its gate check holds while the candidate's web/snapshot.txt says "hold" and the release file
   * is missing, writing the started file first, so a harness can catch a gate mid-run.
   *
   * @param {{ handoffWorkers?: number, resident?: boolean }} [options] - `handoffWorkers` sets the machine's worker cap;
   *   `resident` lets commands use the resident board process, as an agent's commands do, retiring it 3 s after the
   *   last command so it never outlives the harness.
   * @returns {object} The e2e box plus boardFile, release, started, item(), state(), seat() and candidate().
   */
  function handoffProject({ handoffWorkers, resident = false } = {}) {
    const helpers = createE2eHelpers();
    const isolated = helpers.sandbox();
    track(isolated.dir);
    for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete isolated.env[key];
    isolated.env.PULLBOARD_RESIDENT = resident ? '1' : '0';
    if (resident) isolated.env.PULLBOARD_RESIDENT_IDLE_MS = '3000';
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
    /** Run `work` on the project's board file and close it. */
    const onBoard = work => withFixtureBoard(boardFile, work);
    /** File one web item whose check is the holding gate, and return its id. */
    const item = (title = 'Hop harness item') => {
      const id = json(fixtureAdd(box.run, box.repo, 'web', title, '--route', 'strong', '--specs', 'G1',
        '--criterion', 'The hop harness candidate passes its check.', '--check', check, '--wait', '--json')).item.item_id;
      json(box.run(box.repo, 'fact', String(id), 'diagnosis',
        'Files: web/snapshot.txt Change: write the snapshot the hop harness holds on Test case: the queued gate finishes green', '--json'));
      return id;
    };
    /** Read the item and its current submit hand-off from the board, writing nothing. */
    const state = id => onBoard(board => ({ item: store.getItem(board, id), job: store.submitHandoff(board, id) }));
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
    return { ...box, helpers, boardFile, release, started, item, state, seat, candidate };
  }
  return { handoffProject };
}

/** The project builder for the tree under test. */
export const { handoffProject } = await projectKit(ROOT);
