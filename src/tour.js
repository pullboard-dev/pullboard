/**
 * `pullboard tour` (N10): the method in thirty seconds, on a throwaway repo. A coordinator and two
 * scripted agents run real pullboard and git commands: a builder submits work that misses an edge,
 * a second agent finds it and rejects, and the rework is accepted. No model runs and nothing leaves
 * the machine; the repo stays behind to look around in.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/pullboard.js', import.meta.url));

const SPEC = `# Greeter

## G · Goals
- G1 [approved, must] \`greet(name)\` returns "Hello, <name>!"; a blank name greets the world: "Hello, world!". | gate: src/greet.test.mjs
`;

const CONFIG = {
  gate: 'node --test',
  spec: 'SPEC.md',
  verify: { policy: 'any', family: 'off' },
  lease: '2h',
  lanes: { app: { owns: ['src/'], specs: ['G'] }, review: { owns: [] } },
  shared: [],
};

const FIRST = 'export const greet = (name) => `Hello, ${name}!`;\n';
const FIXED = "export const greet = (name) => `Hello, ${name.trim() || 'world'}!`;\n";
const TEST = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { greet } from './greet.mjs';

test('greets by name [G1]', () => assert.equal(greet('Ada'), 'Hello, Ada!'));
`;
const EDGE_TEST = `${TEST}test('a blank name greets the world [G1]', () => assert.equal(greet(' '), 'Hello, world!'));\n`;
const TRY_EDGE = ['--input-type=module', '-e', "const { greet } = await import('./src/greet.mjs'); console.log(greet(''))"];
const PROMPT_COLOR = { coordinator: 36, 'app-1': 33, 'review-1': 35 };

/** Whether this person asked for terminal colors, unless NO_COLOR explicitly disables them. */
function colorEnabled(io) {
  return process.env.NO_COLOR === undefined && (Boolean(io.stdout.isTTY) || Boolean(process.env.FORCE_COLOR));
}

