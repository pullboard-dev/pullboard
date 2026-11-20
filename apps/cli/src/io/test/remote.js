/**
 * `pullboard test <files>` for a seat whose board lives on another host: with board.url set, the named files run here
 * at the committed head and the run's receipt reaches the served board as a fact move on the seat's claim; no
 * board.sqlite opens on this machine [P7].
 * Why: the board host never runs a seat's tests on its request path; it records one small fact, so nothing slow
 * waits on the API.
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { Refused } from '../../../../../packages/kernel/light.js';
import { loadConfig } from '../../../../../packages/config/index.js';
import { boardPath } from '../remote/board.js';
import { reportRemoteRefusal } from '../remote/board.js';
import { requestJson } from '../remote/board.js';
import { seatAgent } from '../remote/board.js';
import { seatKey } from '../remote/board.js';
import { seatRoute } from '../remote/board.js';

// Budget: one fact move runs one small CLI write on the board host.
const FACT_TIMEOUT_MS = 30_000;
// Lines of a red run's output the seat sees; the whole output stays in its own terminal scrollback.
const TAIL_LINES = 40;

/** Quote one word for the shell that runs affectedTests. */
function shellWord(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`;
}

/** The checkout's root and committed head. */
function checkout(cwd) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  return { root: git('rev-parse', '--show-toplevel'), head: git('rev-parse', 'HEAD') };
}

/**
 * Run affectedTests on the named files in the checkout and resolve its exit code and output, never throwing on red.
 * @param {string} root
 * @param {string} command
 * @param {string[]} files
 * @returns {Promise<{ code: number, output: string }>}
 */
function runFiles(root, command, files) {
  // A parent node --test's context would make a node --test child report to it and exit 0 on red.
  const { NODE_TEST_CONTEXT: _parent, ...env } = process.env;
  return new Promise((resolve) => {
    const child = spawn(`${command.trimEnd()} ${files.map((file) => shellWord('./' + file)).join(' ')}`, { cwd: root, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (part) => { output += part; });
    child.stderr.on('data', (part) => { output += part; });
    child.once('error', (error) => resolve({ code: 127, output: output + String(error.message) }));
    child.once('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), output }));
  });
}

/**
 * The seat's one claimed item on the served board, or a refusal: a receipt belongs to exactly one claim.
 * Read from the seat's own agent route, never the board state.
 * @param {{ url: string, token: string }} remote
 * @param {string} agent
 */
async function claimedItem(remote, agent) {
  const { claimed = [] } = await seatRoute(remote, agent);
  if (claimed.length !== 1) {
    throw new Refused('TEST_NO_CLAIM', `${agent} holds ${claimed.length} claims on the board at board.url; a test receipt records on exactly one; claim one with pullboard claim <id>, or run pullboard next`);
  }
  return claimed[0];
}

/** One receipt line for the board: result, files, head, host and time, readable in show's thread. */
export function receiptText({ green, files, head, host, seconds, code }) {
  return `test receipt: ${green ? 'green' : 'red'} pullboard test run of ${files.join(' ')} at ${head} on ${host} in ${seconds}s (exit ${code})`;
}

/**
 * Run the named files here and post their receipt to the seat's claim on the served board; 0 when every file passes.
 * @param {any} io
 * @param {string[]} files
 * @param {Record<string, unknown>} values
 * @param {{ url: string, token: string }} remote
 */
export async function runRemoteTest(io, files, values, remote) {
  let code;
  try {
    if (values.status !== undefined || values.affected === true || values['compare-main'] === true || values.diagnose === true) {
      throw new Refused('USAGE', 'with board.url set, pullboard test runs named files here and records the receipt; drop --status, --affected, --compare-main and --diagnose');
    }
    if (!files.length) throw new Refused('USAGE', 'name the test files to run: pullboard test <file> [more files]');
    const { root, head } = checkout(io.cwd);
    const missing = files.filter((file) => !existsSync(join(root, file)));
    if (missing.length) throw new Refused('NO_TEST_FILE', `no such test file in this checkout: ${missing.join(', ')}`);
    const command = loadConfig(root).affectedTests;
    if (typeof command !== 'string' || !command.trim()) {
      throw new Refused('NO_TEST_RUNNER', 'set "affectedTests" in pullboard.json to the command that runs named test files, like "node apps/cli/src/io/run/tests.js"');
    }
    const agent = seatAgent(io.cwd);
    if (!agent) throw new Refused('NO_AGENT', 'this seat has no agent name; run pullboard join <lane> with board.url set, or set PULLBOARD_AGENT');
    const path = await boardPath(remote);
    const item = await claimedItem(remote, agent);
    const started = Date.now();
    const ran = await runFiles(root, command, files);
    const green = ran.code === 0;
    const text = receiptText({ green, files, head, host: hostname(), seconds: Math.round((Date.now() - started) / 100) / 10, code: ran.code });
    // The receipt is a move as the seat, so it carries the seat's own key [P7,#10790].
    await requestJson({ ...remote, seatKey: seatKey(io.cwd, agent) }, `${path}/moves`, { verb: 'fact', item, args: { kind: 'note', text }, agent }, FACT_TIMEOUT_MS);
    const board = new URL(remote.url).origin;
    io.result?.({ green, item, files, head, receipt: text, board });
    if (!green) io.say(ran.output.trimEnd().split('\n').slice(-TAIL_LINES).join('\n'));
    io.say(`${text}; recorded on #${item} via ${board}`);
    code = green ? 0 : 1;
  } catch (error) {
    return reportRemoteRefusal(io, error);
  }
  const status = io.exitCode(code);
  io.flush(status);
  return status;
}
