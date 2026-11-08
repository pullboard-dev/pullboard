/** Every command's default text fits a declared budget, and a ratchet keeps measured sizes from growing [C7,N26]. */
/** @pullboard-world-pin: clause 2 asserts the committed byte baseline file is absent from the repository. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { openBoard } from '../apps/lib/index.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { DEFAULT_OUTPUT_BUDGET, LINE_BUDGET, commandName, commandOutput, cutLine, outputBudget } from '../packages/config/index.js';
import { COMMANDS } from '../apps/cli/index.js';
import { privateFixtureFiles, runFixtureChild } from './fixture-child.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Give the real project seat the model required by the current join contract. */
function outputBudgetProject() {
  const box = helpers.sandbox();
  box.env.PULLBOARD_MODEL = 'Output budget fixture';
  return helpers.project('true', box);
}

/** Arguments a reader passes by default; every other command runs bare. */
const DEFAULT_ARGS = { list: ['web'], show: ['1'], log: [], why: ['1'] };

/**
 * Commands never run here, each with why: they stream until stopped, or they act (land, push, run work, change
 * machine state) when run bare. Every other command is measured; a command in neither set fails the ratchet.
 */
const EXCLUDED = Object.freeze({
  view: 'serves until stopped', watch: 'streams until stopped', serve: 'serves until stopped', relay: 'links a relay',
  mcp: 'serves MCP on stdio until stopped', hook: 'is a git hook entry that reads its hook arguments', loop: 'loops until stopped',
  ship: 'commits staged work, merges main, runs checks and submits while waiting for a verdict',
  land: 'lands accepted work', publish: 'pushes to the remote', sync: 'syncs with the remote', runner: 'registers runners',
  test: 'runs the test suite', check: 'runs an item check', gate: 'runs the gate', run: 'runs a command',
  sweep: 'releases and reopens board work', init: 'initializes a repository', takeover: 'takes over the coordinator seat',
  worktree: 'creates a worktree', heartbeat: 'records presence', tour: 'is an interactive walkthrough', help: 'is the reference page',
  export: 'prints the whole board as a data document meant for a file, never for an agent context',
});

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * A scratch checkout of merge-base main, or null when main is absent. Its node_modules links to this checkout's.
 *
 * @returns {string | null}
 */
function mainTree() {
  const base = spawnSync('git', ['merge-base', 'HEAD', 'main'], { cwd: ROOT, encoding: 'utf8' });
  if (base.status !== 0) return null;
  const dir = privateFixtureFiles('pullboard-budget-main-').root;
  // Stream the archive into tar: a whole checkout overflows spawnSync's default output buffer.
  const extract = spawnSync('sh', ['-c', 'set -o pipefail 2>/dev/null; git archive "$0" | tar -x -C "$1"', base.stdout.trim(), dir], { cwd: ROOT, encoding: 'utf8' });
  if (extract.status !== 0 || !existsSync(join(dir, 'bin/pullboard.js'))) throw new Error(`could not extract merge-base main: ${extract.stderr}`);
  if (existsSync(join(ROOT, 'node_modules'))) symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

/**
 * Each measured command's default text in UTF-8 bytes, run through one CLI entrypoint against one board.
 *
 * @param {{ repo: string, env: object }} box
 * @param {string} bin
 * @returns {Record<string, number>}
 */
function measure(box, bin) {
  const sizes = {};
  for (const command of Object.keys(COMMANDS).filter(name => !Object.hasOwn(EXCLUDED, name))) {
    // A refusal still prints its default text; only stdout lands in a reader's context as output.
    const result = runFixtureChild(process.execPath, [bin, command, ...(DEFAULT_ARGS[command] ?? [])],
      { cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 20_000 });
    sizes[command] = result.signal ? Infinity : Buffer.byteLength(result.stdout ?? '');
  }
  return sizes;
}

/**
 * Name every command that grew past its size on merge-base main, or whose declared budget is exceeded. A command
 * main does not have passes the growth check; the tolerance is zero, as the committed ratchet was.
 *
 * @param {Record<string, number>} measured sizes at HEAD
 * @param {Record<string, number>} mainSizes sizes at merge-base main
 * @returns {string[]}
 */
function ratchetProblems(measured, mainSizes) {
  const problems = [];
  for (const [command, bytes] of Object.entries(measured)) {
    if (Object.hasOwn(mainSizes, command) && bytes > mainSizes[command]) problems.push(`${command}: ${bytes} bytes, over its main size of ${mainSizes[command]}`);
    if (bytes > outputBudget(command)) problems.push(`${command}: ${bytes} bytes, over its declared budget of ${outputBudget(command)}`);
  }
  return problems;
}

/** A real project whose board holds hundreds of long items and shouts, so unbounded reads would overflow. */
function seeded() {
  const box = outputBudgetProject();
  // @pullboard-board-file journey: the real CLI subprocesses read this seeded project board.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    for (let index = 0; index < 300; index += 1) {
      store.addItem(board, { by: 'coordinator', lane: 'web', title: `Seeded budget item ${index} ${'with a long readable title '.repeat(3)}`,
        criterion: 'The seeded behaviour is observable [test]', specIds: ['G1'] });
    }
    for (let index = 0; index < 200; index += 1) store.shout(board, { from: 'coordinator', to: 'web-1', text: `Seeded note ${index} ${'x'.repeat(120)}`, lanes: ['web'] });
  } finally { store.closeBoard(board); }
  return box;
}