/** Wrap text in one plain ANSI style only when terminal styling is enabled. */
function paint(text, code, enabled) {
  return enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

/**
 * Arguments as a person would type them.
 *
 * @param {string[]} args
 * @returns {string}
 */
const typed = (args) => args.map((arg) => (/[\s"'$|()]/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');

/**
 * A step that did not do what the script expects, with what it printed.
 */
class TourStopped extends Error {}

/**
 * Block for a moment, so a person can read along.
 *
 * @param {number} ms
 */
function pause(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run the tour. Pauses only when a person is watching a terminal.
 *
 * @param {{ say: (line: string) => void, stdout: any }} io
 * @returns {number}
 */
export function tour(io) {
  const color = colorEnabled(io);
  const pace = io.stdout.isTTY ? 1 : 0;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-tour-')));
  const shims = join(dir, '.bin');
  mkdirSync(shims);
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(shims, 'pullboard'), 0o755);
  // Nothing of the person's git setup reaches the tour: no config files, and no GIT_ variable, such
  // as GIT_DIR from a hook or GIT_CONFIG_COUNT pairs, which git reads as config too.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') && name !== 'NODE_TEST_CONTEXT'));
  Object.assign(env, { PATH: `${shims}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PULLBOARD_HOME: join(dir, '.pullboard') });
  const repo = join(dir, 'greeter');
  const app = `${repo}-app-1`;
  const review = `${repo}-review-1`;
  const where = { coordinator: repo, 'app-1': app, 'review-1': review };

  /**
   * Run one command as an agent, show it and the lines of its output worth reading.
   */
  const run = (who, file, args, { label = `${file} ${typed(args)}`, show = /./, fails = false, tone } = {}) => {
    pause(400 * pace);
    if (label) io.say(`   ${paint(who, PROMPT_COLOR[who], color)} $ ${label}`);
    const result = spawnSync(file, args, {
      cwd: where[who],
      encoding: 'utf8',
      env: { ...env, GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who}@tour.invalid`, GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: `${who}@tour.invalid` },
    });
    if ((result.status === 0) === fails) {
      const said = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}`;
      throw new TourStopped(`${label || `${file} ${typed(args)}`} ${fails ? 'passed, and should have failed' : `exited ${result.status}`}\n${said}`);
    }
    for (const line of result.stdout.split('\n').filter((text) => text && show?.test(text))) {
      const output = `       ${line.replaceAll(`${dir}/`, '')}`;
      io.say(tone === 'red' ? paint(output, 31, color) : tone === 'green' ? paint(output, 32, color) : output);
    }
    return result.stdout.trim();
  };
  const pb = (who, args, options) => run(who, process.execPath, [BIN, ...args], { label: `pullboard ${typed(args)}`, ...options });
  const write = (who, files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(where[who], path, '..'), { recursive: true });
      writeFileSync(join(where[who], path), text);
    }
  };
  const step = (n, text) => {
    pause(1200 * pace);
    io.say(`\n${paint(`${n}  ${text}`, 1, color)}`);
  };

  io.say('pullboard tour: a coordinator and two scripted agents run real commands on a throwaway repo. No model runs.');
  try {
    mkdirSync(repo);
    run('coordinator', 'git', ['init', '-q', '-b', 'main'], { label: '' });
    pb('coordinator', ['init'], { label: '', show: null });
    write('coordinator', { 'pullboard.json': `${JSON.stringify(CONFIG, null, 2)}\n`, 'SPEC.md': SPEC });
    run('coordinator', 'git', ['add', '-A'], { label: '' });
    run('coordinator', 'git', ['commit', '-q', '-m', 'chore: the greeter, on pullboard'], { label: '' });

    step(1, 'The person approved one spec row. The coordinator files it as work.');
    io.say('   G1: greet(name) returns "Hello, <name>!"; a blank name greets the world: "Hello, world!"');
    pb('coordinator', ['add', 'app', 'Greeting', '--specs', 'G1', '--criterion', 'greet() meets G1']);

    step(2, 'A builder agent gets its own worktree in the app lane and claims the next item. Its criterion freezes.');
    pb('coordinator', ['worktree', 'app'], { show: /^made /, label: 'pullboard worktree app' });
    pb('app-1', ['next'], { show: /^claimed|^criterion/ });

    step(3, 'It writes greet(), tests the happy path and submits. Its own gate is green.');
    write('app-1', { 'src/greet.mjs': FIRST, 'src/greet.test.mjs': TEST });
    run('app-1', 'git', ['add', '-A'], { label: '' });
    run('app-1', 'git', ['commit', '-q', '-m', 'feat(app): greet by name [G1]']);
    const first = pb('app-1', ['submit', '1'], { show: /^submitted/ }).match(/at ([0-9a-f]{12})/)[1];

    step(4, 'A second agent checks out exactly that commit and tries the edge the builder skipped.');
    pb('coordinator', ['worktree', 'review'], { show: /^made /, label: 'pullboard worktree review' });
    run('review-1', 'git', ['switch', '-q', '--detach', first]);
    const edge = run('review-1', process.execPath, TRY_EDGE, { label: "node -e \"greet('')\"" });
    pb('review-1', ['verify', '1', 'reject', '--reason', 'BEHAVIOR_MISMATCH', '--note', `greet('') returns "${edge}"; G1 says a blank name greets the world`], { tone: 'red' });

    step(5, "The builder's next session starts from the board, not from memory.");
    pb('app-1', ['resume'], { show: /^sent back|^next/ });

    step(6, 'It fixes the edge, adds a test that pins it, and submits a new commit.');
    pb('app-1', ['claim', '1'], { show: /^claimed/ });
    write('app-1', { 'src/greet.mjs': FIXED, 'src/greet.test.mjs': EDGE_TEST });
    run('app-1', 'git', ['commit', '-q', '-am', 'fix(app): a blank name greets the world [G1]']);
    const second = pb('app-1', ['submit', '1'], { show: /^submitted/ }).match(/at ([0-9a-f]{12})/)[1];

    step(7, 'The verifier breaks the fix on purpose, to prove the new test can fail, then restores it and accepts.');
    run('review-1', 'git', ['switch', '-q', '--detach', second]);
    write('review-1', { 'src/greet.mjs': FIRST });
    // Pin the summary we display: Node 24 defaults to the spec reporter even through a pipe.
    run('review-1', process.execPath, ['--test', '--test-reporter=tap'], { label: 'node --test   # with the fix removed', show: /^# (pass|fail)/, fails: true, tone: 'red' });
    run('review-1', 'git', ['checkout', '--', 'src/greet.mjs']);
    if (color) run('review-1', process.execPath, ['--test', '--test-reporter=tap'], { label: 'node --test   # after restoring the fix', show: /^# (pass|fail)/, tone: 'green' });
    pb('review-1', ['verify', '1', 'accept', '--note', 'removed the blank-name fix: its new test failed; restored, both pass'], { show: /^verified/, tone: 'green' });

    step(8, 'The coordinator merges it. The ledger is the receipt.');
    run('coordinator', 'git', ['merge', '-q', '--ff-only', 'app/1']);
    pb('coordinator', ['merged', '1', second]);
    pb('coordinator', ['ledger'], { show: /^\| (#|1 )|verified by a second agent/ });
  } catch (error) {
    if (!(error instanceof TourStopped)) throw error;
    io.say(`\nThe tour stopped: ${error.message.trimEnd()}`);
    io.say(`The repo is at ${repo}`);
    return 1;
  }
  io.say('\nNothing shipped until a second agent verified it.');
  io.say(`Look around: cd ${repo} && pullboard log`);
  return 0;
}
