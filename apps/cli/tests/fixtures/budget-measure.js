/** Shared by the inbox budget and growth journeys: a seeded board and each command's default output size [C7,N26]. */
/** @pullboard-world-pin: the growth check extracts merge-base main and links this checkout's node_modules into it. */
import { existsSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { outputBudget } from '../../../../packages/config/index.js';
import { COMMANDS } from '../../index.js';
import { FIXTURE_MODEL } from './child.js';
import { privateFixtureFiles } from './child.js';
import { runFixtureChildAsync } from './child.js';

/**
 * `pullboard waits` text without its orphan rows. Orphans are machine-wide (every /tmp/pullboard-* process whose parent
 * is gone), so other runs' leftovers would inflate the size of a table the fixture's own board did not make. The summary
 * line is recounted for the rows removed.
 *
 * @param {string} text
 * @returns {string}
 */
export function withoutOrphanRows(text) {
  const kept = [];
  let removed = 0, removedOver = 0, skipping = false;
  for (const line of text.split('\n')) {
    if (/^(?:OVER|DEAD|ok {2}) {2}orphan /u.test(line)) { skipping = true; removed += 1; if (line.startsWith('OVER')) removedOver += 1; continue; }
    if (skipping && /^ {8}\S/u.test(line)) continue;
    skipping = false;
    const summary = /^(\d+) waits; (\d+) over budget(.*)$/u.exec(line);
    kept.push(summary ? `${Number(summary[1]) - removed} waits; ${Number(summary[2]) - removedOver} over budget${summary[3]}` : line);
  }
  return kept.join('\n');
}

/**
 * The seeded-board helpers bound to one e2e helper set.
 *
 * @param {{ sandbox: Function, project: Function }} helpers
 */
export function createBudgetMeasure(helpers) {
  /** Give the real project seat the model required by the current join contract. */
  function outputBudgetProject() {
    const box = helpers.sandbox();
    box.env.PULLBOARD_MODEL = FIXTURE_MODEL;
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
    log: 'prints every event row by row, unbounded by design (#9058), so a large board never builds one string',
  });

  /** Commands whose text reads machine-wide state, which an in-process call does not isolate the way a real process does. */
  const REAL_PROCESS = new Set(['waits']);

  /** The bytes a command's stdout adds to a reader's context; the waits table leaves out other runs' orphan processes. */
  const sizeOfText = (command, text) => Buffer.byteLength(command === 'waits' ? withoutOrphanRows(text ?? '') : text ?? '');

  const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

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
    if (extract.status !== 0 || !existsSync(join(dir, 'apps/cli/pullboard.js'))) throw new Error(`could not extract merge-base main: ${extract.stderr}`);
    if (existsSync(join(ROOT, 'node_modules'))) symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    return dir;
  }

  /**
   * Each measured command's default text in UTF-8 bytes, run through one CLI entrypoint against one board. This checkout's
   * own entry runs in this process (no node start-up per command) except machine-state readers; another checkout's entry, such
   * as merge-base main, is a real process, a few at a time [C7].
   *
   * @param {{ repo: string, env: object, runIn?: Function }} box
   * @param {string} bin
   * @returns {Promise<Record<string, number>>}
   */
  async function measure(box, bin) {
    const sizes = {};
    const commands = Object.keys(COMMANDS).filter(name => !Object.hasOwn(EXCLUDED, name));
    /** A refusal still prints its default text; only stdout lands in a reader's context as output. */
    const sizeOf = async command => {
      const args = [command, ...(DEFAULT_ARGS[command] ?? [])];
      if (!REAL_PROCESS.has(command) && bin === helpers.BIN && box.runIn) {
        const result = await box.runIn(box.repo, ...args);
        sizes[command] = sizeOfText(command, result.stdout);
        return;
      }
      const pending = runFixtureChildAsync(process.execPath, [bin, ...args], { cwd: box.repo, env: box.env });
      const timer = setTimeout(() => pending.child.kill('SIGKILL'), 20_000);
      const result = await pending;
      clearTimeout(timer);
      sizes[command] = result.signal ? Infinity : sizeOfText(command, result.stdout);
    };
    const queue = [...commands];
    const lanes = bin === helpers.BIN && box.runIn ? 1 : 6;
    await Promise.all(Array.from({ length: lanes }, async () => { for (let command = queue.shift(); command; command = queue.shift()) await sizeOf(command); }));
    return Object.fromEntries(commands.map(command => [command, sizes[command]]));
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
  return { outputBudgetProject, measure, mainTree, ratchetProblems, seeded };
}