test('clause 1: every measured command prints within its main size and declared budget on a seeded board [C7,N26]', () => {
  const box = seeded();
  const headSizes = measure(box, helpers.BIN);
  const main = mainTree();
  try {
    const mainSizes = main ? measure(box, join(main, 'bin/pullboard.js')) : {};
    assert.deepEqual(ratchetProblems(headSizes, mainSizes), [], JSON.stringify(headSizes));
  } finally {
    if (main) rmSync(main, { recursive: true, force: true });
  }
  const full = box.run(box.repo, 'list', 'web', '--detail');
  assert.ok(Buffer.byteLength(full.out) > DEFAULT_OUTPUT_BUDGET, '--detail still prints every row');
  const bounded = box.run(box.repo, 'list', 'web');
  assert.match(bounded.out, /more lines withheld to keep this output within 8192 bytes; add --detail for all of it, or --json/u);
  assert.equal(JSON.parse(box.run(box.repo, 'list', 'web', '--json').out).items.length, 300, '--json is never trimmed by the text budget');
});

test('a long withheld next step is cut to one line and the whole output stays within the budget [C7,N26]', () => {
  let printed = '';
  const io = commandOutput(['blueprint'], { stdout: { write: text => { printed += text; } }, stderr: { write() {} } }, { refusalDocument: () => ({}) });
  for (let index = 0; index < 200; index += 1) io.say(`draft row ${index} ${'x'.repeat(80)}`);
  io.say('next: ' + Array.from({ length: 130 }, (_, index) => `src/very/long/path/file-${index}.js`).join(' '));
  io.flush(0);
  assert.ok(Buffer.byteLength(printed) <= DEFAULT_OUTPUT_BUDGET, `${Buffer.byteLength(printed)} bytes`);
  const lines = printed.trimEnd().split('\n');
  assert.match(lines.at(-1), /^next: src\/very\/long\/path\/file-0\.js .*--detail shows the whole line\)$/u, 'the next step survives, cut to one line');
  assert.match(lines.at(-2), /more lines withheld/u);
});

test('a command over its baseline or its budget fails the ratchet naming it [C7]', () => {
  assert.deepEqual(ratchetProblems({ list: 5000 }, { list: 4000 }), ['list: 5000 bytes, over its main size of 4000']);
  assert.deepEqual(ratchetProblems({ queue: 9000 }, { queue: 9000 }), ['queue: 9000 bytes, over its declared budget of 8192']);
  assert.deepEqual(ratchetProblems({ newcomer: 10 }, {}), [], 'a command main lacks passes the growth check');
});

test('clause 2: the committed byte baseline is deleted and nothing reads it [C7]', () => {
  assert.equal(existsSync(new URL('./output-budget-' + 'baseline.json', import.meta.url)), false, 'the JSON baseline is gone');
});

test('streams and reference pages are declared unbounded, and a single long line is cut with a pointer [C7]', () => {
  for (const command of ['view', 'watch', 'help']) assert.equal(outputBudget(command), Infinity);
  assert.equal(outputBudget('list'), DEFAULT_OUTPUT_BUDGET);
  assert.equal(commandName(['--json', 'stats', '--window', '24h']), 'stats');
  const cut = cutLine('agents: ' + 'a'.repeat(5000));
  assert.ok(Buffer.byteLength(cut) <= LINE_BUDGET);
  assert.match(cut, /--detail shows the whole line\)$/u);
  assert.equal(cutLine('short'), 'short');
});

test('inbox after a read shows nothing old: a delivered interrupt comes back only as its id [N26,R2]', () => {
  const box = outputBudgetProject();
  // @pullboard-board-file journey: the real CLI subprocesses read this answered decision as an interrupt.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const question = store.shout(board, { from: 'web-1', to: 'coordinator', text: 'Which path?', decision: true, lanes: ['web'] });
    store.answerDecision(board, question, { agentId: 'coordinator', text: 'Use the reviewed path', lanes: ['web'] });
  } finally { store.closeBoard(board); }
  const first = box.run(box.web, 'inbox');
  assert.match(first.out, /Use the reviewed path/u, 'the first read delivers the answer');
  const second = box.run(box.web, 'inbox');
  assert.doesNotMatch(second.out, /Use the reviewed path|Which path\?/u, 'the second read replays nothing old');
  assert.match(second.out, /1 delivered interrupt still unacted: event:\d+; clear with pullboard inbox --acted-on <ids>/u);
  const id = JSON.parse(box.run(box.web, 'inbox', '--json').out).activity.pending[0];
  assert.equal(box.run(box.web, 'inbox', '--acted-on', id).code, 0);
  assert.match(box.run(box.web, 'inbox').out, /no new shouts or activity/u, 'acting on it clears the reminder');
});
