/**
 * `pullboard tour` (N10): the method in thirty seconds, on a throwaway repo. A coordinator and two
 * scripted agents run real pullboard and git commands: a builder submits work that misses an edge,
 * a second agent finds it and rejects, and the rework is accepted and landed by the lander. No model runs and nothing leaves
 * the machine; the repo stays behind to look around in.
 */
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import {
  chmodSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  basename,
  join,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { slowestSteps } from '../logic/tour-steps.js';
import { typed } from '../logic/tour-steps.js';
import { CHECKOUT_SESSION_TOKEN_ENV } from '../../../../packages/seats/index.js';
import { displayAgentName } from '../../../../packages/seats/index.js';
import { scratchFolder } from '../../../../packages/config/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { AGENT_SHELL_MARKERS } from '../../../../packages/kernel/index.js';
import { AGENT_SESSION_IDS } from '../../../../packages/kernel/index.js';
import {
  forgetProject,
  listProjects,
  registerProject,
} from '../../../../packages/seats/index.js';

/**
 * The caller's agent-session identity and checkout lease. A scripted seat must never inherit them: a seat that did
 * would be recorded under the caller's session, and its verify would then be refused as self-verification (#952).
 */
const CALLER_SESSION_NAMES = new Set([...AGENT_SHELL_MARKERS, ...AGENT_SESSION_IDS, CHECKOUT_SESSION_TOKEN_ENV]);

const BIN = fileURLToPath(new URL('../../pullboard.js', import.meta.url));

const SPEC = `# Greeter

## G · Goals
- G1 [approved, must] \`greet(name)\` returns "Hello, <name>!"; a blank name greets the world: "Hello, world!". | gate: src/greet.test.mjs
`;

const CONFIG = {
  name: 'demo',
  project: 'Pullboard tour demo',
  gate: 'node --test',
  affectedTests: 'node --test',
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
 * @returns {Promise<number>}
 */
export async function tour(io) {
  const color = colorEnabled(io);
  const pace = io.stdout.isTTY ? 1 : 0;
  const dir = realpathSync(scratchFolder('pullboard-tour-'));
  const shims = join(dir, '.bin');
  mkdirSync(shims);
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(shims, 'pullboard'), 0o755);
  // Nothing of the person's git setup reaches the tour: no config files, and no GIT_ variable, such
  // as GIT_DIR from a hook or GIT_CONFIG_COUNT pairs, which git reads as config too. The caller's agent session
  // stays out as well, so each seat is judged as its own session below (#952).
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') && name !== 'NODE_TEST_CONTEXT' && !CALLER_SESSION_NAMES.has(name)));
  Object.assign(env, { PATH: `${shims}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PULLBOARD_HOME: join(dir, '.pullboard'), PULLBOARD_MACHINE_HOME: join(dir, '.pullboard-machine') });
  const repo = join(dir, 'greeter');
  const app = `${repo}-app-1`;
  const review = `${repo}-review-1`;
  const where = { coordinator: repo, 'app-1': app, 'review-1': review };
  /**
   * The agent session a scripted seat runs as (#952). Each seat has its own session identifier, derived from this
   * run's unique folder, so the builder and the reviewer are two sessions and neither is the caller's.
   *
   * @param {string} who
   * @returns {Record<string, string>}
   */
  const seatSession = (who) => ({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: `${basename(dir)}-${who}` });
  const timings = [];

  /** The environment one scripted seat runs with. */
  const seatEnv = (who, nested) => ({ ...env, ...seatSession(who), ...(nested ? { PULLBOARD_TEXT_NEXT: '0' } : {}), GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who}@tour.invalid`, GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: `${who}@tour.invalid` });

  /**
   * Show one finished command and the lines of its output worth reading; stop the tour when it did not do what the script expects.
   */
  const report = (label, file, args, result, started, { show, fails, tone }) => {
    timings.push({ label: label || `${file} ${typed(args)}`, ms: performance.now() - started });
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

  /**
   * Run one command as an agent, show it and the lines of its output worth reading.
   * A real process, for git and node: the hooks and the test runner are what the tour shows running.
   */
  const run = (who, file, args, { label = `${file} ${typed(args)}`, show = /./, fails = false, tone } = {}) => {
    pause(400 * pace);
    if (label) io.say(`   ${paint(displayAgentName({ agent_id: who, agent_model: who === 'coordinator' ? null : 'Scripted' }), PROMPT_COLOR[who], color)} $ ${label}`);
    const started = performance.now();
    const result = spawnSync(file, args, { cwd: where[who], encoding: 'utf8', env: seatEnv(who, false) });
    return report(label, file, args, result, started, { show, fails, tone });
  };
  /**
   * Run one pullboard command as an agent, in this process: the same dispatch a typed command takes, without a
   * node start for each of the dozen steps (N10). The seat's environment replaces this process's for the one call,
   * and the steps run one after another, so nothing else reads it meanwhile.
   */
  const pb = async (who, args, { label = `pullboard ${typed(args)}`, show = /./, fails = false, tone } = {}) => {
    pause(400 * pace);
    if (label) io.say(`   ${paint(displayAgentName({ agent_id: who, agent_model: who === 'coordinator' ? null : 'Scripted' }), PROMPT_COLOR[who], color)} $ ${label}`);
    const started = performance.now();
    const saved = { ...process.env };
    const exitCode = process.exitCode;
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, seatEnv(who, true));
    let stdout = '';
    let stderr = '';
    let status;
    try {
      status = await io.runCommand(args, {
        cwd: where[who],
        stdin: Readable.from(['']),
        stdout: { isTTY: false, write(text) { stdout += String(text); return true; } },
        stderr: { isTTY: false, write(text) { stderr += String(text); return true; } },
      });
    } finally {
      for (const name of Object.keys(process.env)) delete process.env[name];
      Object.assign(process.env, saved);
      process.exitCode = exitCode;
    }
    return report(label, process.execPath, [BIN, ...args], { status, stdout, stderr }, started, { show, fails, tone });
  };
  /**
   * Submit and return the short sha its green gate ran at: printed at once by a gate run here, or read from the item
   * once this machine's runner settles a pulled gate, the default (#6265).
   */
  const gated = async (who, args) => {
    const now = /^submitted .* at ([0-9a-f]{12})/mu.exec(await pb(who, args, { show: /^submitted/ }));
    if (now) return now[1];
    const head = run(who, 'git', ['rev-parse', 'HEAD'], { label: '', show: null }).slice(0, 12);
    for (const until = Date.now() + 120_000; Date.now() < until; await new Promise((done) => setTimeout(done, 250))) {
      const shown = await pb(who, ['show', args[1]], { label: '', show: null });
      if (new RegExp(`Gate job \\S+ (?:green|red only on main's own cases) at ${head}`, 'u').test(shown)) { io.say(`       submitted #${args[1]} at ${head}; its gate ran on this machine's runner`); return head; }
      if (new RegExp(`Gate job \\S+ (?:red|passed but not submitted) at ${head}`, 'u').test(shown)) throw new TourStopped(`the gate of #${args[1]} went red\n${shown}`);
    }
    throw new TourStopped(`the gate of #${args[1]} did not settle in two minutes; pullboard runner local shows this machine's runner`);
  };
  /**
   * Wait for the land job the accept offered to merge the item onto main: this machine's runner takes it, as any
   * board's does, and the item records merged. Why: the tour shows the real landing path, never a hand merge (#7750).
   */
  const landed = async (who, id) => {
    for (const until = Date.now() + 120_000; Date.now() < until; await new Promise((done) => setTimeout(done, 250))) {
      const shown = await pb(who, ['show', id], { label: '', show: null });
      if (/^progress: landed/mu.test(shown)) { io.say(`       #${id} landed on main by the land job`); return; }
    }
    throw new TourStopped(`the land job for #${id} did not land it in two minutes; pullboard runner local shows this machine's runner`);
  };
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
    await pb('coordinator', ['init'], { label: '', show: null });
    write('coordinator', { 'pullboard.json': `${JSON.stringify(CONFIG, null, 2)}\n`, 'SPEC.md': SPEC });
    run('coordinator', 'git', ['add', '-A'], { label: '' });
    // The first commit is hidden and no step shows its hook, so plumbing writes it and the hook's seconds are not spent here.
    const tree = run('coordinator', 'git', ['write-tree'], { label: '', show: null });
    const root = run('coordinator', 'git', ['commit-tree', tree, '-m', 'chore: the greeter, on pullboard'], { label: '', show: null });
    run('coordinator', 'git', ['update-ref', 'HEAD', root], { label: '', show: null });

    step(1, 'The person approved one spec row. The coordinator files it as work.');
    io.say('   G1: greet(name) returns "Hello, <name>!"; a blank name greets the world: "Hello, world!"');
    await pb('coordinator', ['add', 'app', 'Greeting', '--specs', 'G1', '--criterion', 'greet() meets G1']);

    step(2, 'A builder agent gets its own worktree in the app lane and claims the next item. Its criterion freezes.');
    await pb('coordinator', ['worktree', 'app', '--model', 'Scripted'], { show: /^made /, label: 'pullboard worktree app --model Scripted' });
    await pb('app-1', ['next'], { show: /^claimed|^criterion/ });

    step(3, 'It writes greet(), tests the happy path and submits. Its own gate is green.');
    write('app-1', { 'src/greet.mjs': FIRST, 'src/greet.test.mjs': TEST });
    run('app-1', 'git', ['add', '-A'], { label: '' });
    run('app-1', 'git', ['commit', '-q', '-m', 'feat(app): greet by name [G1]']);
    const first = await gated('app-1', ['submit', '1']);

    step(4, 'A second agent checks out exactly that commit and tries the edge the builder skipped.');
    await pb('coordinator', ['worktree', 'review', '--model', 'Scripted'], { show: /^made /, label: 'pullboard worktree review --model Scripted' });
    run('review-1', 'git', ['switch', '-q', '--detach', first]);
    await pb('review-1', ['next', '--verify', '1'], { show: /^next to verify/ });
    const edge = run('review-1', process.execPath, TRY_EDGE, { label: "node -e \"greet('')\"" });
    await pb('review-1', ['verify', '1', 'reject', '--reason', 'BEHAVIOR_MISMATCH', '--clause', 'a blank name greets the world', '--note', `greet('') returns "${edge}"; G1 says a blank name greets the world`], { tone: 'red' });

    step(5, "The builder's next session starts from the board, not from memory.");
    await pb('app-1', ['resume'], { show: /^sent back|^next/ });

    step(6, 'It fixes the edge, adds a test that pins it, and submits a new commit.');
    await pb('app-1', ['claim', '1'], { show: /^claimed/ });
    write('app-1', { 'src/greet.mjs': FIXED, 'src/greet.test.mjs': EDGE_TEST });
    run('app-1', 'git', ['commit', '-q', '-am', 'fix(app): a blank name greets the world [G1]']);
    // The fix edits a test that existed at the claim, so the submit says why (#814).
    const second = await gated('app-1', ['submit', '1', '--infra', 'pins the blank-name edge the verifier found']);

    step(7, 'The verifier breaks the fix on purpose, to prove the new test can fail, then restores it and accepts.');
    run('review-1', 'git', ['switch', '-q', '--detach', second]);
    await pb('review-1', ['next', '--verify', '1'], { show: /^next to verify/ });
    write('review-1', { 'src/greet.mjs': FIRST });
    // Pin the summary we display: Node 24 defaults to the spec reporter even through a pipe.
    run('review-1', process.execPath, ['--test', '--test-reporter=tap'], { label: 'node --test   # with the fix removed', show: /^# (pass|fail)/, fails: true, tone: 'red' });
    run('review-1', 'git', ['checkout', '--', 'src/greet.mjs']);
    if (color) run('review-1', process.execPath, ['--test', '--test-reporter=tap'], { label: 'node --test   # after restoring the fix', show: /^# (pass|fail)/, tone: 'green' });
    await pb('review-1', ['verify', '1', 'accept', '--note', 'removed the blank-name fix: its new test failed; restored, both pass'], { show: /^verified/, tone: 'green' });

    step(8, 'The lander lands it: a land job merges it onto main. The ledger is the receipt.');
    await landed('coordinator', '1');
    await pb('coordinator', ['ledger'], { show: /^\| (#|1 )|verified by a second agent/ });
    // A pulled gate started this machine's local runner for the demo; it stops with the tour.
    await pb('coordinator', ['runner', 'local', '--off'], { label: '', show: null });
  } catch (error) {
    if (!(error instanceof TourStopped)) throw error;
    io.say(`\nThe tour stopped: ${error.message.trimEnd()}`);
    io.say(`The repo is at ${repo}`);
    io.err(slowestSteps(timings));
    return 1;
  }
  // One demo stays in the list: each run replaces the last tour demo, and listProjects drops any whose folder is gone.
  // The demo is registered locally only, never linked to the relay, even when relay on --all is set (#951).
  for (const entry of listProjects()) if (entry.project === CONFIG.project && entry.root !== repo) forgetProject(entry.root);
  registerProject(repo, new Date(), loadConfig(repo));
  io.say('\nNothing shipped until a second agent verified it.');
  io.say(`Look around: cd ${repo} && pullboard log`);
  io.say('see it: pullboard view');
  io.err(slowestSteps(timings));
  return 0;
}
